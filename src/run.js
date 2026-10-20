// Entry point: run the next few searches from the Supabase table `searches`, save new jobs to the DB.
// Usage: node src/run.js                     → premium searches that are due, plus the `searchesPerRun`
//                                              rotating searches that ran longest ago (all of them if it's `all`)
//        node src/run.js [search-name ...]   → just these searches
//        node src/run.js all                 → every active search
//        node src/run.js none                → no searches, only the steps after them (company IDs, salaries)
// SALARIES=all fetches salaries for every company that's due, not only premium ones and ones with recent
// jobs; SALARIES=<n> fetches up to n. Blank uses salaries.companiesPerRun.
import { appendFileSync } from 'node:fs';
import { loadConfig, requireEnv } from './config.js';
import { openDb } from './db.js';
import { createClient, runSearch, normalizeJob, passesFilters, fetchLinkedinCompany, fetchSalaries, salaryRows } from './scrape.js';
import { loadTokens, checkToken, nextUsableToken } from './tokens.js';
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
const none = only.length === 1 && only[0] === 'none';
await store.syncPremiumSearches(config.premium);
const rows = none ? [] : await store.pickSearches({ names: all ? [] : only, all, limit: config.searchesPerRun === 'all' ? null : config.searchesPerRun });
const missing = all || none ? [] : only.filter((name) => !rows.some((r) => r.name === name));
if (missing.length || (rows.length === 0 && !none)) {
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

/**
 * Runs fn(client) with a token that has credit. When a run fails and the token turns out to be out of credit,
 * switches to the next token and runs fn again. Returns { result }, or { noCredit: true } when no token has
 * credit left; other errors are thrown.
 */
async function withCredit(fn) {
    while (true) {
        if (!(await pickToken())) return { noCredit: true };
        try {
            return { result: await fn(createClient(token.token)) };
        } catch (err) {
            await checkToken(store, token);
            if (token.remaining_usd == null || token.remaining_usd < config.minRemainingUsd) continue;
            throw err;
        }
    }
}
const noCreditError = () => `No Apify token has at least $${config.minRemainingUsd} left this month`;
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
            status: 'SUCCEEDED', apify_run_id: apifyRunId, apify_token: token.label, items_found: items.length,
            items_new: added, items_skipped: skipped, cost_usd: costUsd,
        });
        results.push({ search: search.name, ok: true, found: items.length, added, skipped, costUsd: costUsd ?? 0 });
        console.log(`  ✔ ${items.length} found, ${added} new, ${kept.length - added} already in DB, ${skipped} filtered` +
            (costUsd != null ? `, $${costUsd.toFixed(4)}` : '') + ` [token: ${token.label}]`);
    } catch (err) {
        await store.markSearch(search.name, 'FAILED', err.message);
        await store.finishRun(runId, { status: 'FAILED', apify_run_id: err.runId ?? null, apify_token: token.label, error: err.message });
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

// Glassdoor salaries for companies never fetched or due a refresh (cached for salaries.refreshDays).
const sal = config.salaries;
const salaryMode = (process.env.SALARIES ?? '').trim();
const salaryLimit = salaryMode === 'all' ? null : Number(salaryMode || sal.companiesPerRun);
const salaryCompanies = salaryLimit === null || salaryLimit > 0
    ? await store.companiesForSalaries(salaryLimit, sal.refreshDays, { everyCompany: salaryMode === 'all' }) : [];
const salaryResults = [];
let salaryCost = 0;
if (salaryCompanies.length) console.log(`Salaries: ${salaryCompanies.map((c) => c.slug).join(', ')}`);
for (const company of salaryCompanies) {
    // Every role each time: the Actor bills per salary found, so roles Glassdoor doesn't have cost nothing.
    const roles = sal.roles;
    const runId = await store.startRun(`salaries:${company.slug}`, sal.actor);
    try {
        const outcome = await withCredit((client) => fetchSalaries(client, sal.actor,
            { company: company.name, roles, location: sal.location, locationType: sal.locationType }, config.timeoutSecs));
        if (outcome.noCredit) {
            // The company isn't marked as fetched, so it's first in line next time.
            await store.finishRun(runId, { status: 'FAILED', error: noCreditError() });
            console.warn(`  ! salaries: ${noCreditError()}`);
            break;
        }
        const { items, runId: apifyRunId, costUsd } = outcome.result;
        salaryCost += costUsd ?? 0;
        const rows = salaryRows(items, await store.fxRates([...new Set(items.map((i) => i.currency).filter(Boolean))]));
        const status = await store.saveSalaries(company.slug,
            { rows, glassdoorName: items[0]?.company_name ?? null, rating: items[0]?.company_rating ?? null });
        await store.finishRun(runId, {
            status: 'SUCCEEDED', apify_run_id: apifyRunId, apify_token: token.label, items_found: items.length,
            items_new: status === 'ok' ? rows.length : 0, items_skipped: items.length - (status === 'ok' ? rows.length : 0), cost_usd: costUsd,
        });
        salaryResults.push(`| ${company.slug} | ${status} | ${status === 'ok' ? rows.length : 0} | $${(costUsd ?? 0).toFixed(4)} |`);
        console.log(`  $ ${company.slug}: ${status === 'ok' ? `${rows.length} role(s)` : status === 'mismatch'
            ? `skipped, Glassdoor matched "${items[0]?.company_name}"` : 'no salaries on Glassdoor'} ` +
            `(${roles.length} asked${costUsd != null ? `, $${costUsd.toFixed(4)}` : ''})`);
    } catch (err) {
        // "Invalid input: Glassdoor has no company matching '…'": an answer, not a failure, so it's cached too.
        const notFound = /Glassdoor has no company matching/i.test(err.message);
        await store.saveSalaries(company.slug, notFound ? { notFound: err.message } : { error: err.message });
        if (notFound) {
            await store.finishRun(runId, { status: 'SUCCEEDED', apify_run_id: err.runId ?? null, apify_token: token?.label, items_found: 0 });
            salaryResults.push(`| ${company.slug} | not on Glassdoor | 0 | |`);
            console.log(`  $ ${company.slug}: not on Glassdoor`);
            continue;
        }
        salaryResults.push(`| ${company.slug} | ❌ ${err.message} | | |`);
        await store.finishRun(runId, { status: 'FAILED', apify_run_id: err.runId ?? null, apify_token: token?.label, error: err.message });
        console.warn(`  ! salaries for ${company.slug}: ${err.message}`);
    }
}

// Save the latest remaining credit of the token we ended on.
if (token) await checkToken(store, token);
await store.close();

const ok = results.filter((r) => r.ok);
const sum = (key) => ok.reduce((n, r) => n + r[key], 0);
const failed = results.length - ok.length;
console.log(`\nDone: ${sum('found')} found, ${sum('added')} new, ${sum('skipped')} filtered, ` +
    `~$${sum('costUsd').toFixed(4)} Apify cost` + (failed ? `, ${failed} search(es) failed` : '') +
    (salaryCompanies.length ? `; salaries for ${salaryCompanies.length} company(ies), ~$${salaryCost.toFixed(4)}` : ''));

// In GitHub Actions, also show a results table on the run's summary page.
if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => r.ok
        ? `| ${r.search} | ✅ | ${r.found} | ${r.added} | ${r.skipped} | $${r.costUsd.toFixed(4)} |`
        : `| ${r.search} | ❌ ${r.error} | | | | |`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
        '### Scrape results', '',
        '| Search | Status | Found | New | Filtered | Cost |', '|---|---|---|---|---|---|',
        ...rows, '',
        ...(salaryResults.length ? ['### Glassdoor salaries', '', '| Company | Status | Roles | Cost |', '|---|---|---|---|', ...salaryResults,
            `| **Total** | | | $${salaryCost.toFixed(4)} |`, ''] : []),
    ].join('\n'));
}

process.exit(failed ? 1 : 0);
