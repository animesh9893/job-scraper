// After each scrape: splits the best new jobs (view post_candidates) between the people in config `linkedin`,
// writes one LinkedIn hiring-alert post for each (table posts, shown on the private page /posts.html), then
// pings each person's n8n (secret N8N_WEBHOOK_<ID>) so it emails the post for approval and publishes it.
// Usage: node src/linkedin-posts.js   (needs DATABASE_URL; without a person's webhook secret their post is only
// shown on the page)
import { pathToFileURL } from 'node:url';
import { payRoles } from '../web/pay-roles.js';

export { payRoles };

const MAX_CHARS = 3000;   // LinkedIn's limit for a post

/** Deals jobs (best first) out in turn, so each person gets an equally good, different set. */
export function splitJobs(jobs, people, perPost) {
    const out = new Map(people.map((p) => [p.id, []]));
    let i = 0;
    for (const job of jobs) {
        const open = people.filter((p) => out.get(p.id).length < perPost);
        if (!open.length) break;
        out.get(open[i++ % open.length].id).push(job);
    }
    return out;
}

// LinkedIn posts have no bold or italic, so, like LinkedIn formatters, we use Unicode's sans-serif bold and
// italic letters (𝗔 = A + 0x1D5D4 − 0x41). Other characters are kept as they are.
const STYLES = { bold: { A: 0x1d5d4, a: 0x1d5ee, 0: 0x1d7ec }, italic: { A: 0x1d608, a: 0x1d622 } };
function styled(text, style) {
    return String(text).replace(/[A-Za-z0-9]/g, (c) => {
        const first = /[A-Z]/.test(c) ? 'A' : /[a-z]/.test(c) ? 'a' : '0';
        const start = STYLES[style][first];
        return start ? String.fromCodePoint(start + c.charCodeAt(0) - first.charCodeAt(0)) : c;
    });
}
export const bold = (text) => styled(text, 'bold');
export const italic = (text) => styled(text, 'italic');

/** Turns bold and italic letters back into plain ones, so checks and searches see ordinary text. */
export function plain(text) {
    return [...String(text ?? '')].map((ch) => {
        const cp = ch.codePointAt(0);
        for (const [start, first, count] of [[0x1d5d4, 65, 26], [0x1d5ee, 97, 26], [0x1d7ec, 48, 10], [0x1d608, 65, 26], [0x1d622, 97, 26]]) {
            if (cp >= start && cp < start + count) return String.fromCharCode(first + cp - start);
        }
        return ch;
    }).join('');
}

// "Bengaluru, Karnataka, India" → "Bengaluru"; remote jobs say so.
function where({ location, workplace }) {
    const city = String(location ?? '').split(',')[0].trim();
    if (workplace === 'remote') return /remote/i.test(city) || !city ? 'Remote' : `${city} (Remote)`;
    return city;
}

// "Node.js" → "nodejs", "C++" → "cpp", "C#" → "csharp", "Machine Learning" → "machinelearning".
const hashtag = (tag) => tag.toLowerCase().replace(/\+\+/g, 'pp').replace(/#/g, 'sharp').replace(/[^a-z0-9]/g, '');

// Hashtags people follow for each role (src/tags.js ROLES).
const ROLE_TAGS = {
    backend: 'backenddeveloper', frontend: 'frontenddeveloper', fullstack: 'fullstackdeveloper', mobile: 'mobiledevelopment',
    data: 'dataengineering', ml: 'machinelearning', devops: 'devops', security: 'cybersecurity', qa: 'softwaretesting',
    design: 'uxdesign', product: 'productmanagement', manager: 'engineeringmanagement',
};

// The values most jobs share, most common first.
function mostCommon(values, n) {
    const counts = new Map();
    for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([v]) => v);
}

