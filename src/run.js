// Entry point: run the next few searches from the Supabase table `searches`, save new jobs to the DB.
// Usage: node src/run.js                     → premium searches that are due, plus the `searchesPerRun`
//                                              rotating searches that ran longest ago (all of them if it's `all`)
//        node src/run.js [search-name ...]   → just these searches
//        node src/run.js all                 → every active search
// Glassdoor salaries are a separate job: src/salaries.js (workflow salaries.yml).
import { appendFileSync } from 'node:fs';
import { loadConfig, requireEnv } from './config.js';
import { openDb } from './db.js';
import { runSearch, normalizeJob, passesFilters, fetchLinkedinCompany } from './scrape.js';
import { apifyCredit } from './credit.js';
import { tagJob } from './tags.js';

// In GitHub Actions, errors are also emitted as annotations so they show at the top of the run page.
function reportError(message) {
    console.error(`  ✖ ${message}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error::${message.replace(/\r?\n/g, '%0A')}`);
}

function fatal(message) {
    reportError(message);
    process.exit(1);
}

let config, store;
const only = process.argv.slice(2).flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
try {
    config = loadConfig();
    requireEnv('DATABASE_URL');
} catch (err) {
    fatal(err.message);
}
try {
    store = await openDb();
} catch (err) {
    fatal(`Could not connect to the database: ${err.message}`);
}

const all = only.length === 1 && only[0] === 'all';
await store.syncPremiumSearches(config.premium);
const rows = await store.pickSearches({ names: all ? [] : only, all, limit: config.searchesPerRun === 'all' ? null : config.searchesPerRun });
const missing = all ? [] : only.filter((name) => !rows.some((r) => r.name === name));
if (missing.length || rows.length === 0) {
    const known = await store.allSearchNames();
    await store.close();
    fatal(missing.length
        ? `No search named ${missing.join(', ')}. Known: ${known.join(', ') || 'none'}`
        : 'No active searches. Add one with: node src/searches.js add <name> --keywords "..."');
}
// A search's own input wins over config `defaults`.
const searches = rows.map((r) => ({ ...r, input: { ...config.defaults, ...r.input } }));
console.log(`Running ${searches.length} search(es): ${searches.map((s) => s.name).join(', ')}`);

const credit = await apifyCredit(store, config.minRemainingUsd);
if (credit.count === 0) {
    await store.close();
    fatal('No Apify token: set the APIFY_TOKEN secret or add one with node src/tokens.js add <token>');
}
const { withCredit, noCreditError } = credit;
const tokenLabel = () => credit.current()?.label;
const results = [];

for (const search of searches) {
    const runId = await store.startRun(search.name, config.actor);
    console.log(`▶ ${search.name}: running ${config.actor} …`);

    try {
        const outcome = await withCredit((client) => runSearch(client, config.actor, search, config.timeoutSecs));
        if (outcome.noCredit) {
            // Not marked as run, so the search stays at the front of the rotation for when credit is back.
            const error = noCreditError();
            await store.finishRun(runId, { status: 'FAILED', error });
            results.push({ search: search.name, ok: false, error });
            reportError(`${search.name}: ${error}`);
            continue;
        }
        const { items, runId: apifyRunId, costUsd } = outcome.result;

        const jobs = items
            .map((item) => normalizeJob(item, { source: config.source, search }))
            .filter(Boolean);
        const kept = jobs.filter((job) => passesFilters(job, config.filters));
        const added = await store.saveJobs(kept);
        const skipped = items.length - kept.length;

        await store.markSearch(search.name, 'SUCCEEDED');
        await store.finishRun(runId, {
            status: 'SUCCEEDED', apify_run_id: apifyRunId, apify_token: tokenLabel(), items_found: items.length,
            items_new: added, items_skipped: skipped, cost_usd: costUsd,
        });
        results.push({ search: search.name, ok: true, found: items.length, added, skipped, costUsd: costUsd ?? 0 });
        console.log(`  ✔ ${items.length} found, ${added} new, ${kept.length - added} already in DB, ${skipped} filtered` +
            (costUsd != null ? `, $${costUsd.toFixed(4)}` : '') + ` [token: ${tokenLabel()}]`);
    } catch (err) {
        await store.markSearch(search.name, 'FAILED', err.message);
        await store.finishRun(runId, { status: 'FAILED', apify_run_id: err.runId ?? null, apify_token: tokenLabel(), error: err.message });
        results.push({ search: search.name, ok: false, error: err.message });
        reportError(`${search.name}: ${err.message}`);
    }
}

const linked = await store.linkCompanies();
console.log(`Linked ${linked} job(s) to companies`);

// Role, level and tech tags from each new job's title and description (keyword rules, no AI). The first run
// after this was added also tags every older job, 500 at a time.
let tagged = 0;
for (let batch; tagged < 20000 && (batch = await store.untaggedJobs(500)).length;) {
    await store.saveTags(batch.map((j) => ({ source: j.source, job_id: j.job_id, ...tagJob(j) })));
    tagged += batch.length;
}
console.log(`Tagged ${tagged} job(s)`);

// Premium companies without a LinkedIn ID: read it from their LinkedIn page, so the next run searches them.
const lookups = await store.companiesToHydrate(config.premium.lookupsPerRun);
for (const { slug, linkedin_slug: page } of lookups) {
    try {
        const outcome = await withCredit((client) => fetchLinkedinCompany(client, page));
        if (outcome.noCredit) break;
        await store.saveLinkedinPage(slug, outcome.result);
        console.log(`  ⓘ ${slug}: LinkedIn ID ${outcome.result.linkedinId ?? 'not found'} (linkedin.com/company/${page})`);
    } catch (err) {
        console.warn(`  ! ${slug}: couldn't read linkedin.com/company/${page}: ${err.message}`);
    }
}
if (lookups.length) await store.syncPremiumSearches(config.premium);

await credit.finish();
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
