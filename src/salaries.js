// Glassdoor salaries per role for companies that have none yet. Companies with salaries are left alone, unless
// REFRESH=yes, which also re-fetches the ones older than salaries.refreshDays. (A single company can be queued
// again with: node src/companies.js refresh-salaries <slug>.)
// Separate from the job scrape (src/run.js), so each can be started on its own (workflow salaries.yml, from n8n).
// Usage: node src/salaries.js          → up to salaries.companiesPerRun companies (premium and recent-job ones first)
//        node src/salaries.js <n>      → up to n companies
//        node src/salaries.js all      → every company that's due, also ones with no recent jobs
// SALARIES=<n|all> works too. It stops when no Apify token has credit left; the rest are first in line next time.
import { appendFileSync } from 'node:fs';
import { loadConfig, requireEnv } from './config.js';
import { openDb } from './db.js';
import { fetchSalaries, salaryRows } from './scrape.js';
import { apifyCredit } from './credit.js';

function fatal(message) {
    console.error(`  ✖ ${message}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error::${message.replace(/\r?\n/g, '%0A')}`);
    process.exit(1);
}

let config, store;
try {
    config = loadConfig();
    requireEnv('DATABASE_URL');
    store = await openDb();
} catch (err) {
    fatal(err.message);
}
const salaryMode = (process.argv[2] || process.env.SALARIES || '').trim();
if (salaryMode && salaryMode !== 'all' && !(Number.isInteger(Number(salaryMode)) && Number(salaryMode) >= 0)) {
    await store.close();
    fatal(`Salaries: give a number of companies or all, not "${salaryMode}"`);
}
const credit = await apifyCredit(store, config.minRemainingUsd);
if (credit.count === 0) {
    await store.close();
    fatal('No Apify token: set the APIFY_TOKEN secret or add one with node src/tokens.js add <token>');
}
const { withCredit, noCreditError } = credit;
const tokenLabel = () => credit.current()?.label;

const sal = config.salaries;
const salaryLimit = salaryMode === 'all' ? null : Number(salaryMode || sal.companiesPerRun);
const refresh = /^(yes|true|1)$/i.test(process.env.REFRESH ?? '');
const salaryCompanies = salaryLimit === null || salaryLimit > 0
    ? await store.companiesForSalaries(salaryLimit, sal.refreshDays, { everyCompany: salaryMode === 'all', refresh }) : [];
console.log(refresh ? `Missing salaries, plus ones older than ${sal.refreshDays} days` : 'Only companies without salaries');
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
            status: 'SUCCEEDED', apify_run_id: apifyRunId, apify_token: tokenLabel(), items_found: items.length,
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
            await store.finishRun(runId, { status: 'SUCCEEDED', apify_run_id: err.runId ?? null, apify_token: tokenLabel(), items_found: 0 });
            salaryResults.push(`| ${company.slug} | not on Glassdoor | 0 | |`);
            console.log(`  $ ${company.slug}: not on Glassdoor`);
            continue;
        }
        salaryResults.push(`| ${company.slug} | ❌ ${err.message} | | |`);
        await store.finishRun(runId, { status: 'FAILED', apify_run_id: err.runId ?? null, apify_token: tokenLabel(), error: err.message });
        console.warn(`  ! salaries for ${company.slug}: ${err.message}`);
    }
}

await credit.finish();
await store.close();
console.log(salaryCompanies.length
    ? `\nDone: salaries for ${salaryCompanies.length} company(ies), ~$${salaryCost.toFixed(4)} Apify cost`
    : `\nDone: no company ${refresh ? 'is due for' : 'is missing'} salaries`);

// In GitHub Actions, also show a results table on the run's summary page.
if (process.env.GITHUB_STEP_SUMMARY && salaryResults.length) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['### Glassdoor salaries', '', '| Company | Status | Roles | Cost |', '|---|---|---|---|',
        ...salaryResults, `| **Total** | | | $${salaryCost.toFixed(4)} |`, ''].join('\n'));
}
