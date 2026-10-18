# Job Scraper

Fetches jobs with an Apify Actor (default: `curious_coder/linkedin-jobs-scraper`), stores them in
Supabase (Postgres) and publishes a public job board on GitHub Pages.

Searches and categories (the tabs on the site) live in Supabase. The first run adds 8 starting
searches: frontend, backend, full stack and mobile developer jobs in India, each in an "any workplace"
and a "remote" variant. Each run does only `searchesPerRun` of them (default 2, about $0.08), the ones
that ran longest ago first, so a limited Apify budget rotates through every search.

## Run it on GitHub (no local setup)

1. **Supabase**: create a free project at supabase.com. Then **Connect → Session pooler** and copy
   the connection string, with your DB password filled in. Use the *pooler* string: the direct
   connection is IPv6-only and GitHub runners can't reach it.
2. **GitHub secrets**: repo → Settings → Secrets and variables → Actions → New repository secret:
   - `APIFY_TOKEN`: Apify Console → Settings → API & Integrations
   - `DATABASE_URL`: the Supabase connection string from step 1
3. **Run**: Actions tab → **Scrape jobs** → **Run workflow**. Leave "searches" blank to run the next
   few in the rotation, enter names like `backend-india,backend-remote`, or `all` for every active search.

The run page shows a results table (found / new / filtered / cost per search).
Browse the data in Supabase → **Table Editor** → `jobs`, `searches`, `categories` and `runs`.
Tables are created automatically on the first run.

It also runs on its own every 3 hours (`schedule:` in `.github/workflows/scrape.yml`), each time
the next `searchesPerRun` searches in the rotation.

## Several Apify accounts

Each Apify account has a monthly credit. Add more accounts' tokens and the scraper spends them in
order: before each search it checks the current token's remaining credit, and when it is below
`minRemainingUsd` (`config.yaml`), or a run fails and the account turns out to be out of credit,
it switches to the next token and runs the search again. The `APIFY_TOKEN` secret is used last.

```bash
node --env-file=.env src/tokens.js add apify_api_XXXX [label] [priority]   # checks it with Apify, then saves it
node --env-file=.env src/tokens.js                                         # credit left on every token
node --env-file=.env src/tokens.js disable <label>                         # or enable / remove
```

Or insert rows into the `apify_tokens` table in Supabase's Table Editor (label, token, priority).
Tokens are never passed through workflow inputs, since those show up in the run's logs.
If every token is out of credit, searches are left at the front of the rotation for the next run.

## Searches and categories

Add or change them from GitHub with **Actions → Manage searches → Run workflow** (pick a command,
fill in name and keywords), with `src/searches.js` locally (`node --env-file=.env src/searches.js …`),
or in the `searches` and `categories` tables in Supabase's Table Editor.

```bash
node src/searches.js                                  # list, the ones at the top run next
node src/searches.js add react-bangalore --keywords "react developer" \
     --category frontend --location "Bangalore, Karnataka, India"
node src/searches.js add devops-remote --keywords "devops engineer remote" --category devops --workplace remote
node src/searches.js category devops DevOps 50        # add a tab (slug, label, order)
node src/searches.js disable mobile-remote            # pause; enable brings it back
node src/searches.js remove mobile-remote
```

A search's `input` is passed to the Actor, merged over `defaults` in `config.yaml`, so any Actor
field works: `--input '{"datePosted":"pastWeek","limitPerSource":50}'`. `--priority` (default 100)
decides the order among searches that ran equally long ago, lower first. A new search runs in the
next scrape. With Docker: `docker compose run --rm scraper src/searches.js list`.

## Public job board on Vercel (live from Supabase)

`web/` is a static page. With a Supabase URL and anon key in `web/config.js`, it reads jobs live
from the view `public_jobs`, so new jobs show up right after each scrape without a redeploy.

1. **Run Scrape jobs once.** It creates the view `public_jobs` (jobs first seen in the last 30 days,
   public listing fields only) and turns on Row Level Security for `jobs` and `runs`. The public
   anon key can read only the view: no descriptions, raw Actor data, statuses or runs.
2. **Fill in `web/config.js`** with the Project URL and the anon (or publishable) key from
   Supabase → Project Settings → API, and push. Both are meant to be public.
   **Never** put the `service_role` / secret key or `DATABASE_URL` there.
3. **Vercel → Add New → Project → import this repo** and deploy. `vercel.json` tells Vercel to
   serve `web/` as static files with no install or build, so leave Root Directory at the repo root.
   Each push to `main` redeploys.

Supabase's Security Advisor may flag `public_jobs` as a "security definer" view. That is on
purpose: it is how the view shows only these columns while the table stays locked.

With `web/config.js` left empty, the page loads `jobs.json` instead, as on GitHub Pages below.

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
- Category tabs from the `categories` table, workplace filter (Remote / Hybrid / On-site), search
  box, and counts on each filter.
- Jobs load 25 at a time as you scroll, filtered in Supabase, so the page stays fast as the list grows.
  Cards off screen are skipped by the browser's renderer.
- Filters are kept in the URL, so you can share views like `…/job-scraper/?category=backend&workplace=remote`.
- Only public listing fields are published (title, company, location, category, workplace, job
  link, dates). No descriptions, raw data or job-poster details.
- Shows jobs first seen in the last `site.maxAgeDays` days (`config.yaml`). Light and dark mode, works on phones.

