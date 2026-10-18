// Entry point: run the next few searches from the Supabase table `searches`, save new jobs to the DB.
// Usage: node src/run.js                     → the `searchesPerRun` searches that ran longest ago
//        node src/run.js [search-name ...]   → just these searches
//        node src/run.js all                 → every active search
import { appendFileSync } from 'node:fs';
import { loadConfig, requireEnv } from './config.js';
import { openDb } from './db.js';
import { createClient, runSearch, normalizeJob, passesFilters } from './scrape.js';
import { loadTokens, checkToken, nextUsableToken } from './tokens.js';

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
const rows = await store.pickSearches(all ? { limit: 10000 } : { names: only, limit: config.searchesPerRun });
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

const tokens = await loadTokens(store);
if (tokens.length === 0) {
    await store.close();
    fatal('No Apify token: set the APIFY_TOKEN secret or add one with node src/tokens.js add <token>');
}
const usedUp = new Set();
let token = null;

/** Keeps the current token while it has enough credit left, otherwise moves on to the next one. */
async function pickToken() {
    if (token) {
        await checkToken(store, token);
        if (token.remaining_usd != null && token.remaining_usd >= config.minRemainingUsd) return token;
        console.log(`  ↪ token "${token.label}" has ${token.remaining_usd == null ? 'an error' : `$${token.remaining_usd.toFixed(2)} left`}, switching`);
        usedUp.add(token);
    }
    token = await nextUsableToken(store, tokens, config.minRemainingUsd, usedUp);
    return token;
}
const results = [];

for (const search of searches) {
    const runId = await store.startRun(search.name, config.actor);
    console.log(`▶ ${search.name}: running ${config.actor} …`);

    // Retries the search on the next token when this one turns out to be out of credit.
    while (true) {
        if (!(await pickToken())) {
            // Not marked as run, so the search stays at the front of the rotation for when credit is back.
            const error = `No Apify token has at least $${config.minRemainingUsd} left this month`;
            await store.finishRun(runId, { status: 'FAILED', error });
            results.push({ search: search.name, ok: false, error });
            reportError(`${search.name}: ${error}`);
            break;
        }

        try {
            const { items, runId: apifyRunId, costUsd } = await runSearch(createClient(token.token), config.actor, search, config.timeoutSecs);

            const jobs = items
                .map((item) => normalizeJob(item, { source: config.source, search }))
                .filter(Boolean);
            const kept = jobs.filter((job) => passesFilters(job, config.filters));
            const added = await store.saveJobs(kept);
            const skipped = items.length - kept.length;

            await store.markSearch(search.name, 'SUCCEEDED');
            await store.finishRun(runId, {
                status: 'SUCCEEDED', apify_run_id: apifyRunId, apify_token: token.label, items_found: items.length,
                items_new: added, items_skipped: skipped, cost_usd: costUsd,
            });
            results.push({ search: search.name, ok: true, found: items.length, added, skipped, costUsd: costUsd ?? 0 });
            console.log(`  ✔ ${items.length} found, ${added} new, ${kept.length - added} already in DB, ${skipped} filtered` +
                (costUsd != null ? `, $${costUsd.toFixed(4)}` : '') + ` [token: ${token.label}]`);
            break;
        } catch (err) {
            // Out of credit: the next pickToken() switches to another token and the search runs again.
            await checkToken(store, token);
            if (token.remaining_usd == null || token.remaining_usd < config.minRemainingUsd) continue;

            await store.markSearch(search.name, 'FAILED', err.message);
            await store.finishRun(runId, { status: 'FAILED', apify_run_id: err.runId ?? null, apify_token: token.label, error: err.message });
            results.push({ search: search.name, ok: false, error: err.message });
            reportError(`${search.name}: ${err.message}`);
            break;
        }
    }
}

// Save the latest remaining credit of the token we ended on.
if (token) await checkToken(store, token);
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
