# Job Scraper

Fetches jobs with an Apify Actor (default: `curious_coder/linkedin-jobs-scraper`), stores them in
Supabase (Postgres) and publishes a public job board at **https://jobs.krawlr.xyz**.

Searches and categories (the tabs on the site) live in Supabase. The first run adds 8 starting
searches: frontend, backend, full stack and mobile developer jobs in India, each in an "any workplace"
and a "remote" variant. Each run does only `searchesPerRun` of them (about $0.04 each, or `all`), the ones
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

Nothing runs on a GitHub timer. n8n starts each workflow when it should run (see Triggers below).

### Triggers (n8n)

There are no `schedule:` crons in this repo: GitHub's timer is best effort (runs started 1 to 2.5 hours
late and some were skipped). Each job is its own workflow with a `workflow_dispatch` trigger, so n8n (or
the Run workflow button) starts exactly what it needs, when it needs it:

| Workflow | File | What it does | Inputs |
| --- | --- | --- | --- |
| Scrape jobs | `scrape.yml` | LinkedIn job searches, company linking, tags; then Telegram alerts and LinkedIn posts | `searches`, `alerts` (yes/no), `posts` (yes/no), `force_posts` |
| Glassdoor salaries | `salaries.yml` | Salaries per role for companies that have none yet. Not tied to the scrape | `companies` (blank, a number, or `all`), `refresh` (yes/no) |
| Telegram alerts | `telegram-alerts.yml` | Sends subscribers the last 24 hours' matching jobs | none |
| LinkedIn posts | `linkedin-posts.yml` | Writes each person's post and pings their n8n. No Apify cost | `force_posts` |
| Manage searches | `searches.yml` | Add / list / disable searches | see the form |
| Telegram bot setup | `telegram.yml` | Points the bot at its webhook | `api_url` |

To start one from n8n, an HTTP Request node sends:

```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/<file>/dispatches
Authorization: Bearer <token with Actions: read and write on this repo>
Accept: application/vnd.github+json

{"ref": "main", "inputs": {"companies": "5"}}
```

`inputs` is optional (every input has a default) and its values are strings, e.g.
`{"ref": "main", "inputs": {"alerts": "no", "posts": "no"}}` for a scrape alone. Each workflow has its own
concurrency group, so a second start waits for the running one instead of doubling up; the scrape and the
salary fetch can run at the same time (they share the Apify tokens, see below).

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

## Companies and premium companies

Every job is linked to a row in the `companies` table after each scrape: by its LinkedIn company page
first, then by name with suffixes like "Pvt. Ltd." and "India" dropped, so "Google India Pvt. Ltd." and
"Google" are one company. Companies seen for the first time are added automatically.

Premium companies (Google, Microsoft, Amazon, Coinbase and more, listed in `src/seed-data.js`) show as
chips on the site, and the ones with a LinkedIn company ID are searched directly: in groups of 10, as
searches `premium-1`, `premium-2`, … that run every 6 hours on top of the rotation and ask only for jobs
posted in the last 7 hours, since the Actor bills every job it returns. Change this under `premium` in
`config.yaml`.

```bash
node src/companies.js                                  # premium companies, then the ones with most jobs
node src/companies.js add flipkart --alias "Flipkart Internet"                       # add an alias (or --linkedin-id)
node src/companies.js add groww --name Groww --linkedin-slug groww.in --premium     # a new premium company
node src/companies.js unpremium oracle                 # stop searching it and drop its chip
```

A company's LinkedIn ID is the number after `f_C=` in the URL of a LinkedIn job search filtered by
that company (some have several, like Razorpay's `2770855,13616753,3788927`; keep them all). You don't
have to look it up: after each scrape, every company learns its LinkedIn page and logo from its jobs,
and for up to `premium.lookupsPerRun` premium companies without an ID the scraper reads their public
LinkedIn page (about $0.0015 each), saves the ID and employee count, and adds them to the premium
searches. A premium company that hasn't shown up in any job yet needs `--linkedin-slug` (the part after
`linkedin.com/company/`) for this.

### Glassdoor salaries

