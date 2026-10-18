// After each scrape: labels new jobs with a role, skills and minimum years of experience using a free LLM
// (src/classify-ai.js). Only jobs without labels are sent, newest first, at most classify.jobsPerRun per run;
// the rest wait for the next run. Rate limits never fail the run: unlabeled jobs are simply tried again.
// Usage: node src/classify.js   (needs DATABASE_URL and at least one of GEMINI_API_KEY / GROQ_API_KEY /
// OPENROUTER_API_KEY; skips itself without a key)
import { appendFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { availableProviders, classifyBatch } from './classify-ai.js';

const MAX_ATTEMPTS = 3;   // a job the models keep failing on is left alone after this many tries

const config = loadConfig().classify;
const providers = availableProviders(config.providers);
if (!config.jobsPerRun || !providers.length) {
    console.log(config.jobsPerRun ? 'No AI API key set (GEMINI_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY), skipping classification'
        : 'classify.jobsPerRun is 0, skipping classification');
    process.exit(0);
}

const store = await openDb();
const { rows: jobs } = await store.query(
    `SELECT source, job_id, title, seniority, description FROM jobs
     WHERE ai_classified_at IS NULL AND ai_attempts < $1 AND status <> 'skipped'
       AND first_seen_at > now() - interval '30 days'
     ORDER BY first_seen_at DESC LIMIT $2`, [MAX_ATTEMPTS, config.jobsPerRun]);

const state = { skipped: new Set(), errors: [] };
let labeled = 0;
const used = new Map();
for (let i = 0; i < jobs.length && state.skipped.size < providers.length; i += config.batchSize) {
    const batch = jobs.slice(i, i + config.batchSize);
    const { labels, model } = await classifyBatch(batch, providers, state, { descriptionChars: config.descriptionChars });
    if (!model) {
        // Every provider failed for this batch; only count it against the jobs when a model did answer.
        if (state.skipped.size < providers.length) await bumpAttempts(batch);
        continue;
    }
    used.set(model, (used.get(model) ?? 0) + labels.size);
    for (const [index, l] of labels) {
        const j = batch[index];
        await store.query(
            `UPDATE jobs SET ai_role = $3, ai_skills = $4, ai_min_years = $5, ai_model = $6, ai_classified_at = now()
             WHERE source = $1 AND job_id = $2`, [j.source, j.job_id, l.role, l.skills, l.minYears, model]);
        labeled++;
    }
    await bumpAttempts(batch.filter((_, index) => !labels.has(index)));
}

async function bumpAttempts(list) {
    if (!list.length) return;
    await store.query(
        `UPDATE jobs SET ai_attempts = ai_attempts + 1
         WHERE (source, job_id) IN (SELECT unnest($1::text[]), unnest($2::text[]))`,
        [list.map((j) => j.source), list.map((j) => j.job_id)]);
}

const { rows: [{ n: waiting }] } = await store.query(
    `SELECT COUNT(*)::int AS n FROM jobs WHERE ai_classified_at IS NULL AND ai_attempts < $1 AND status <> 'skipped'
       AND first_seen_at > now() - interval '30 days'`, [MAX_ATTEMPTS]);
await store.close();

const summary = `AI labels: ${labeled} of ${jobs.length} job(s) labeled` +
    (used.size ? ` (${[...used].map(([m, n]) => `${m} ${n}`).join(', ')})` : '') +
    `, ${waiting} still waiting` +
    (state.skipped.size ? `. Out for this run: ${[...state.skipped].join(', ')}` : '');
console.log(summary);
for (const e of new Set(state.errors)) console.log(`  ${e}`);
if (state.skipped.size === providers.length) console.log('::warning::Every AI provider was rate limited or failed; unlabeled jobs will be retried next run');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
