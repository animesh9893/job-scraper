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

// "Bengaluru, Karnataka, India" → "Bengaluru"; remote jobs say so.
function where({ location, workplace }) {
    const city = String(location ?? '').split(',')[0].trim();
    if (workplace === 'remote') return /remote/i.test(city) || !city ? 'Remote' : `${city} (Remote)`;
    return city;
}

// "Node.js" → "nodejs", "C++" → "cpp", "C#" → "csharp", "Machine Learning" → "machinelearning".
const hashtag = (tag) => tag.toLowerCase().replace(/\+\+/g, 'pp').replace(/#/g, 'sharp').replace(/[^a-z0-9]/g, '');

/** The post text: a numbered list of the jobs, the most named tech, one link to its /alert.html page, hashtags. */
export function buildPost({ id, jobs, siteUrl, hashtags = [] }) {
    const companies = new Set(jobs.map((j) => j.company)).size;
    const counts = new Map();
    for (const t of jobs.flatMap((j) => j.tags ?? [])) counts.set(t, (counts.get(t) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([t]) => t);
    const tags = [...new Set([...hashtags, ...top.map(hashtag)].filter(Boolean))].slice(0, 5);
    return [
        `🚀 Hiring alert: ${jobs.length} new opening${jobs.length === 1 ? '' : 's'} at ${companies} compan${companies === 1 ? 'y' : 'ies'}`,
        '',
        ...jobs.map((j, i) => `${i + 1}. ${j.company}: ${j.title}${where(j) ? ` · ${where(j)}` : ''}`),
        '',
        ...(top.length ? [`🔥 In demand: ${top.join(', ')}`, ''] : []),
        `👉 Every opening with its apply link: ${siteUrl.replace(/\/$/, '')}/alert.html?id=${id}`,
        '',
        tags.map((t) => `#${t}`).join(' '),
    ].join('\n');
}

/**
 * Problems with a post compared with the template, empty when it's fine. n8n runs the same checks before it
 * asks for approval (n8n/hiring-alert-workflow.json, node "Check against template"); keep the two in step.
 */
export function checkPost(body) {
    const problems = [];
    const text = String(body ?? '');
    const lines = text.split('\n');
    if (!/^🚀 Hiring alert: \d+ new opening/.test(lines[0] ?? '')) problems.push('first line is not "🚀 Hiring alert: N new openings…"');
    if (text.length > MAX_CHARS) problems.push(`${text.length} characters, LinkedIn allows ${MAX_CHARS}`);
    const jobs = lines.filter((l) => /^\d+\. .+: .+/.test(l)).length;
    if (jobs < 1 || jobs > 15) problems.push(`${jobs} job lines, expected 1 to 15`);
    const links = text.match(/https?:\/\/\S+/g) ?? [];
    if (links.length !== 1 || !/\/alert\.html\?id=\d+$/.test(links[0])) problems.push('needs exactly one link, to /alert.html?id=…');
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
