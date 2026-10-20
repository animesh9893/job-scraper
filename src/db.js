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
-- Keyword tags from the title and description (src/tags.js), set after each scrape.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS role TEXT;          -- frontend | backend | mobile | data | ml | devops | …
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS level TEXT;         -- intern | junior | mid | senior | lead | staff | principal
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tags TEXT[];        -- tech named, e.g. {React,TypeScript}
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tagged_at TIMESTAMPTZ;
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
    domain         TEXT,                            -- fallback logo (favicon) when there's no logo_url
    logo_url       TEXT,                            -- from its LinkedIn jobs
    employees      INTEGER,                         -- from its LinkedIn page
    linkedin_checked_at TIMESTAMPTZ,                -- when its LinkedIn page was last read for the ID
    is_premium     BOOLEAN NOT NULL DEFAULT false,
    premium_source TEXT CHECK (premium_source IN ('default', 'earned')),
    sort_order     INTEGER NOT NULL DEFAULT 100,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companies_name_keys ON companies USING gin (name_keys);
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

-- Glassdoor salaries, one row per job title, cached per company for salaries.refreshDays (config).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS salaries_fetched_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS salaries_status TEXT;     -- ok | none | not_found | mismatch | error
ALTER TABLE companies ADD COLUMN IF NOT EXISTS salaries_error TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS glassdoor_name TEXT;      -- the employer Glassdoor matched the name to
ALTER TABLE companies ADD COLUMN IF NOT EXISTS glassdoor_rating NUMERIC;
CREATE TABLE IF NOT EXISTS company_salaries (
    company_slug   TEXT NOT NULL REFERENCES companies(slug) ON DELETE CASCADE ON UPDATE CASCADE,
    job_title      TEXT NOT NULL,       -- as Glassdoor names it
    query          TEXT NOT NULL,       -- the role (salaries.roles) it was found by
    currency       TEXT NOT NULL,
    pay_period     TEXT NOT NULL,       -- what Glassdoor reported; the amounts below are per year
    min_annual     NUMERIC,             -- total pay, 10th percentile
    median_annual  NUMERIC,
    max_annual     NUMERIC,             -- 90th percentile
    usd_per_unit   NUMERIC,             -- exchange rate used for the *_usd columns
    min_usd        NUMERIC,
    median_usd     NUMERIC,
    max_usd        NUMERIC,
    location       TEXT,
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_slug, job_title)
);
ALTER TABLE company_salaries ENABLE ROW LEVEL SECURITY;
-- USD value of one unit of each currency, refreshed at most daily (Frankfurter, ECB rates).
CREATE TABLE IF NOT EXISTS fx_rates (
    currency      TEXT PRIMARY KEY,
    usd_per_unit  NUMERIC NOT NULL,
    rate_date     DATE,
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;

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

    -- Learn each company's LinkedIn page (needed to look up its ID) and logo from its jobs.
    UPDATE companies c SET linkedin_slug = s.ls
    FROM (SELECT DISTINCT ON (ls) ls, company_slug
          FROM (SELECT DISTINCT company_slug, linkedin_company_slug(company_url) AS ls FROM jobs
                WHERE company_slug IN (SELECT slug FROM companies WHERE linkedin_slug IS NULL)) t
          WHERE ls IS NOT NULL ORDER BY ls, company_slug) s
    WHERE c.slug = s.company_slug AND c.linkedin_slug IS NULL
      AND NOT EXISTS (SELECT 1 FROM companies o WHERE o.linkedin_slug = s.ls);
    UPDATE companies c SET logo_url = s.logo
    FROM (SELECT DISTINCT ON (company_slug) company_slug, raw->>'companyLogo' AS logo FROM jobs
          WHERE company_slug IS NOT NULL AND raw->>'companyLogo' LIKE 'https://%'
            AND first_seen_at > now() - interval '7 days'
          ORDER BY company_slug, first_seen_at DESC) s
    WHERE c.slug = s.company_slug AND c.logo_url IS DISTINCT FROM s.logo;
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
           COALESCE(c.is_premium, false) AS "companyPremium", j.role, j.level, j.tags
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
           (COUNT(j.id) FILTER (WHERE j."firstSeenAt" > now() - interval '7 days'))::int AS "jobsWeek",
           c.logo_url AS "logoUrl", c.employees,
           sal.currency AS "salaryCurrency", sal.lo AS "salaryMin", sal.hi AS "salaryMax", sal.n AS "salaryRoles",
           c.glassdoor_rating AS "glassdoorRating"
    FROM companies c
    LEFT JOIN public_jobs j ON j."companySlug" = c.slug
    -- Lowest to highest median pay across its roles, in the currency most of its rows use.
    LEFT JOIN LATERAL (
        SELECT s.currency, MIN(s.median_annual) AS lo, MAX(s.median_annual) AS hi, COUNT(*)::int AS n
        FROM company_salaries s WHERE s.company_slug = c.slug
        GROUP BY s.currency ORDER BY COUNT(*) DESC, s.currency LIMIT 1) sal ON true
    GROUP BY c.slug, sal.currency, sal.lo, sal.hi, sal.n;
-- Per-role salaries for the site's dropdown, highest median first.
CREATE OR REPLACE VIEW public_company_salaries AS
    SELECT company_slug AS "companySlug", job_title AS title, currency,
           min_annual AS min, median_annual AS median, max_annual AS max,
           min_usd AS "minUsd", median_usd AS "medianUsd", max_usd AS "maxUsd", fetched_at AS "fetchedAt"
    FROM company_salaries;

-- Company index, 0 to 100, for ranking companies in LinkedIn posts and on the site:
--   Glassdoor rating            up to 30 (rating / 5; 12 when unknown, a middling rating)
--   premium (MNC) company       20
--   jobs first seen in 7 days   up to 25 (10 or more is full marks)
--   best median pay             up to 25 (its rank among companies with salaries, in USD)
CREATE OR REPLACE VIEW company_index AS
    SELECT c.slug, c.name, c.is_premium, c.glassdoor_rating, COALESCE(w.n, 0)::int AS jobs_week, pay.usd AS pay_usd,
           round((COALESCE(c.glassdoor_rating / 5 * 30, 12)
                 + CASE WHEN c.is_premium THEN 20 ELSE 0 END
                 + LEAST(COALESCE(w.n, 0), 10) * 2.5
                 + COALESCE(CASE WHEN pay.usd IS NOT NULL THEN percent_rank() OVER (PARTITION BY pay.usd IS NOT NULL ORDER BY pay.usd) END, 0) * 25)::numeric,
                 1) AS score
    FROM companies c
    LEFT JOIN LATERAL (SELECT COUNT(*) AS n FROM jobs j
                       WHERE j.company_slug = c.slug AND j.status <> 'skipped' AND j.first_seen_at > now() - interval '7 days') w ON true
    LEFT JOIN LATERAL (SELECT MAX(s.median_usd) AS usd FROM company_salaries s WHERE s.company_slug = c.slug) pay ON true;

-- LinkedIn "Hiring alert" posts (built and approved in n8n, see n8n/README.md) and the jobs in each, so a job
-- is never posted twice. A post is a draft until it is approved and published, then posted (or skipped).
CREATE TABLE IF NOT EXISTS posts (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'skipped')),
    body         TEXT,                             -- the post text as published
    linkedin_url TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    posted_at    TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS post_jobs (
    post_id  BIGINT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
    source   TEXT NOT NULL,
    job_id   TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,           -- order in the post
    PRIMARY KEY (post_id, source, job_id)
);
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_jobs ENABLE ROW LEVEL SECURITY;

