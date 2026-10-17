// Builds the public job board into site/: the static page from web/ plus jobs.json from the DB.
// Usage: node src/build-site.js   (then serve or deploy the site/ folder)
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';

const OUT_DIR = process.env.SITE_DIR ?? 'site';

const { site } = loadConfig();
const store = await openDb();

// Only public listing fields: no descriptions, raw Actor data or job-poster details.
const { rows: jobs } = await store.query(
    `SELECT job_id AS id, title, company, location, category, workplace, url,
            posted_at AS "postedAt", employment_type AS "employmentType", seniority,
            first_seen_at AS "firstSeenAt"
     FROM jobs
     WHERE status <> 'skipped'
       AND first_seen_at > now() - make_interval(days => $1)
     ORDER BY posted_at DESC NULLS LAST, first_seen_at DESC
     LIMIT $2`,
    [site.maxAgeDays, site.maxJobs],
);
await store.close();

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
cpSync('web', OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/jobs.json`, JSON.stringify({
    title: site.title,
    generatedAt: new Date().toISOString(),
    jobs,
}));

console.log(`Built ${OUT_DIR}/ with ${jobs.length} jobs (last ${site.maxAgeDays} days)`);
