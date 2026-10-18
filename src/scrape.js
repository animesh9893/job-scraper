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