-- Jobs worth a post: first seen in the last 3 days, not already posted or in a draft from the last day (a draft
-- never approved frees its jobs after that), at most 2 per company, best first. Job score = company index (0 to 100) + up to 20 for freshness + 5 when it names its tech stack.
CREATE OR REPLACE VIEW post_candidates AS
    SELECT * FROM (
        SELECT j.source, j.job_id, j.title, j.company, j.company_slug, j.location, j.workplace, j.url,
               j.role, j.level, j.tags, j.first_seen_at, ci.score AS company_score, ci.is_premium,
               round((COALESCE(ci.score, 12)
                     + GREATEST(0, 20 - EXTRACT(EPOCH FROM now() - j.first_seen_at) / 3600 / 72 * 20)
                     + CASE WHEN cardinality(j.tags) > 0 THEN 5 ELSE 0 END)::numeric, 1) AS score,
               row_number() OVER (PARTITION BY COALESCE(j.company_slug, j.company)
                                  ORDER BY j.first_seen_at DESC, j.job_id) AS nth_at_company
        FROM jobs j
        LEFT JOIN company_index ci ON ci.slug = j.company_slug
        WHERE j.status <> 'skipped' AND j.first_seen_at > now() - interval '3 days'
          AND NOT EXISTS (SELECT 1 FROM post_jobs pj JOIN posts p ON p.id = pj.post_id
                          WHERE pj.source = j.source AND pj.job_id = j.job_id
                            AND (p.status = 'posted' OR (p.status = 'draft' AND p.created_at > now() - interval '1 day')))
    ) t
    WHERE nth_at_company <= 2
    ORDER BY score DESC, first_seen_at DESC;