/** Hashtags for a post: the configured ones, then its jobs' roles, top tech and cities, up to max. */
export function postHashtags(jobs, hashtags = [], max = 10) {
    const remote = jobs.some((j) => j.workplace === 'remote');
    const cities = jobs.filter((j) => j.workplace !== 'remote').map((j) => where(j));
    return [...new Set([
        ...hashtags,
        ...mostCommon(jobs.map((j) => ROLE_TAGS[j.role]), 2),
        ...mostCommon(jobs.flatMap((j) => j.tags ?? []), 3).map(hashtag),
        ...mostCommon(cities, 2).map((c) => `${hashtag(c)}jobs`),
        ...(remote ? ['remotejobs'] : []),
    ].map(hashtag).filter(Boolean))].slice(0, max);
}

// 2450000 INR → "₹24L", 850000 → "₹8.5L"; 132000 USD → "$132k".
function money(amount, currency) {
    if (currency === 'INR') return `₹${amount >= 1e6 ? Math.round(amount / 1e5) : Math.round(amount / 1e4) / 10}L`;
    const k = `${Math.round(amount / 1000)}k`;
    return { USD: `$${k}`, EUR: `€${k}`, GBP: `£${k}` }[currency] ?? `${currency} ${k}`;
}

/**
 * The pay line for a job: the salary its listing shows, else the Glassdoor median for its role at its company
 * (rows from company_salaries: { company_slug, query, currency, median }), else null.
 */
