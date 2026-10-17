// Entry point: run every configured search, save new jobs to the DB.
// Usage: node src/run.js [search-name ...]   (no names = run all searches)
import { appendFileSync } from 'node:fs';
import { loadConfig, requireEnv } from './config.js';
import { openDb } from './db.js';
import { createClient, runSearch, normalizeJob, passesFilters } from './scrape.js';

const config = loadConfig();
const only = process.argv.slice(2).flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
const searches = only.length ? config.searches.filter((s) => only.includes(s.name)) : config.searches;
if (searches.length === 0) {
    console.error(`No search matches ${only.join(', ')}. Known: ${config.searches.map((s) => s.name).join(', ')}`);
    process.exit(1);
}

const client = createClient(requireEnv('APIFY_TOKEN'));
const store = await openDb();
const results = [];

for (const search of searches) {
    const runId = await store.startRun(search.name, config.actor);
    console.log(`▶ ${search.name}: running ${config.actor} …`);

    try {
        const { items, runId: apifyRunId, costUsd } = await runSearch(client, config.actor, search, config.timeoutSecs);

        const jobs = items
            .map((item) => normalizeJob(item, { source: config.source, searchName: search.name }))
            .filter(Boolean);
        const kept = jobs.filter((job) => passesFilters(job, config.filters));
        const added = await store.saveJobs(kept);
        const skipped = items.length - kept.length;

        await store.finishRun(runId, {
            status: 'SUCCEEDED', apify_run_id: apifyRunId, items_found: items.length,
            items_new: added, items_skipped: skipped, cost_usd: costUsd,
        });
        results.push({ search: search.name, ok: true, found: items.length, added, skipped, costUsd: costUsd ?? 0 });
        console.log(`  ✔ ${items.length} found, ${added} new, ${kept.length - added} already in DB, ${skipped} filtered` +
            (costUsd != null ? `, $${costUsd.toFixed(4)}` : ''));
    } catch (err) {
        await store.finishRun(runId, { status: 'FAILED', apify_run_id: err.runId ?? null, error: err.message });
        results.push({ search: search.name, ok: false, error: err.message });
        console.error(`  ✖ ${err.message}`);
    }
}

await store.close();

const ok = results.filter((r) => r.ok);
const sum = (key) => ok.reduce((n, r) => n + r[key], 0);
const failed = results.length - ok.length;
console.log(`\nDone: ${sum('found')} found, ${sum('added')} new, ${sum('skipped')} filtered, ` +
    `~$${sum('costUsd').toFixed(4)} Apify cost` + (failed ? `, ${failed} search(es) failed` : ''));

// In GitHub Actions, also show a results table on the run's summary page.
if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => r.ok
        ? `| ${r.search} | ✅ | ${r.found} | ${r.added} | ${r.skipped} | $${r.costUsd.toFixed(4)} |`
        : `| ${r.search} | ❌ ${r.error} | | | | |`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
        '### Scrape results', '',
        '| Search | Status | Found | New | Filtered | Cost |', '|---|---|---|---|---|---|',
        ...rows, '',
    ].join('\n'));
}

process.exit(failed ? 1 : 0);