-- What n8n calls (see n8n/README.md), so its database login needs nothing but EXECUTE on these two.
-- draft_post() saves the best max_jobs candidates as a new draft post and returns them, or nothing when there
-- are none. finish_post() marks a draft posted (with its text and LinkedIn link) or skipped.
CREATE OR REPLACE FUNCTION draft_post(max_jobs INTEGER DEFAULT 8)
RETURNS TABLE (post_id BIGINT, "position" INTEGER, title TEXT, company TEXT, company_slug TEXT, location TEXT,
               workplace TEXT, url TEXT, role TEXT, level TEXT, tags TEXT[], is_premium BOOLEAN,
               company_score NUMERIC, score NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE new_id BIGINT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM post_candidates) THEN RETURN; END IF;
    INSERT INTO posts DEFAULT VALUES RETURNING id INTO new_id;
    RETURN QUERY
        WITH c AS (SELECT * FROM post_candidates LIMIT max_jobs),
        ins AS (INSERT INTO post_jobs (post_id, source, job_id, position)
                SELECT new_id, c.source, c.job_id, row_number() OVER (ORDER BY c.score DESC, c.first_seen_at DESC) FROM c
                RETURNING post_jobs.source, post_jobs.job_id, post_jobs.position)
        SELECT new_id, ins.position, c.title, c.company, c.company_slug, c.location, c.workplace, c.url, c.role, c.level,
               c.tags, COALESCE(c.is_premium, false), c.company_score, c.score
        FROM c JOIN ins ON ins.source = c.source AND ins.job_id = c.job_id
        ORDER BY ins.position;