export function payFor(job, salaries = []) {
    // A plain string, or a list stored as text ('["₹20L","₹30L"]' or '{₹20L,₹30L}') shown as a range.
    const raw = String(job.salary ?? '').trim();
    const listed = /^[[{]/.test(raw) ? raw.replace(/[[\]{}"]/g, '').split(/\s*,\s*/).filter(Boolean).join(' – ') : raw;
    if (listed && listed.length <= 40) return listed;
    const mine = salaries.filter((s) => s.company_slug === job.company_slug && s.median > 0);
    for (const role of payRoles(job)) {
        const row = mine.find((s) => s.query === role);
        if (row) return `~${money(Number(row.median), row.currency)}/yr on Glassdoor`;
    }
    return null;
}

/**
 * The link for a job in a post: its page on our site (/job.html?id=<job id>, with an "Apply on LinkedIn" button)
 * when siteUrl is given, else a short linkedin.com/jobs/view/<id> link when it is a LinkedIn job, else its apply link.
 */
export function jobLink({ job_id: jobId, url, apply_url: applyUrl }, siteUrl) {
    if (siteUrl && jobId) return `${siteUrl.replace(/\/$/, '')}/job.html?id=${encodeURIComponent(jobId)}`;
    const id = String(url ?? '').match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/)?.[1];
    if (id) return `https://www.linkedin.com/jobs/view/${id}`;
    return /^https?:\/\//.test(url ?? '') ? url : /^https?:\/\//.test(applyUrl ?? '') ? applyUrl : null;
}

/**
 * The post text: a bold heading; for each job a numbered line (company in bold, place in italics), its pay when
 * known (job.pay, see payFor) and its link to the job's page on the site (see jobLink); the most named tech; a link to the
 * board's home page; hashtags.
 * Job titles and hashtags stay plain so LinkedIn search finds them.
 */
export function buildPost({ id, jobs, siteUrl, hashtags = [], maxHashtags = 10 }) {
    const companies = new Set(jobs.map((j) => j.company)).size;
    const top = mostCommon(jobs.flatMap((j) => j.tags ?? []), 3);
    const tags = postHashtags(jobs, hashtags, maxHashtags);
    return [
        `🚀 ${bold(`Hiring alert: ${jobs.length} new opening${jobs.length === 1 ? '' : 's'} at ${companies} compan${companies === 1 ? 'y' : 'ies'}`)}`,
        '',
        ...jobs.flatMap((j, i) => [
            `${i + 1}. ${bold(j.company)}: ${j.title}${where(j) ? ` · ${italic(where(j))}` : ''}`,
            ...(j.pay ? [`💰 ${j.pay}`] : []),
            ...(jobLink(j, siteUrl) ? [`🔗 ${jobLink(j, siteUrl)}`] : []),
            '',
        ]),
        ...(top.length ? [`🔥 ${bold('In demand:')} ${top.join(', ')}`, ''] : []),
        `👉 ${bold('More jobs, updated every few hours:')} ${siteUrl.replace(/\/$/, '')}/`,
        '',
        tags.map((t) => `#${t}`).join(' '),
    ].join('\n');
}

/**
 * Problems with a post compared with the template, empty when it's fine. n8n runs the same checks before it
 * asks for approval (n8n/hiring-alert-workflow.json, node "Check against template"); keep the two in step.
 * Bold and italic letters count as plain ones.
 */
export function checkPost(body) {
    const problems = [];
    const text = plain(body);
    const lines = text.split('\n');
    if (!/^🚀 Hiring alert: \d+ new opening/.test(lines[0] ?? '')) problems.push('first line is not "🚀 Hiring alert: N new openings…"');
    // Counted on the raw text, where a bold letter takes two units, to stay safely under LinkedIn's limit.
    const length = String(body ?? '').length;
    if (length > MAX_CHARS) problems.push(`${length} characters, LinkedIn allows ${MAX_CHARS}`);
    const jobs = lines.filter((l) => /^\d+\. .+: .+/.test(l)).length;
    if (jobs < 1 || jobs > 15) problems.push(`${jobs} job lines, expected 1 to 15`);
    const links = text.match(/https?:\/\/\S+/g) ?? [];
    const home = links.filter((l) => /^https?:\/\/[^/\s]+\/?$/.test(l));
    if (home.length !== 1 || home[0] !== links.at(-1)) problems.push('needs one link to the board\'s home page, after all the others');
    if (links.length - 1 > jobs) problems.push(`${links.length - 1} job links for ${jobs} jobs`);
    const tags = (lines.at(-1) ?? '').match(/#\w+/g) ?? [];
    if (tags.length < 1 || tags.length > 12) problems.push(`${tags.length} hashtags on the last line, expected 1 to 12`);
    if (/\b(undefined|null|NaN)\b/.test(text)) problems.push('contains "undefined", "null" or "NaN"');
    return problems;
}

async function ping(url, token, payload) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Draws the picture of every draft post that has none yet (new posts, and drafts from before pictures): a card
// for each of its companies with their roles, and a strip of the board's top premium companies.
async function drawImages(store, siteUrl) {
    const { renderPostImage, loadLogos, pickCompanies, MAX_FEATURED, MAX_STRIP } = await import('./post-image.js');
    const { rows } = await store.query(
        `SELECT p.id, p.created_at, COALESCE(c.slug, j.company) AS slug, COALESCE(c.name, j.company) AS name,
                c.logo_url, c.domain, COALESCE(c.is_premium, false) AS is_premium, j.title, j.location, j.workplace
         FROM posts p
         JOIN post_jobs pj ON pj.post_id = p.id
         JOIN jobs j ON j.source = pj.source AND j.job_id = pj.job_id
         LEFT JOIN companies c ON c.slug = j.company_slug
         WHERE p.status = 'draft' AND p.image IS NULL
         ORDER BY p.id, pj.position`);
    if (!rows.length) return;
    const { rows: premium } = await store.query(
        `SELECT c.slug, c.name, c.logo_url, c.domain, true AS is_premium
         FROM companies c LEFT JOIN company_index ci ON ci.slug = c.slug
         WHERE c.is_premium ORDER BY ci.score DESC NULLS LAST, c.sort_order, c.name LIMIT $1`, [MAX_STRIP + MAX_FEATURED]);
    const logos = new Map();   // slug → company with its logo, fetched once for all posts
    const withLogo = (c) => ({ ...c, logo: logos.get(c.slug)?.logo ?? null });
    for (const id of new Set(rows.map((r) => r.id))) {
        const mine = rows.filter((r) => r.id === id);
        const postCompanies = new Map();
        for (const r of mine) {
            if (!postCompanies.has(r.slug)) postCompanies.set(r.slug, { ...r, jobs: [] });
            postCompanies.get(r.slug).jobs.push({ title: r.title, place: where(r) });
        }
        const { featured, more, strip } = pickCompanies([...postCompanies.values()], premium);
        for (const c of await loadLogos([...featured, ...strip].filter((c) => !logos.has(c.slug)))) logos.set(c.slug, c);
        const png = renderPostImage({ featured: featured.map(withLogo), more, strip: strip.map(withLogo), jobs: mine.length,
            companiesInPost: postCompanies.size, siteUrl, date: mine[0].created_at });
        await store.query('UPDATE posts SET image = $2 WHERE id = $1', [id, png]);
        console.log(`  🖼 post ${id}: picture with ${featured.length} cards and ${strip.length} more logos`);
    }
}

async function main() {
    const { loadConfig } = await import('./config.js');
    const { openDb } = await import('./db.js');
    const { linkedin: cfg } = loadConfig();
    if (!cfg.people.length || !cfg.siteUrl) {
        console.log('No linkedin.people or linkedin.siteUrl in config, skipping LinkedIn posts');
        return;
    }
    const store = await openDb();
    const made = [];
    try {
        const { rows: candidates } = await store.query('SELECT * FROM post_candidates LIMIT $1', [cfg.jobsPerPost * cfg.people.length]);
        const { rows: salaries } = await store.query(
            `SELECT company_slug, query, currency, median_annual::float AS median FROM company_salaries
             WHERE company_slug = ANY($1) ORDER BY median_annual DESC`, [[...new Set(candidates.map((j) => j.company_slug))]]);
        for (const job of candidates) job.pay = payFor(job, salaries);
        const split = splitJobs(candidates, cfg.people, cfg.jobsPerPost);
        for (const person of cfg.people) {
            const jobs = split.get(person.id);
            const { rows: [last] } = await store.query(
                `SELECT EXTRACT(EPOCH FROM now() - max(created_at)) / 3600 AS hours FROM posts WHERE person = $1`, [person.id]);
            if (last?.hours != null && last.hours < cfg.everyHours - 0.5) {   // half an hour of slack: scrape start times drift
                console.log(`  ${person.id}: last post ${Number(last.hours).toFixed(1)}h ago, next after ${cfg.everyHours}h`);
                continue;
            }
            if (jobs.length < cfg.minJobs) {
                console.log(`  ${person.id}: ${jobs.length} new job(s), fewer than ${cfg.minJobs}, no post`);
                continue;
            }
            const { rows: [{ id }] } = await store.query('INSERT INTO posts (person) VALUES ($1) RETURNING id', [person.id]);
            const body = buildPost({ id, jobs, siteUrl: cfg.siteUrl, hashtags: cfg.hashtags, maxHashtags: cfg.maxHashtags });
            await store.query('UPDATE posts SET body = $2 WHERE id = $1', [id, body]);
            for (const [i, j] of jobs.entries()) {
                await store.query('INSERT INTO post_jobs (post_id, source, job_id, position) VALUES ($1, $2, $3, $4)',
                    [id, j.source, j.job_id, i + 1]);
            }
            const problems = checkPost(body);
            if (problems.length) console.warn(`  ! post ${id} doesn't match the template: ${problems.join('; ')}`);
            made.push({ person, id, jobs: jobs.length });
            console.log(`  ✔ ${person.id}: post ${id} with ${jobs.length} job(s)`);
        }
        await drawImages(store, cfg.siteUrl);
    } finally {
        await store.close();
    }

    for (const { person, id, jobs } of made) {
        const key = person.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        const url = process.env[`N8N_WEBHOOK_${key}`];
        if (!url) {
            console.log(`  ${person.id}: N8N_WEBHOOK_${key} not set, post ${id} is only on the posts page`);
            continue;
        }
        try {
            await ping(url, process.env[`POST_TOKEN_${key}`], {
                postId: Number(id), person: person.id, jobs, alertUrl: `${cfg.siteUrl.replace(/\/$/, '')}/alert.html?id=${id}`,
            });
            console.log(`  ↪ ${person.id}: n8n pinged for post ${id}`);
        } catch (err) {
            // The post stays a draft on the posts page; only the status code is logged, since logs are public.
            console.warn(`  ! ${person.id}: couldn't ping n8n (${err.message})`);
        }
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
