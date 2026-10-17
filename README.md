# Job Scraper

Fetches jobs with an Apify Actor (default: `curious_coder/linkedin-jobs-scraper`), stores them in
Supabase (Postgres) and publishes a public job board on GitHub Pages.

Current searches: frontend, backend, full stack and mobile developer jobs in India, each in an
"any workplace" and a "remote" variant (8 searches, up to 20 jobs each, about $0.30 per full run).

## Run it on GitHub (no local setup)

1. **Supabase**: create a free project at supabase.com. Then **Connect → Session pooler** and copy
   the connection string, with your DB password filled in. Use the *pooler* string: the direct
   connection is IPv6-only and GitHub runners can't reach it.
2. **GitHub secrets**: repo → Settings → Secrets and variables → Actions → New repository secret:
   - `APIFY_TOKEN`: Apify Console → Settings → API & Integrations
   - `DATABASE_URL`: the Supabase connection string from step 1
3. **Run**: Actions tab → **Scrape jobs** → **Run workflow**. Leave "searches" blank to run all of them,
   or enter names like `backend-india,backend-remote`.

The run page shows a results table (found / new / filtered / cost per search).
Browse the data in Supabase → **Table Editor** → `jobs` and `runs`.
Tables are created automatically on the first run.

To run it on a schedule later, uncomment `schedule:` in `.github/workflows/scrape.yml`.

## Public job board (GitHub Pages)

After each scrape, the `publish` job builds a static page from the DB (`web/index.html` +
`jobs.json`) and deploys it. It is **off until you turn it on**:

1. **Make Pages available.** On a free GitHub account, Pages only works on **public** repos.
   Either make this repo public (Settings → General → Danger Zone → Change visibility; secrets stay
   hidden) or use GitHub Pro.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions → Variables tab → New repository variable:**
   `PUBLISH_SITE` = `true`.
4. Run **Scrape jobs**. The site is at **https://animesh9893.github.io/job-scraper/**, and the
   link also shows on the run page.

What the page has:
- Category tabs (Frontend / Backend / Full stack / Mobile), workplace filter (Remote / Hybrid /
  On-site), search box, and counts on each filter.
- Filters are kept in the URL, so you can share views like `…/job-scraper/?category=backend&workplace=remote`.
- Only public listing fields are published (title, company, location, category, workplace, job
  link, dates). No descriptions, raw data or job-poster details.
- Shows jobs first seen in the last `site.maxAgeDays` days (`config.yaml`). Light and dark mode, works on phones.

Preview locally: `DATABASE_URL=... node src/build-site.js && npx serve site`

## Run it locally (optional)

```bash
cp .env.example .env            # fill in APIFY_TOKEN and DATABASE_URL
docker compose build
docker compose run --rm scraper                        # all searches
docker compose run --rm scraper src/run.js backend-remote # only some
docker compose run --rm scraper src/stats.js           # DB summary
```

Without Docker: `npm install`, then `npm run scrape` / `npm run stats` (with the same env vars set).

## Configure

Edit `config/config.yaml`:
- `defaults`: Actor input shared by all searches (location India, last 24 hours, 20 jobs each).
- `searches`: each entry is one Actor run. Its `input` is merged over `defaults` and passed to the Actor.
  `category` groups jobs on the site; `workplace: remote` marks every job that search finds as remote
  (other jobs are marked remote or hybrid if their title or location says so).
- `site`: page title, how many days of jobs to show, max jobs.
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

- `jobs`: title, company, company_url, location, category, workplace, url, apply_url, posted_at, employment_type,
  seniority, salary, description, `raw` (the full Actor item as JSONB), status, first/last seen.
- `runs`: one row per search per run.

## Workflows

- `scrape.yml`: manual "Run workflow" button (optional schedule) that scrapes and stores jobs, then
  publishes the job board (when `PUBLISH_SITE=true`).
- `ci.yml`: on every push, checks syntax and that `config.yaml` loads.