END $$;
CREATE OR REPLACE FUNCTION finish_post(id BIGINT, new_status TEXT, post_body TEXT DEFAULT NULL, post_url TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE posts SET status = new_status, body = COALESCE(post_body, body), linkedin_url = COALESCE(post_url, linkedin_url),
                     posted_at = CASE WHEN new_status = 'posted' THEN now() END
    WHERE posts.id = finish_post.id AND status = 'draft' AND new_status IN ('posted', 'skipped');
$$;
-- Functions are callable by everyone unless revoked, and Supabase would expose them to the site's public key.
REVOKE ALL ON FUNCTION draft_post(INTEGER), finish_post(BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC;

-- The site's hiring-alert page (web/alert.html?id=<post id>): the jobs of one post, in post order.
CREATE OR REPLACE VIEW public_alert_jobs AS
    SELECT p.id AS "alertId", p.created_at AS "alertAt", pj.position, j.job_id AS id, j.title, j.company, j.location,
           j.workplace, j.url, j.company_slug AS "companySlug", COALESCE(c.is_premium, false) AS "companyPremium",
           j.role, j.level, j.tags, j.first_seen_at AS "firstSeenAt"
    FROM posts p
    JOIN post_jobs pj ON pj.post_id = p.id
    JOIN jobs j ON j.source = pj.source AND j.job_id = pj.job_id
    LEFT JOIN companies c ON c.slug = j.company_slug
    WHERE p.status <> 'skipped';

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON jobs, categories, searches, companies, company_salaries, fx_rates FROM anon, authenticated;
        REVOKE ALL ON posts, post_jobs, company_index, post_candidates FROM anon, authenticated;
        REVOKE ALL ON FUNCTION draft_post(INTEGER), finish_post(BIGINT, TEXT, TEXT, TEXT) FROM anon, authenticated;
        REVOKE ALL ON public_jobs, public_categories, public_job_counts, public_companies, public_company_salaries,
                      public_alert_jobs FROM anon, authenticated;
        GRANT SELECT ON public_jobs, public_categories, public_job_counts, public_companies, public_company_salaries,
                        public_alert_jobs TO anon, authenticated;
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

        /** Jobs not tagged yet (src/tags.js), newest first. */
        async untaggedJobs(limit) {
            return (await pool.query(
                `SELECT source, job_id, title, description, category FROM jobs WHERE tagged_at IS NULL
                 ORDER BY first_seen_at DESC LIMIT $1`, [limit])).rows;
        },

        /** Saves { source, job_id, role, level, tags } for each job. */
        async saveTags(rows) {
            if (!rows.length) return;
            await pool.query(
                `UPDATE jobs j SET role = t.role, level = t.level, tags = t.tags, tagged_at = now()
                 FROM jsonb_to_recordset($1::jsonb) AS t(source TEXT, job_id TEXT, role TEXT, level TEXT, tags TEXT[])
                 WHERE j.source = t.source AND j.job_id = t.job_id`, [JSON.stringify(rows)]);
        },

        /** Links jobs to companies, adding companies seen for the first time. Returns how many jobs it linked. */
        async linkCompanies() {
            return (await pool.query('SELECT link_companies() AS n')).rows[0].n;
        },

        /**
         * Premium companies without a LinkedIn ID whose LinkedIn page is known (learned from their jobs) and
         * wasn't read in the last week, so their ID can be looked up.
         */
        async companiesToHydrate(limit) {
            return (await pool.query(
                `SELECT slug, linkedin_slug FROM companies
                 WHERE is_premium AND linkedin_id IS NULL AND linkedin_slug IS NOT NULL
                   AND (linkedin_checked_at IS NULL OR linkedin_checked_at < now() - interval '7 days')
                 ORDER BY sort_order, slug LIMIT $1`, [limit])).rows;
        },

        async saveLinkedinPage(slug, { linkedinId, employees }) {
            await pool.query(
                `UPDATE companies SET linkedin_id = COALESCE(linkedin_id, $2), employees = COALESCE($3, employees),
                                      linkedin_checked_at = now() WHERE slug = $1`,
                [slug, linkedinId, employees]);
        },

        /**
         * Companies whose Glassdoor salaries were never fetched, or are older than `refreshDays` (a failed
         * fetch is retried after a day): premium first, then the ones with the most jobs in the last 30 days.
         * Only premium companies and companies with a recent job, since only those are on the site, unless
         * `everyCompany`. A null `limit` means no limit.
         */
        async companiesForSalaries(limit, refreshDays, { everyCompany = false } = {}) {
            return (await pool.query(
                `SELECT c.slug, c.name
                 FROM companies c
                 LEFT JOIN LATERAL (SELECT COUNT(*) AS n FROM jobs j
                                    WHERE j.company_slug = c.slug AND j.first_seen_at > now() - interval '30 days') recent ON true
                 WHERE ($3 OR c.is_premium OR recent.n > 0)
                   AND (c.salaries_fetched_at IS NULL
                        OR c.salaries_fetched_at < now() - make_interval(days => $2)
                        OR (c.salaries_status = 'error' AND c.salaries_fetched_at < now() - interval '1 day'))
                 ORDER BY c.salaries_fetched_at IS NOT NULL, c.is_premium DESC, recent.n DESC, c.sort_order, c.slug
                 LIMIT $1`, [limit, refreshDays, everyCompany])).rows;
        },

        /** USD per unit of each currency; refreshed from Frankfurter (ECB rates) when a day old or missing. */
        async fxRates(currencies) {
            const { rows } = await pool.query(`SELECT currency, usd_per_unit::float AS usd, fetched_at FROM fx_rates`);
            const rates = new Map(rows.map((r) => [r.currency, r]));
            const stale = currencies.filter((c) => c !== 'USD' &&
                (!rates.has(c) || Date.now() - rates.get(c).fetched_at > 24 * 3600e3));
            if (stale.length) {
                try {
                    // [{ date, base: 'USD', quote: 'INR', rate: 94.94 }, …]: units of the quote per US dollar.
                    const res = await fetch(`https://api.frankfurter.dev/v2/rates?base=USD&quotes=${stale.join(',')}`);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    for (const { quote: currency, rate: n, date } of await res.json()) {
                        await pool.query(
                            `INSERT INTO fx_rates (currency, usd_per_unit, rate_date) VALUES ($1, $2, $3)
                             ON CONFLICT (currency) DO UPDATE SET usd_per_unit = $2, rate_date = $3, fetched_at = now()`,
                            [currency, 1 / n, date]);
                        rates.set(currency, { currency, usd: 1 / n });
                    }
                } catch (err) {
                    console.warn(`  ! couldn't refresh exchange rates (${stale.join(', ')}): ${err.message}`);
                }
            }
            return new Map([['USD', 1], ...[...rates.values()].map((r) => [r.currency, r.usd])]);
        },

        /**
         * Replaces a company's salaries with `rows` (already annual, see salaryRows in scrape.js). Rows whose
         * Glassdoor employer doesn't match the company's name are dropped, since Glassdoor resolves unknown
         * names to its closest employer. `notFound` records that Glassdoor has no such employer (kept for
         * refreshDays like a result), `error` a failed fetch (retried after a day).
         */
        async saveSalaries(slug, { rows = [], glassdoorName = null, rating = null, notFound = null, error = null }) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                let status = error ? 'error' : notFound ? 'not_found' : rows.length ? 'ok' : 'none';
                if (status === 'ok') {
                    const { rows: [m] } = await client.query(
                        `SELECT company_key($2) = ANY(name_keys)
                                OR EXISTS (SELECT 1 FROM unnest(name_keys) k
                                           WHERE company_key($2) LIKE k || ' %' OR k LIKE company_key($2) || ' %') AS ok
                         FROM companies WHERE slug = $1`, [slug, glassdoorName]);
                    if (!m?.ok) status = 'mismatch';
                }
                if (status !== 'error') {
                    // A refresh replaces the old rows; a failed fetch keeps them.
                    await client.query('DELETE FROM company_salaries WHERE company_slug = $1', [slug]);
                }
                if (status === 'ok') {
                    for (const r of rows) {
                        await client.query(
                            `INSERT INTO company_salaries (company_slug, job_title, query, currency, pay_period, min_annual,
                                 median_annual, max_annual, usd_per_unit, min_usd, median_usd, max_usd, location)
                             VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::numeric,
                                     $6::numeric * $9::numeric, $7::numeric * $9::numeric, $8::numeric * $9::numeric, $10)
                             ON CONFLICT DO NOTHING`,
                            [slug, r.title, r.query, r.currency, r.payPeriod, r.min, r.median, r.max, r.usdPerUnit, r.location]);
                    }
                }
                await client.query(
                    `UPDATE companies SET salaries_fetched_at = now(), salaries_status = $2, salaries_error = $3,
                         glassdoor_name = COALESCE($4, glassdoor_name), glassdoor_rating = COALESCE($5, glassdoor_rating)
                     WHERE slug = $1`,
                    [slug, status, error ?? notFound ?? (status === 'mismatch' ? `Glassdoor matched "${glassdoorName}"` : null),
                        status === 'ok' ? glassdoorName : null, status === 'ok' ? rating : null]);
                await client.query('COMMIT');
                return status;
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
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
