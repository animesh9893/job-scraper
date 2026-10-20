// After each scrape: splits the best new jobs (view post_candidates) between the people in config `linkedin`,
// writes one LinkedIn hiring-alert post for each (table posts, shown on the private page /posts.html), then
// pings each person's n8n (secret N8N_WEBHOOK_<ID>) so it emails the post for approval and publishes it.
// Usage: node src/linkedin-posts.js   (needs DATABASE_URL; without a person's webhook secret their post is only
// shown on the page)
import { pathToFileURL } from 'node:url';

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

// The Glassdoor roles (config salaries.roles) that fit a job, best first. Interns get none: a full-time median
// would mislead. Managers, product, design and data roles don't fall back to software engineer pay.
export function payRoles({ title, role, level }) {
    if (level === 'intern') return [];
    const t = String(title ?? '').toLowerCase();
    const senior = ['senior', 'lead', 'staff', 'principal'].includes(level);
    const byLevel = { principal: 'Principal Software Engineer', staff: 'Staff Software Engineer',
        lead: 'Senior Software Engineer', senior: 'Senior Software Engineer' }[level];
    const byRole = {
        manager: ['Engineering Manager'],
        product: [senior ? 'Senior Product Manager' : 'Product Manager', 'Product Manager'],
        design: ['Product Designer'],
        ml: ['Machine Learning Engineer', 'Data Scientist'],
        data: [/scientist/.test(t) ? 'Data Scientist' : /analyst/.test(t) ? 'Data Analyst' : 'Data Engineer'],
        devops: [/reliability|\bsre\b/.test(t) ? 'Site Reliability Engineer' : 'DevOps Engineer', 'Site Reliability Engineer'],
        qa: ['QA Engineer'],
        mobile: [/android/.test(t) ? 'Android Developer' : /\bios\b/.test(t) ? 'iOS Developer' : 'Mobile Developer', 'Mobile Developer'],
        fullstack: ['Full Stack Developer'],
        frontend: ['Frontend Developer'],
        backend: ['Backend Developer'],
    }[role] ?? [];
    const engineering = !['manager', 'product', 'design', 'data'].includes(role);
    return [...new Set([...(engineering && byLevel ? [byLevel] : []), ...byRole, ...(engineering ? ['Software Engineer'] : [])])];
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

/** The job's own page: a short linkedin.com/jobs/view/<id> link when it is a LinkedIn job, else its apply link. */
export function jobLink({ url, apply_url: applyUrl }) {
    const id = String(url ?? '').match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/)?.[1];
    if (id) return `https://www.linkedin.com/jobs/view/${id}`;
    return /^https?:\/\//.test(url ?? '') ? url : /^https?:\/\//.test(applyUrl ?? '') ? applyUrl : null;
}

/**
 * The post text: a bold heading; for each job a numbered line (company in bold, place in italics), its pay when
 * known (job.pay, see payFor) and its link; the most named tech; a link to the post's /alert.html page; hashtags.
 * Job titles and hashtags stay plain so LinkedIn search finds them.
 */
export function buildPost({ id, jobs, siteUrl, hashtags = [] }) {
    const companies = new Set(jobs.map((j) => j.company)).size;
    const counts = new Map();
    for (const t of jobs.flatMap((j) => j.tags ?? [])) counts.set(t, (counts.get(t) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([t]) => t);
    const tags = [...new Set([...hashtags, ...top.map(hashtag)].filter(Boolean))].slice(0, 5);
    return [
        `🚀 ${bold(`Hiring alert: ${jobs.length} new opening${jobs.length === 1 ? '' : 's'} at ${companies} compan${companies === 1 ? 'y' : 'ies'}`)}`,
        '',
        ...jobs.flatMap((j, i) => [
            `${i + 1}. ${bold(j.company)}: ${j.title}${where(j) ? ` · ${italic(where(j))}` : ''}`,
            ...(j.pay ? [`💰 ${j.pay}`] : []),
            ...(jobLink(j) ? [`🔗 ${jobLink(j)}`] : []),
            '',
        ]),
        ...(top.length ? [`🔥 ${bold('In demand:')} ${top.join(', ')}`, ''] : []),
        `👉 ${bold('All of them on one page:')} ${siteUrl.replace(/\/$/, '')}/alert.html?id=${id}`,
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
    const alert = links.filter((l) => /\/alert\.html\?id=\d+$/.test(l));
    if (alert.length !== 1 || alert[0] !== links.at(-1)) problems.push('needs one link to /alert.html?id=…, after all the others');
    if (links.length - 1 > jobs) problems.push(`${links.length - 1} job links for ${jobs} jobs`);
    const tags = (lines.at(-1) ?? '').match(/#\w+/g) ?? [];
    if (tags.length < 1 || tags.length > 5) problems.push(`${tags.length} hashtags on the last line, expected 1 to 5`);
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
            if (jobs.length < cfg.minJobs) {
                console.log(`  ${person.id}: ${jobs.length} new job(s), fewer than ${cfg.minJobs}, no post`);
                continue;
            }
            const { rows: [{ id }] } = await store.query('INSERT INTO posts (person) VALUES ($1) RETURNING id', [person.id]);
            const body = buildPost({ id, jobs, siteUrl: cfg.siteUrl, hashtags: cfg.hashtags });
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