Preview locally: `DATABASE_URL=... node src/build-site.js && npx serve site`

## Run it locally (optional)

```bash
cp .env.example .env            # fill in APIFY_TOKEN and DATABASE_URL
docker compose build
docker compose run --rm scraper                        # next searches in the rotation
docker compose run --rm scraper src/run.js backend-remote # only some (or: all)
docker compose run --rm scraper src/searches.js        # list / add searches
docker compose run --rm scraper src/stats.js           # DB summary
```

Without Docker: `npm install`, then `npm run scrape` / `npm run stats` (with the same env vars set).

## Configure

Edit `config/config.yaml`:
- `defaults`: Actor input shared by all searches (location India, last 24 hours, 20 jobs each).
- `searchesPerRun`: how many searches each scrape runs (see Searches and categories above).
  A search's `category` groups its jobs on the site; `workplace: remote` marks every job it finds as
  remote (other jobs are marked remote or hybrid if their title or location says so).
- `site`: page title, how many days of jobs to show, max jobs.
- `filters`: drop jobs by title words or company name.
- `actor` / `source`: change the job source.

## How it works

Picks the `searchesPerRun` active searches with the oldest `last_run_at` (never-run first, newest added first among those). For each:
1. Runs the Actor and waits for it to finish.
2. Maps each item to a job row (`normalizeJob` in `src/scrape.js`). HTML entities are decoded and
   tracking parameters are stripped from URLs.
3. Drops jobs matching `filters`.
4. Inserts new jobs with `status = 'new'`. A job already stored (same `source` + `job_id`) only
   gets `last_seen_at` updated, so nothing is stored twice.
5. Logs the run (counts, Apify run ID, cost, error) in `runs`, and sets the search's `last_run_at`
   and `last_status`, which moves it to the back of the rotation (failed ones too).

If one search fails, the others still run; the command then exits with code 1, so the workflow shows as failed.

## Tables

- `jobs`: title, company, company_url, location, category, workplace, url, apply_url, posted_at, employment_type,
  seniority, salary, description, `raw` (the full Actor item as JSONB), status, first/last seen.
- `searches`: name, category, workplace, Actor `input`, is_active, priority, last run time and status.
- `categories`: slug, label, sort_order (the site's tabs).
- `apify_tokens`: Apify tokens with their monthly limit, used and remaining credit, and reset date.
- `runs`: one row per search per run, with the label of the Apify token it used.
- Views for the site (the only things the public key can read): `public_jobs`, `public_categories`,
  `public_job_counts`.

## Workflows

- `scrape.yml`: "Run workflow" button and a 3-hourly schedule that scrapes and stores jobs, then
  publishes the job board (when `PUBLISH_SITE=true`).
- `ci.yml`: on every push, checks syntax and that `config.yaml` loads.

## Keeping the public repo safe

The workflows that use secrets (Scrape jobs, Manage searches) only run on `main`, and only on a
schedule or from the Run workflow button, which needs write access. CI runs on pull requests with a
read-only token and no secrets, so a pull request from a fork can't read `DATABASE_URL` or the
Apify tokens, even if it changes a workflow file.

Repository settings that go with this (owner only, in GitHub's web UI):

- **Settings → Branches → Add branch ruleset** (or classic protection rule) for `main`: require a
  pull request before merging (0 approvals, so the owner can merge their own), require the status
  check `check`, block force pushes and deletions, and don't allow bypassing.
- **Settings → Actions → General → Fork pull request workflows**: "Require approval for all
  external contributors", so a stranger's PR doesn't run any workflow until the owner approves it.
- **Settings → Collaborators**: no one else with write access, so only the owner can merge.

## Telegram job alerts

A Telegram bot where each person picks keywords and gets only the new jobs that match, after every
scrape. Nobody gets every job.

- `/add react.js` matches React in the job title ("React.js", "ReactJS" and "React" are the same).
- `/add frontend engineer` matches the phrase, also written "Front-End Engineer".
- `/add python --anywhere` also looks in the job description.
- `/location remote` or `/location bengaluru` limits alerts to those places; `/location clear` undoes it.
- `/list`, `/remove react.js`, `/stop` and `/start`. `/start` also shows buttons for popular keywords.

A job is sent when any keyword matches (and a location, if set). Jobs first seen in the last
24 hours are checked and each job reaches a person once, so a new keyword also brings the past day's matches.

How it fits together: the bot's messages go to the Vercel function `web/api/telegram.mjs`, which saves
each person's keywords in the Supabase table `telegram_subscribers` with the secret key. After each
scrape, the Scrape jobs workflow runs `src/telegram-notify.js`, which matches new jobs and sends them.
Both tables have RLS with no policies, so the site's public key can't read them.

Setup:

1. In Telegram, message **@BotFather** → `/newbot`, pick a name and username, and copy the token.
2. Make up a webhook secret: 16 or more random letters, digits, `_` or `-`.
3. **Vercel → Project → Settings → Environment Variables**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
   `SUPABASE_URL` (same as in `web/config.js`) and `SUPABASE_SECRET_KEY` (Supabase → Project Settings →
   API Keys → secret key, or the legacy `service_role` key). Redeploy so the function picks them up.
4. **GitHub → Settings → Secrets and variables → Actions**: add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`.
5. Run **Scrape jobs** once, so the tables exist, then **Actions → Telegram bot setup → Run workflow**
   with your site URL. It prints the bot's link; open it and send `/start`.
