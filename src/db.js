import pg from 'pg';
import { requireEnv } from './config.js';
import { CATEGORIES, COMPANIES, SEARCHES } from './seed-data.js';

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
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_slug TEXT;   -- companies.slug, set by link_companies()
CREATE INDEX IF NOT EXISTS jobs_company_slug ON jobs(company_slug);
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
-- Set: the search runs every N hours on top of the rotation (premium company searches). NULL: it rotates.
ALTER TABLE searches ADD COLUMN IF NOT EXISTS interval_hours INTEGER CHECK (interval_hours > 0);

-- One row per employer. Premium ones are seeded (src/seed-data.js) and searched by LinkedIn company ID;
-- every other company a job mentions is added by link_companies().
CREATE TABLE IF NOT EXISTS companies (
    slug           TEXT PRIMARY KEY,                -- e.g. google; used in the site URL
    name           TEXT NOT NULL,
    linkedin_id    TEXT,                            -- numeric id for LinkedIn's f_C filter
    linkedin_slug  TEXT UNIQUE,                     -- linkedin.com/company/<this>, matched against jobs.company_url
    name_keys      TEXT[] NOT NULL DEFAULT '{}',    -- company_key() of the name and aliases, matched against jobs.company
    domain         TEXT,                            -- for the logo
    is_premium     BOOLEAN NOT NULL DEFAULT false,
    premium_source TEXT CHECK (premium_source IN ('default', 'earned')),
    sort_order     INTEGER NOT NULL DEFAULT 100,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companies_name_keys ON companies USING gin (name_keys);
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

-- "Google India Pvt. Ltd." → "google". Legal suffixes and "India" are dropped so spellings of one employer match.
CREATE OR REPLACE FUNCTION company_key(name TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT NULLIF(trim(regexp_replace(regexp_replace(regexp_replace(lower(name),
        '[.,&()''"]', ' ', 'g'),
        '\\m(private|pvt|limited|ltd|inc|incorporated|llc|llp|corp|corporation|plc|gmbh|india|technologies|technology|solutions|services)\\M', ' ', 'g'),
        '\\s+', ' ', 'g')), '')
$$;
CREATE OR REPLACE FUNCTION linkedin_company_slug(url TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT lower(substring(url FROM 'linkedin\\.com/company/([^/?#]+)'))
$$;

-- Points jobs without a company at one: by LinkedIn company page first, then by name. Companies not seen
-- before are added (not premium). Returns how many jobs it linked.
CREATE OR REPLACE FUNCTION link_companies() RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    linked INTEGER := 0;
    n INTEGER;
    pass INTEGER;
BEGIN
    FOR pass IN 1..3 LOOP
        UPDATE jobs j SET company_slug = c.slug FROM companies c
        WHERE j.company_slug IS NULL AND c.linkedin_slug = linkedin_company_slug(j.company_url);
        GET DIAGNOSTICS n = ROW_COUNT; linked := linked + n;
        UPDATE jobs j SET company_slug = c.slug FROM companies c
        WHERE j.company_slug IS NULL AND company_key(j.company) = ANY (c.name_keys);
        GET DIAGNOSTICS n = ROW_COUNT; linked := linked + n;
        EXIT WHEN pass = 3;

        -- New companies, slugged from their LinkedIn page or name; the second pass adds a hash for slugs taken.
        INSERT INTO companies (slug, name, linkedin_slug, name_keys)
        SELECT DISTINCT ON (key)
               CASE WHEN pass = 1 AND base <> '' THEN base
                    ELSE left(base, 40) || CASE WHEN base = '' THEN 'c-' ELSE '-' END || left(md5(key), 6) END,
               company, ls, ARRAY[key]
        FROM (SELECT company, company_key(company) AS key, linkedin_company_slug(company_url) AS ls,
                     trim(BOTH '-' FROM regexp_replace(COALESCE(linkedin_company_slug(company_url), company_key(company)),
                                                       '[^a-z0-9]+', '-', 'g')) AS base,
                     first_seen_at
              FROM jobs WHERE company_slug IS NULL AND company_key(company) IS NOT NULL) t
        ORDER BY key, first_seen_at
        ON CONFLICT DO NOTHING;
    END LOOP;
    RETURN linked;
END $$;

-- Moves jobs that match a company (by LinkedIn page or name) onto it, e.g. after it was added or got an alias,
-- and drops the auto-added companies left without jobs.
CREATE OR REPLACE FUNCTION relink_company(target TEXT) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
    UPDATE jobs j SET company_slug = c.slug FROM companies c
    WHERE c.slug = target AND j.company_slug IS DISTINCT FROM c.slug
      AND (c.linkedin_slug = linkedin_company_slug(j.company_url) OR company_key(j.company) = ANY (c.name_keys));
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM companies c WHERE NOT c.is_premium AND c.linkedin_id IS NULL AND c.domain IS NULL
                              AND NOT EXISTS (SELECT 1 FROM jobs WHERE company_slug = c.slug);
    RETURN n;
END $$;

-- The website reads only these views, with Supabase's public anon key. The base tables have RLS on
-- and no policies, so that key can't read raw data, descriptions or runs. The view runs as its
-- owner, which is why it can still read jobs.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE VIEW public_jobs AS
    SELECT j.job_id AS id, j.title, j.company, j.location, j.category, j.workplace, j.url,
           j.posted_at AS "postedAt", j.employment_type AS "employmentType", j.seniority,
           j.first_seen_at AS "firstSeenAt", j.company_slug AS "companySlug",
           COALESCE(c.is_premium, false) AS "companyPremium"
    FROM jobs j LEFT JOIN companies c ON c.slug = j.company_slug
    WHERE j.status <> 'skipped' AND j.first_seen_at > now() - interval '30 days';
CREATE OR REPLACE VIEW public_categories AS
    SELECT slug, label, sort_order FROM categories;
-- Tab counts, so the site doesn't have to download every job to count them.
CREATE OR REPLACE VIEW public_job_counts AS
    SELECT category, workplace, COUNT(*)::int AS n FROM public_jobs GROUP BY category, workplace;
-- Companies for the filter and the premium chips, with how many listed jobs each has.
CREATE OR REPLACE VIEW public_companies AS
    SELECT c.slug, c.name, c.domain, c.is_premium AS "isPremium", c.sort_order AS "sortOrder",
           COUNT(j.id)::int AS jobs,
           (COUNT(j.id) FILTER (WHERE j."firstSeenAt" > now() - interval '7 days'))::int AS "jobsWeek"
    FROM companies c LEFT JOIN public_jobs j ON j."companySlug" = c.slug
    GROUP BY c.slug;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON jobs, categories, searches, companies FROM anon, authenticated;
        REVOKE ALL ON public_jobs, public_categories, public_job_counts, public_companies FROM anon, authenticated;
        GRANT SELECT ON public_jobs, public_categories, public_job_counts, public_companies TO anon, authenticated;
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

-- Telegram alerts: who wants which keywords (written by the bot webhook web/api/telegram.mjs), and which
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
    await seedCompaniesIfEmpty(pool);

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
         * Searches to run now: the given names, every active one (`all`), or else the interval searches that are
         * due plus the `limit` rotating ones that ran longest ago (never-run first, newest added first among
         * those). Each comes back as { name, category, workplace, input }.
         */
        async pickSearches({ names = [], limit, all = false }) {
            if (names.length) return (await pool.query('SELECT * FROM searches WHERE name = ANY($1) ORDER BY name', [names])).rows;
            const order = 'ORDER BY last_run_at ASC NULLS FIRST, priority, created_at DESC, name';
            if (all) return (await pool.query(`SELECT * FROM searches WHERE is_active ${order}`)).rows;
            // 30 minutes' slack, so a search due every 6 hours isn't skipped when the scheduled run starts early.
            const { rows: due } = await pool.query(
                `SELECT * FROM searches WHERE is_active AND interval_hours IS NOT NULL
                   AND (last_run_at IS NULL OR last_run_at < now() - make_interval(hours => interval_hours) + interval '30 minutes')
                 ${order}`);
            const { rows: rotating } = await pool.query(
                `SELECT * FROM searches WHERE is_active AND interval_hours IS NULL ${order} LIMIT $1`, [limit]);
            return [...due, ...rotating];
        },

        /** Links jobs to companies, adding companies seen for the first time. Returns how many jobs it linked. */
        async linkCompanies() {
            return (await pool.query('SELECT link_companies() AS n')).rows[0].n;
        },

        /**
         * Keeps one LinkedIn search per `companiesPerSearch` premium companies that have a LinkedIn ID
         * (premium-1, premium-2, …), each run every `intervalHours` and asking only for jobs posted since
         * a bit before the last run, so the Actor (billed per job) mostly returns new ones.
         */
        async syncPremiumSearches({ keywords, location, intervalHours, jobsPerSearch, companiesPerSearch }) {
            const { rows } = await pool.query(
                `SELECT linkedin_id FROM companies WHERE is_premium AND linkedin_id IS NOT NULL ORDER BY sort_order, slug`);
            const groups = [];
            for (let i = 0; i < rows.length; i += companiesPerSearch) groups.push(rows.slice(i, i + companiesPerSearch));
            const names = [];
            for (const [i, group] of groups.entries()) {
                const params = { keywords, location, f_C: group.map((r) => r.linkedin_id).join(','), f_TPR: `r${(intervalHours + 1) * 3600}` };
                const url = 'https://www.linkedin.com/jobs/search/?' +
                    Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
                const name = `premium-${i + 1}`;
                names.push(name);
                await pool.query(
                    `INSERT INTO searches (name, input, interval_hours) VALUES ($1, $2, $3)
                     ON CONFLICT (name) DO UPDATE SET input = EXCLUDED.input, interval_hours = EXCLUDED.interval_hours, is_active = true`,
                    [name, { urls: [url], limitPerSource: jobsPerSearch }, intervalHours]);
            }
            await pool.query(`UPDATE searches SET is_active = false WHERE name LIKE 'premium-%' AND NOT (name = ANY($1))`, [names]);
            return names;
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

/**
 * Adds the premium companies from seed-data.js and moves matching jobs onto them, unless each one was made
 * premium before (premium_source stays set after `companies.js unpremium`, so those aren't re-added).
 */
export async function seedCompaniesIfEmpty(pool) {
    const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM companies WHERE slug = ANY($1) AND premium_source IS NOT NULL', [COMPANIES.map((c) => c.slug)]);
    if (rows[0].n === COMPANIES.length) return;
    await seedCompanies(pool);
}

/** Adds or updates the premium companies from seed-data.js and moves their jobs onto them. */
export async function seedCompanies(pool) {
    for (const c of COMPANIES) {
        await upsertCompany(pool, { ...c, is_premium: true, premium_source: 'default' });
    }
}

/**
 * Adds a company or updates the given fields of an existing one, then moves matching jobs onto it.
 * Its name_keys are computed from `name` and `aliases`. Returns how many jobs moved.
 */
export async function upsertCompany(pool, c) {
    const keys = (await pool.query('SELECT array_remove(array_agg(DISTINCT company_key(n)), NULL) AS keys FROM unnest($1::text[]) n',
        [[c.name, ...(c.aliases ?? [])]])).rows[0].keys;
    // A company auto-added under the same LinkedIn page keeps its jobs only until relink_company() moves them.
    if (c.linkedin_slug) {
        await pool.query('UPDATE companies SET linkedin_slug = NULL WHERE linkedin_slug = $1 AND slug <> $2', [c.linkedin_slug, c.slug]);
    }
    await pool.query(
        `INSERT INTO companies (slug, name, linkedin_id, linkedin_slug, name_keys, domain, is_premium, premium_source, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, false), $8, COALESCE($9, 100))
         ON CONFLICT (slug) DO UPDATE SET
             name = EXCLUDED.name,
             linkedin_id = COALESCE($3, companies.linkedin_id),
             linkedin_slug = COALESCE($4, companies.linkedin_slug),
             name_keys = ARRAY(SELECT DISTINCT unnest(companies.name_keys || EXCLUDED.name_keys)),
             domain = COALESCE($6, companies.domain),
             is_premium = COALESCE($7, companies.is_premium),
             premium_source = COALESCE($8, companies.premium_source),
             sort_order = COALESCE($9, companies.sort_order)`,
        [c.slug, c.name, c.linkedin_id ?? null, c.linkedin_slug ?? null, keys, c.domain ?? null,
            c.is_premium ?? null, c.premium_source ?? null, c.sort_order ?? null]);
    return (await pool.query('SELECT relink_company($1) AS n', [c.slug])).rows[0].n;
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
