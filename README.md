# Job Scraper

Fetches jobs with an Apify Actor (default: `curious_coder/linkedin-jobs-scraper`)
and stores them in Supabase (Postgres). Posting and the UI come later.

## Run it on GitHub (no local setup)

1. **Supabase**: create a free project at supabase.com. Then **Connect → Session pooler** and copy
   the connection string, with your DB password filled in. Use the *pooler* string: the direct
   connection is IPv6-only and GitHub runners can't reach it.
2. **GitHub secrets**: repo → Settings → Secrets and variables → Actions → New repository secret:
   - `APIFY_TOKEN`: Apify Console → Settings → API & Integrations
   - `DATABASE_URL`: the Supabase connection string from step 1
3. **Run**: Actions tab → **Scrape jobs** → **Run workflow**. Leave "searches" blank to run all of them,
   or enter names like `backend-bangalore,react-india`.

The run page shows a results table (found / new / filtered / cost per search).
Browse the data in Supabase → **Table Editor** → `jobs` and `runs`.
Tables are created automatically on the first run.

To run it on a schedule later, uncomment `schedule:` in `.github/workflows/scrape.yml`.

## Run it locally (optional)

```bash
cp .env.example .env            # fill in APIFY_TOKEN and DATABASE_URL
docker compose build
docker compose run --rm scraper                        # all searches
docker compose run --rm scraper src/run.js react-india # only some
docker compose run --rm scraper src/stats.js           # DB summary
```

Without Docker: `npm install`, then `npm run scrape` / `npm run stats` (with the same env vars set).

## Configure

Edit `config/config.yaml`:
- `searches`: each entry is one Actor run. Its `input` is passed to the Actor as-is.
- `filters`: drop jobs by title words or company name.
- `actor` / `source`: change the job source.

## How it works

For each search:
1. Runs the Actor and waits for it to finish.
2. Maps each item to a job row (`normalizeJob` in `src/scrape.js`). HTML entities are decoded and
   tracking parameters are stripped from URLs.
3. Drops jobs matching `filters`.
4. Inserts new jobs with `status = 'new'`. A job already stored (same `source` + `job_id`) only
   gets `last_seen_at` updated, so nothing is stored twice.
5. Logs the run (counts, Apify run ID, cost, error) in `runs`.

If one search fails, the others still run; the command then exits with code 1, so the workflow shows as failed.

## Tables

- `jobs`: title, company, company_url, location, url, apply_url, posted_at, employment_type,
  seniority, salary, description, `raw` (the full Actor item as JSONB), status, first/last seen.
- `runs`: one row per search per run.

## Workflows

- `scrape.yml`: manual "Run workflow" button (optional schedule) that scrapes and stores jobs.
- `ci.yml`: on every push, checks syntax and that `config.yaml` loads.
