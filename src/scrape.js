import { ApifyClient } from 'apify-client';

/**
 * Runs the Actor for one search, waits for it to finish and returns its items
 * along with run metadata. Throws if the run does not succeed.
 */
export async function runSearch(client, actor, search, timeoutSecs) {
    const run = await client.actor(actor).call(search.input, { waitSecs: timeoutSecs });

    if (run.status !== 'SUCCEEDED') {
        throw Object.assign(new Error(`Actor run ${run.id} ended with status ${run.status}`), { runId: run.id });
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems({ clean: true });
    return { items, runId: run.id, costUsd: run.usageTotalUsd ?? null };
}

/**
 * Reads a public LinkedIn company page (apify/web-fetch, about $0.0015) for the company's numeric ID, which
 * LinkedIn puts in the page's links, and its employee count. Either is null when not found.
 */
export async function fetchLinkedinCompany(client, linkedinSlug) {
    const run = await client.actor('apify/web-fetch').call(
        { url: `https://www.linkedin.com/company/${encodeURIComponent(linkedinSlug)}`, formats: ['links'] }, { waitSecs: 120 });
    if (run.status !== 'SUCCEEDED') throw new Error(`web-fetch run ${run.id} ended with status ${run.status}`);
    const { items: [page] } = await client.dataset(run.defaultDatasetId).listItems({ clean: true });
    // Job links carry f_C=<id>; pages without jobs still have the employee search link, facetCurrentCompany=[<id>]
    // (URL-encoded twice).
    const links = (page?.links ?? []).map((l) => { try { return decodeURIComponent(decodeURIComponent(l)); } catch { return l; } });
    // Some companies list several IDs (their affiliates), e.g. Razorpay's f_C=2770855,13616753,3788927; keep them all.
    const linkedinId = [/[?&]f_C=(\d+(?:,\d+)*)/, /facetCurrentCompany=\[(\d+(?:,\+?\d+)*)\]/]
        .map((re) => links.map((l) => re.exec(l)?.[1]).find(Boolean)).find(Boolean)?.replace(/\+/g, '') ?? null;
    const employees = /"numberOfEmployees":\{[^}]*"value":"?(\d+)/.exec(JSON.stringify(page?.metadata?.jsonLd ?? null))?.[1];
    return { linkedinId, employees: employees ? Number(employees) : null, costUsd: run.usageTotalUsd ?? null };
}

/**
 * Runs the Glassdoor salary Actor (axlymxp/glassdoor-salary-scraper) for one company and these roles. Takes
 * only the first row per role: Glassdoor's main estimate for that title at that employer (the rows after it
 * are narrower groups, such as interns or contractors).
 */
export async function fetchSalaries(client, actor, { company, roles, location, locationType }, timeoutSecs) {
    const run = await client.actor(actor).call(
        { queries: roles, searchBy: 'title', company, location, locationType, maxResultsPerQuery: 1, pageSize: 1 },
        { waitSecs: timeoutSecs, memory: 512 });   // the start fee is per GB of memory
    if (run.status !== 'SUCCEEDED') {
        throw Object.assign(new Error(`Actor run ${run.id} ended with status ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ''}`),
            { runId: run.id });
    }
    const { items } = await client.dataset(run.defaultDatasetId).listItems({ clean: true });
    return { items, runId: run.id, costUsd: run.usageTotalUsd ?? null };
}

const PER_YEAR = { ANNUAL: 1, MONTHLY: 12 };

/**
 * Glassdoor rows → yearly total pay (10th percentile, median, 90th percentile) per job title, converted with
 * `usdPerUnit` (currency → USD per unit). Hourly and other rows are skipped: for salaried tech jobs in India
 * they come from a handful of odd reports.
 */
export function salaryRows(items, usdPerUnit) {
    const seen = new Set();
    return items.flatMap((i) => {
        const k = PER_YEAR[i.pay_period];
        const median = i.total_pay_median ?? i.base_pay_median ?? i.base_pay_mean;
        if (!k || !i.job_title || !i.currency || median == null || seen.has(i.job_title)) return [];
        seen.add(i.job_title);
        const round = (n) => (n == null ? null : Math.round(n * k));
        return [{
            title: i.job_title, query: i.query, currency: i.currency, payPeriod: i.pay_period,
            min: round(i.total_pay_p10 ?? i.base_pay_p10), median: round(median), max: round(i.total_pay_p90 ?? i.base_pay_p90),
            usdPerUnit: usdPerUnit.get(i.currency) ?? null, location: i.location_name ?? null,
        }];
    });
}

export function createClient(token) {
    return new ApifyClient({ token });
}

/**
 * Maps one Actor item to a DB row. Field names follow curious_coder/linkedin-jobs-scraper,
 * with fallbacks for common alternatives so other job Actors mostly work too.
 */
export function normalizeJob(item, { source, search }) {
    const pick = (...keys) => keys.map((k) => item[k]).find((v) => v !== undefined && v !== null && v !== '') ?? null;

    const stripQuery = (u) => (u ? u.split('?')[0] : null);
    const url = stripQuery(pick('link', 'jobUrl', 'url'));
    const jobId = pick('id', 'jobId') ?? url;
    if (!jobId) return null;

    const title = pick('title', 'jobTitle', 'positionName');
    const location = pick('location', 'jobLocation');

    return {
        source,
        job_id: String(jobId),
        title,
        company: pick('companyName', 'company'),
        company_url: stripQuery(pick('companyLinkedinUrl', 'companyUrl')),
        location,
        category: search.category ?? detectCategory(title),
        workplace: search.workplace ?? detectWorkplace(`${title ?? ''} ${location ?? ''}`),
        url,
        apply_url: pick('applyUrl'),
        posted_at: pick('postedAt', 'publishedAt', 'postingDateParsed'),
        employment_type: pick('employmentType', 'jobType', 'contractType'),
        seniority: pick('seniorityLevel', 'experienceLevel'),
        salary: pick('salary', 'salaryInfo'),
        description: cleanText(pick('descriptionText', 'description')),
        search_name: search.name,
        raw: item,
    };
}

/** For searches without a category (premium company searches): a category from the job title, or null. */
export function detectCategory(title) {
    const t = (title ?? '').toLowerCase();
    if (/\b(android|ios|mobile|flutter|react native|swift|kotlin)\b/.test(t)) return 'mobile';
    if (/full[\s-]?stack/.test(t)) return 'fullstack';
    if (/\b(front[\s-]?end|ui engineer|ui developer|react|angular|vue)\b/.test(t)) return 'frontend';
    if (/\b(back[\s-]?end|java|golang|node(\.?js)?|python|django|spring)\b|\.net\b|c#/.test(t)) return 'backend';
    return null;
}

/** Title/location only: descriptions mention "remote" too loosely to rely on. */
function detectWorkplace(text) {
    if (/\bremote\b|work from home|\bwfh\b/i.test(text)) return 'remote';
    if (/\bhybrid\b/i.test(text)) return 'hybrid';
    return null;
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/** Decodes the HTML entities LinkedIn leaves in descriptionText and tidies whitespace. */
function cleanText(text) {
    if (!text) return text;
    return text
        .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (_, name) => ENTITIES[name])
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function passesFilters(job, { excludeTitleWords, excludeCompanies }) {
    const title = (job.title ?? '').toLowerCase();
    const company = (job.company ?? '').toLowerCase();
    if (excludeTitleWords.some((w) => title.includes(w.toLowerCase()))) return false;
    if (excludeCompanies.some((c) => company === c.toLowerCase())) return false;
    return true;
}