Every company on the site (premium ones and any company with a job in the last 30 days) gets its salaries
from Glassdoor for the roles under `salaries.roles` in `config.yaml`, in India, with the Actor
`axlymxp/glassdoor-salary-scraper`, and kept in `company_salaries`. A company that already has salaries
isn't fetched again, unless the run has `refresh` = `yes` (then ones older than `salaries.refreshDays`, 14, are
re-fetched too) or you queue it with `refresh-salaries` below. Each **Glassdoor salaries** run (`salaries.yml`, `src/salaries.js`) fetches up to
`salaries.companiesPerRun` companies without salaries: never-fetched ones first, premium first, then the ones with most recent jobs. Each costs $0.02 plus $0.006 per role
Glassdoor has (about $0.16 for a big company with 25 roles; roles it doesn't have cost nothing). Like the
searches, it moves to the next Apify token when one runs out of credit.

Salaries are yearly total pay in the company's currency (10th percentile, median, 90th percentile), also
converted to USD with that day's rate (Frankfurter/ECB, table `fx_rates`). If Glassdoor matches the name to a
different employer, the salaries are skipped; if it has no such employer, that answer is cached too. On the
site, each job shows its company's range (lowest to highest median across roles) and opens a list of every
role, highest first; picking a company shows the list above its jobs.

To fetch every company at once (including ones with no recent jobs), run Glassdoor salaries with
`companies` = `all`, or locally `node src/salaries.js all`.
It stops when no Apify token has credit left; the companies it didn't reach are first in line next time.

```bash
node src/companies.js salaries                 # fetch status per company
node src/companies.js salaries razorpay        # one company's roles
node src/companies.js refresh-salaries razorpay   # fetch again in the next salaries run (or: all)
```

## Public job board at jobs.krawlr.xyz (live from Supabase)

The board lives at **https://jobs.krawlr.xyz**. Two hosts, each with one job:

| What | Where | Config |
| --- | --- | --- |
| Pages (`web/` minus `web/api`) | Netlify, custom domain `jobs.krawlr.xyz` | `netlify.toml`; `siteUrl` in `config/config.yaml` |
| Functions (`web/api/*.mjs`: Telegram webhook, `/api/post-status`) | Vercel, `job-scraper-web-beryl.vercel.app` | `vercel.json` / `web/vercel.json`; `apiUrl` in `config/config.yaml` |

- LinkedIn posts, the post picture and Telegram alerts link to `siteUrl`. The Telegram webhook and n8n's
  post reports use `apiUrl`.
- `netlify.toml` builds `dist/` from `web/` without `web/api`, proxies `jobs.krawlr.xyz/api/*` to Vercel
  (so either URL reaches the functions), and sends the old `*.netlify.app` address to the custom domain.
  Git-connected Netlify deploys read it on every push to `main`; from the CLI, run
  `netlify deploy --build --prod` in the repo root.
- On Vercel every page now redirects (301) to the same path on `jobs.krawlr.xyz`, so old post links keep
  working; only `/api/*` is still served there. The redirect is in both `vercel.json` (Root Directory = repo
  root) and `web/vercel.json` (Root Directory = `web`), whichever the Vercel project uses.
- Moving the domain again: change `siteUrl`, the canonical/`og:url` tags in `web/*.html`, `web/sitemap.xml`,
  `web/robots.txt` and the redirect targets in `netlify.toml` / `vercel.json`. Moving the API: change `apiUrl`,
  the `/api/*` proxy in `netlify.toml`, then run **Telegram bot setup** again.

### Analytics (Umami)

Every page loads Umami (`data-website-id` in each page's `<head>`). Page views show under **Pages**
(`/job.html?id=…` is one job). `web/analytics.js` adds custom events, under **Events** (open an event to break
it down by its properties):

| Event | When | Properties |
| --- | --- | --- |
| `job-view` | a job page loads | `id`, `title`, `company`, `location`, `category`, `from` (utm_source or the linking site) |
| `apply-click` | Apply on LinkedIn / Apply now | same as `job-view` |
| `board-filter` | a board filter or search held for 2 s | `category`, `workplace`, `company`, `premium`, `q` |
| `alert-view` | a hiring-alert page loads | `id` |

Telegram alert links carry `utm_source=telegram`, so they show under Sources → UTM too.

`web/` is a static page. With a Supabase URL and anon key in `web/config.js`, it reads jobs live
from the view `public_jobs`, so new jobs show up right after each scrape without a redeploy.

1. **Run Scrape jobs once.** It creates the view `public_jobs` (jobs first seen in the last 30 days,
   public listing fields only) and turns on Row Level Security for `jobs` and `runs`. The public
   anon key can read only the view: no descriptions, raw Actor data, statuses or runs.
2. **Fill in `web/config.js`** with the Project URL and the anon (or publishable) key from
   Supabase → Project Settings → API, and push. Both are meant to be public.
   **Never** put the `service_role` / secret key or `DATABASE_URL` there.
3. **Netlify → Add new site → Import an existing project → this repo**. It reads `netlify.toml`, so no
   build settings are needed. Add the custom domain under Domain management. For the functions,
   **Vercel → Add New → Project → import this repo** too (see the table above).

Supabase's Security Advisor may flag `public_jobs` as a "security definer" view. That is on
purpose: it is how the view shows only these columns while the table stays locked.

With `web/config.js` left empty, the page loads `jobs.json` instead (see the static copy below).

What the board has:
- Category tabs from the `categories` table, workplace filter (Remote / Hybrid / On-site), search
  box, and counts on each filter.
- Jobs load 25 at a time as you scroll, filtered in Supabase, so the page stays fast as the list grows.
  Cards off screen are skipped by the browser's renderer.
- Filters are kept in the URL, so you can share views like `jobs.krawlr.xyz/?category=backend&workplace=remote`.
- Only public listing fields are published (title, company, location, category, workplace, job
  link, dates). No descriptions, raw data or job-poster details.
- Shows jobs first seen in the last `site.maxAgeDays` days (`config.yaml`). Light and dark mode, works on phones.

Static copy without Supabase keys (the old GitHub Pages build, no longer deployed):
`DATABASE_URL=... node src/build-site.js && npx serve site`

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
- `defaults`: Actor input shared by all searches (location India, last 24 hours, 40 jobs each).
- `searchesPerRun`: how many searches each scrape runs, or `all` (see Searches and categories above).
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

## Tags, company index and posts

After each scrape, every new job gets keyword tags from its title and description (`src/tags.js`, no AI): a
`role` (frontend, backend, mobile, data, ml, devops, …), a `level` (junior, mid, senior, lead, staff, …) and the
`tags` it names (React, Go, AWS, …). To tag a new technology, add it to `STACK` in that file. The site shows the
first three tags on each job.

- `company_index` (view): a 0 to 100 score per company from its Glassdoor rating, premium status, jobs in the
  last 7 days and best median pay. The weights are written next to the view in `src/db.js`.
- `post_candidates` (view): jobs from the last 3 days not posted yet, at most 2 per company and one per title (also
  skipping titles a company had in a post in the last 30 days), scored by company index plus freshness.
- `posts` and `post_jobs`: LinkedIn hiring-alert posts and their jobs. After each scrape,
  `src/linkedin-posts.js` splits the best new jobs between the people in `config.yaml` → `linkedin.people`
  (each gets different jobs) and writes one post for each, then pings each person's n8n to send it to them on
  Telegram for approval and post it. Setup and the n8n workflow: [n8n/README.md](n8n/README.md).
- `web/posts.html`: password page showing everyone's posts with a copy button. The password is checked in the
  browser only (`POSTS_PASSWORD_SHA256` in `web/config.js`); the posts are public data.
- `web/api/post-status.mjs`: where n8n reports a post as posted or declined.
- `web/alert.html?id=<post id>`: the page a post links to, listing its openings.

## Tables

- `jobs`: title, company, company_url, location, category, workplace, url, apply_url, posted_at, employment_type,
  seniority, salary, description, `raw` (the full Actor item as JSONB), status, first/last seen.
- `searches`: name, category, workplace, Actor `input`, is_active, priority, last run time and status.
- `categories`: slug, label, sort_order (the site's tabs).
- `apify_tokens`: Apify tokens with their monthly limit, used and remaining credit, and reset date.
- `runs`: one row per search per run (and per salary fetch, as `salaries:<company>`), with the label of the
  Apify token it used and the cost.
- `companies`: one row per employer, premium or not, with its LinkedIn ID, logo and salary fetch status.
- `company_salaries`: Glassdoor pay per company and job title, yearly, in its currency and in USD.
- `fx_rates`: USD value of each currency, refreshed daily when salaries are fetched.
- `posts`, `post_jobs`: LinkedIn hiring-alert posts and the jobs in each.
- Views for the site (the only things the public key can read): `public_jobs`, `public_categories`,
  `public_job_counts`, `public_companies`, `public_company_salaries`, `public_alert_jobs`, `public_linkedin_posts`.

## Workflows

- `scrape.yml`, `salaries.yml`, `telegram-alerts.yml`, `linkedin-posts.yml`, `searches.yml`, `telegram.yml`:
  started by hand or from n8n (Triggers, above). None has a timer.
- `ci.yml`: on every push, checks syntax and that `config.yaml` loads.

## Keeping the public repo safe

The workflows that use secrets (all but CI) only run on `main`, and only from the
Run workflow button or its API, which needs write access. CI runs on pull requests with a
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
scrape (or when you run **Telegram alerts**), `src/telegram-notify.js` matches new jobs and sends them.
Both tables have RLS with no policies, so the site's public key can't read them.

Setup:

1. In Telegram, message **@BotFather** → `/newbot`, pick a name and username, and copy the token.
2. Make up a webhook secret: 16 or more random letters, digits, `_` or `-`.
3. **Vercel → Project → Settings → Environment Variables**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
   `SUPABASE_URL` (same as in `web/config.js`) and `SUPABASE_SECRET_KEY` (Supabase → Project Settings →
   API Keys → secret key, or the legacy `service_role` key). Redeploy so the function picks them up.
4. **GitHub → Settings → Secrets and variables → Actions**: add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`.
5. Run **Scrape jobs** once, so the tables exist, then **Actions → Telegram bot setup → Run workflow**
   (it uses `apiUrl` from `config/config.yaml`; or type another API URL). It prints the bot's link; open it and send `/start`.
