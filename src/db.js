import pg from 'pg';
import { requireEnv } from './config.js';
import { CATEGORIES, SEARCHES } from './seed-data.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
    source          TEXT NOT NULL,
    job_id          TEXT NOT NULL,
    title           TEXT,
    company         TEXT,
    company_url     TEXT,
    location        TEXT,
    category        TEXT,                        -- from the search: frontend | backend | fullstack | mobile
    workplace       TEXT,                        -- remote | hybrid | NULL (on-site / not stated)
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

-- Columns added after the first release; no-ops on new databases.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workplace TEXT;
UPDATE jobs SET category = split_part(search_name, '-', 1)
WHERE category IS NULL AND split_part(search_name, '-', 1) IN ('frontend', 'backend', 'fullstack', 'mobile');

-- Tags shown as tabs on the site; searches.category points here.
CREATE TABLE IF NOT EXISTS categories (
    slug       TEXT PRIMARY KEY,                 -- e.g. frontend
    label      TEXT NOT NULL,                    -- e.g. Frontend
    sort_order INTEGER NOT NULL DEFAULT 100      -- tab order, lowest first
);

-- One row per Actor run to do. Each scrape takes the few searches that ran longest ago
-- (config searchesPerRun), so a limited Apify budget rotates through all of them.
CREATE TABLE IF NOT EXISTS searches (
    name        TEXT PRIMARY KEY,                -- e.g. backend-remote
    category    TEXT REFERENCES categories (slug) ON UPDATE CASCADE,
    workplace   TEXT CHECK (workplace IN ('remote', 'hybrid')), -- marks every job it finds
    input       JSONB NOT NULL DEFAULT '{}',     -- Actor input, merged over config defaults
    is_active   BOOLEAN NOT NULL DEFAULT true,
    priority    INTEGER NOT NULL DEFAULT 100,    -- lower runs first among equally stale searches
    last_run_at TIMESTAMPTZ,
    last_status TEXT,                            -- SUCCEEDED | FAILED
    last_error  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE searches ENABLE ROW LEVEL SECURITY;

-- The website reads only these views, with Supabase's public anon key. The base tables have RLS on
-- and no policies, so that key can't read raw data, descriptions or runs. The view runs as its
-- owner, which is why it can still read jobs.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE VIEW public_jobs AS
    SELECT job_id AS id, title, company, location, category, workplace, url,
           posted_at AS "postedAt", employment_type AS "employmentType", seniority,
           first_seen_at AS "firstSeenAt"
    FROM jobs
    WHERE status <> 'skipped' AND first_seen_at > now() - interval '30 days';
CREATE OR REPLACE VIEW public_categories AS
    SELECT slug, label, sort_order FROM categories;
-- Tab counts, so the site doesn't have to download every job to count them.
CREATE OR REPLACE VIEW public_job_counts AS
    SELECT category, workplace, COUNT(*)::int AS n FROM public_jobs GROUP BY category, workplace;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON jobs, categories, searches FROM anon, authenticated;
        REVOKE ALL ON public_jobs, public_categories, public_job_counts FROM anon, authenticated;
        GRANT SELECT ON public_jobs, public_categories, public_job_counts TO anon, authenticated;
    END IF;
END $$;

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
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS apify_token TEXT;   -- label of the Apify token used

-- Apify accounts to spend, lowest priority first. When one has less than config minRemainingUsd
-- left this month, the scraper moves on to the next (src/tokens.js). The secret APIFY_TOKEN is
-- used last. RLS with no policies: the site's public key can't read these.
CREATE TABLE IF NOT EXISTS apify_tokens (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label             TEXT NOT NULL UNIQUE,          -- e.g. the Apify username
    token             TEXT NOT NULL UNIQUE,          -- apify_api_...
    is_active         BOOLEAN NOT NULL DEFAULT true,
    priority          INTEGER NOT NULL DEFAULT 100,  -- lower = used first
    monthly_limit_usd NUMERIC(10, 4),                -- filled in by the scraper
    used_usd          NUMERIC(10, 4),
    remaining_usd     NUMERIC(10, 4),
    cycle_end_at      TIMESTAMPTZ,                   -- when Apify resets this account's usage
    last_checked_at   TIMESTAMPTZ,
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE apify_tokens ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON runs, apify_tokens FROM anon, authenticated;
    END IF;
END $$;

-- Telegram alerts: who wants which keywords (written by the bot webhook api/telegram.js), and which
-- jobs each subscriber already got (src/telegram-notify.js). Private: RLS with no policies.
CREATE TABLE IF NOT EXISTS telegram_subscribers (
    chat_id      BIGINT PRIMARY KEY,
    username     TEXT,
    keywords     JSONB NOT NULL DEFAULT '[]',     -- [{"text": "react.js", "anywhere": false}]
    locations    TEXT[] NOT NULL DEFAULT '{}',    -- e.g. {remote, bengaluru}; empty = anywhere
    is_active    BOOLEAN NOT NULL DEFAULT true,   -- false after /stop or when the user blocks the bot
    last_sent_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telegram_sent (
    chat_id BIGINT NOT NULL REFERENCES telegram_subscribers (chat_id) ON DELETE CASCADE,
    source  TEXT NOT NULL,
    job_id  TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, source, job_id)
);
ALTER TABLE telegram_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_sent ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON telegram_subscribers, telegram_sent FROM anon, authenticated;
    END IF;
END $$;
`;

const JOB_COLUMNS = ['source', 'job_id', 'title', 'company', 'company_url', 'location', 'category', 'workplace', 'url', 'apply_url',
    'posted_at', 'employment_type', 'seniority', 'salary', 'description', 'search_name', 'raw'];

// xmax = 0 only for rows this statement inserted, so it tells new jobs apart from ones already stored.
// A job seen again keeps its first category; it becomes remote if any search finds it as remote.
const INSERT_JOB = `
    INSERT INTO jobs (${JOB_COLUMNS.join(', ')})
    VALUES (${JOB_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
    ON CONFLICT (source, job_id) DO UPDATE SET
        last_seen_at = now(),
        category = COALESCE(jobs.category, EXCLUDED.category),
        workplace = CASE WHEN EXCLUDED.workplace = 'remote' THEN 'remote'
                         ELSE COALESCE(jobs.workplace, EXCLUDED.workplace) END
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
    await seedIfEmpty(pool);

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

        /**
         * Active searches to run now: the given names, or else the `limit` that ran longest ago
         * (never-run first, newest added first among those). Each comes back as { name, category, workplace, input }.
         */
        async pickSearches({ names = [], limit }) {
            const { rows } = names.length
                ? await pool.query('SELECT * FROM searches WHERE name = ANY($1) ORDER BY name', [names])
                : await pool.query(
                    `SELECT * FROM searches WHERE is_active
                     ORDER BY last_run_at ASC NULLS FIRST, priority, created_at DESC, name LIMIT $1`, [limit]);
            return rows;
        },

        async allSearchNames() {
            return (await pool.query('SELECT name FROM searches ORDER BY name')).rows.map((r) => r.name);
        },

        async markSearch(name, status, error = null) {
            await pool.query(
                'UPDATE searches SET last_run_at = now(), last_status = $2, last_error = $3 WHERE name = $1',
                [name, status, error]);
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
                apify_run_id: null, apify_token: null, items_found: 0, items_new: 0, items_skipped: 0,
                cost_usd: null, error: null, ...fields,
            };
            await pool.query(
                `UPDATE runs SET status = $2, apify_run_id = $3, items_found = $4, items_new = $5,
                                 items_skipped = $6, cost_usd = $7, error = $8, apify_token = $9, finished_at = now()
                 WHERE id = $1`,
                [id, f.status, f.apify_run_id, f.items_found, f.items_new, f.items_skipped, f.cost_usd, f.error, f.apify_token],
            );
        },

        close: () => pool.end(),
    };
}

/** On a fresh database (no categories yet), inserts the starting categories and searches. */
export async function seedIfEmpty(pool) {
    const { rows } = await pool.query('SELECT EXISTS (SELECT 1 FROM categories) AS seeded');
    if (rows[0].seeded) return;
    await seed(pool);
}

/** Inserts the starting categories and searches; existing rows with the same name are kept. */
export async function seed(pool) {
    for (const c of CATEGORIES) {
        await pool.query(
            'INSERT INTO categories (slug, label, sort_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [c.slug, c.label, c.sort_order]);
    }
    for (const s of SEARCHES) {
        await pool.query(
            'INSERT INTO searches (name, category, workplace, input) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
            [s.name, s.category ?? null, s.workplace ?? null, s.input]);
    }
}
