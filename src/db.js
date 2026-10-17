import pg from 'pg';
import { requireEnv } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
    source          TEXT NOT NULL,
    job_id          TEXT NOT NULL,
    title           TEXT,
    company         TEXT,
    company_url     TEXT,
    location        TEXT,
    url             TEXT,
    apply_url       TEXT,
    posted_at       TEXT,
    employment_type TEXT,
    seniority       TEXT,
    salary          TEXT,
    description     TEXT,
    search_name     TEXT,
    raw             JSONB,                       -- full Actor item
    status          TEXT NOT NULL DEFAULT 'new', -- new → drafted → posted / skipped
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source, job_id)
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS runs (
    id            BIGSERIAL PRIMARY KEY,
    search_name   TEXT NOT NULL,
    actor         TEXT NOT NULL,
    apify_run_id  TEXT,
    status        TEXT NOT NULL,                 -- RUNNING | SUCCEEDED | FAILED
    items_found   INTEGER DEFAULT 0,
    items_new     INTEGER DEFAULT 0,
    items_skipped INTEGER DEFAULT 0,
    cost_usd      NUMERIC(10, 4),
    error         TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);
`;

const JOB_COLUMNS = ['source', 'job_id', 'title', 'company', 'company_url', 'location', 'url', 'apply_url',
    'posted_at', 'employment_type', 'seniority', 'salary', 'description', 'search_name', 'raw'];

// xmax = 0 only for rows this statement inserted, so it tells new jobs apart from ones already stored.
const INSERT_JOB = `
    INSERT INTO jobs (${JOB_COLUMNS.join(', ')})
    VALUES (${JOB_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
    ON CONFLICT (source, job_id) DO UPDATE SET last_seen_at = now()
    RETURNING (xmax = 0) AS inserted
`;

export async function openDb() {
    const pool = new pg.Pool({
        connectionString: requireEnv('DATABASE_URL'),
        // Supabase requires TLS; set DATABASE_SSL=false for a local Postgres without it.
        ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
        max: 2,
    });
    await pool.query(SCHEMA);

    return {
        query: (text, params) => pool.query(text, params),

        /** Inserts jobs; existing ones only get last_seen_at bumped. Returns how many were new. */
        async saveJobs(jobs) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                let added = 0;
                for (const job of jobs) {
                    const { rows } = await client.query(INSERT_JOB, JOB_COLUMNS.map((c) => job[c]));
                    if (rows[0].inserted) added++;
                }
                await client.query('COMMIT');
                return added;
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        },

        async startRun(searchName, actor) {
            const { rows } = await pool.query(
                `INSERT INTO runs (search_name, actor, status) VALUES ($1, $2, 'RUNNING') RETURNING id`,
                [searchName, actor],
            );
            return rows[0].id;
        },

        async finishRun(id, fields) {
            const f = {
                apify_run_id: null, items_found: 0, items_new: 0, items_skipped: 0,
                cost_usd: null, error: null, ...fields,
            };
            await pool.query(
                `UPDATE runs SET status = $2, apify_run_id = $3, items_found = $4, items_new = $5,
                                 items_skipped = $6, cost_usd = $7, error = $8, finished_at = now()
                 WHERE id = $1`,
                [id, f.status, f.apify_run_id, f.items_found, f.items_new, f.items_skipped, f.cost_usd, f.error],
            );
        },

        close: () => pool.end(),
    };
}
