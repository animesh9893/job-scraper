# Job Scraper → LinkedIn Job Posts: Project Handoff

Repo: GitHub (private) · local copy: `/Users/animeshshrivatri/Documents/projects/job-scraper`

## Goal

Run the flow by hand (a cron job later). It should:

1. Fetch fresh jobs, starting with LinkedIn through an existing Apify Actor.
2. Store them in Supabase (Postgres) without duplicates.
3. *(later)* Extract skills and write a short post, e.g. "Company X is hiring for Y, skills: …" plus skill hashtags.
4. **Public job board on GitHub Pages**: category and remote filters, shareable links. Built; turned on with `PUBLISH_SITE=true`.
5. *(later)* Publish to a **LinkedIn Company Page**, so the posts are not tied to the personal profile.

**Current scope:** steps 1, 2 and 4. LinkedIn posting comes later.

**Searches:** frontend, backend, fullstack and mobile × (India, India + remote), 20 jobs each, last 24 hours (`defaults` + `searches` in config.yaml). Jobs get a `category` from their search. `workplace` is `remote` if any remote search finds the job, or detected from title/location (remote/hybrid), otherwise NULL.

**Job board:** `src/build-site.js` exports public fields of jobs first seen in the last 30 days to `site/jobs.json` and copies in `web/index.html` (vanilla JS: category tabs, workplace filter, search, filters kept in the URL, dark mode). The `publish` job in scrape.yml deploys it with actions/deploy-pages; it only runs when the repo variable `PUBLISH_SITE` is `true`. **Pages needs a public repo on a free plan** (or GitHub Pro); Settings → Pages → Source must be "GitHub Actions". URL: https://animesh9893.github.io/job-scraper/

---

## Decisions made

| Topic | Decision | Why |
|---|---|---|
| Scraper | Use an existing Apify Actor, `curious_coder/linkedin-jobs-scraper` | ~$1–2 per 1,000 jobs. Its developer fixes it when LinkedIn changes the page. Building our own saves only ~$1–6/month at our volume. Revisit at more than 100k jobs/month. |
| Running | Our own JS program calls the Actor and waits for it (`apify-client` `.call()`), started by hand. No Apify schedules. | User wants to run it on demand. A cron job can come later. |
| Storage | **Supabase (Postgres)** via `pg`, connection string in `DATABASE_URL` | Persistent across GitHub Actions runs, browser table viewer, API for the later presentation layer. (Was SQLite at first.) |
| Hosting | **GitHub Actions**, private repo: "Run workflow" button, cron later | Nothing to maintain locally. Docker kept for optional local runs |
| Packaging | Docker + docker-compose for local runs. Config is mounted from the host. | Easy to configure |
| LLM (later) | Start with a fixed skill list (free, same result every time). Optional fallback: Claude CLI, Gemini/Groq free tier, or Ollama. | Saves cost |
| Where to post (later) | LinkedIn Company Page, e.g. "Bangalore Tech Jobs" | Posts show the page name, not the person; admins aren't shown publicly. No API for LinkedIn Groups. |
| A second personal account | **No** | User Agreement §2.1: "you will only have one LinkedIn account, which must be in your real name" |
| n8n | Possible later for orchestration (Apify node, Remove Duplicates, LinkedIn node) | Not used now; plain Node.js instead |

---

## What is built (steps 1–2)

```
job-scraper/
├─ .github/workflows/scrape.yml  # "Run workflow" button (inputs.searches); secrets APIFY_TOKEN, DATABASE_URL
├─ .github/workflows/ci.yml      # on push: syntax check + config loads
├─ Dockerfile, docker-compose.yml  # optional local runs (no native deps anymore)
├─ .env.example          # APIFY_TOKEN, DATABASE_URL
├─ config/config.yaml    # actor, source, timeoutSecs, searches[], filters
└─ src/
   ├─ run.js     # entry: each search → normalize → filter → save → log run; writes GitHub step summary
   ├─ scrape.js  # runSearch (Actor call + dataset), normalizeJob, cleanText, passesFilters
   ├─ db.js      # pg Pool, creates tables on start, saveJobs (ON CONFLICT, RETURNING xmax=0), runs
   ├─ config.js  # loads YAML config, requireEnv
   └─ stats.js   # jobs by status, last runs, latest jobs
```

### Commands
**GitHub:** Actions → *Scrape jobs* → *Run workflow* (blank = all searches, or `backend-india,backend-remote`).

**Local (optional):**
```bash
cp .env.example .env                                   # APIFY_TOKEN, DATABASE_URL
docker compose build
docker compose run --rm scraper                        # all searches
docker compose run --rm scraper src/run.js backend-remote # only some searches
docker compose run --rm scraper src/stats.js           # DB summary
```

### Behaviour
- Each entry in `config.yaml → searches` is one Actor run. Its `input` is passed to the Actor unchanged.
- Jobs are keyed by `(source, job_id)`. A job already in the DB only gets `last_seen_at` updated.
- New jobs get `status = 'new'`. Planned flow: `new → drafted → posted / skipped`.
- The `runs` table records each search: Apify run ID, found/new/filtered counts, `cost_usd`, error.
- If one search fails, the rest still run. The program exits with code 1 if any search failed.
- `descriptionText` HTML codes (`&nbsp;`, `&amp;`) are converted to plain text. Tracking parameters are removed from job and company URLs.
- The full Actor item is kept in `jobs.raw` (JSONB), in case more fields are needed later.
- Tables are created automatically on the first run (`CREATE TABLE IF NOT EXISTS`).

### DB schema (Postgres)
- `jobs`: source, job_id (together the primary key), title, company, company_url, location, url, apply_url, posted_at, employment_type, seniority, salary, description, search_name, raw JSONB, status, first_seen_at/last_seen_at TIMESTAMPTZ
- `runs`: id BIGSERIAL, search_name, actor, apify_run_id, status, items_found, items_new, items_skipped, cost_usd NUMERIC, error, started_at, finished_at

### What has been checked
- **Real Actor run** with the config's first search (5 jobs, Bangalore backend) succeeded in 7s for about $0.01.
- **That real output, run through the project code:** 5 new jobs on the first run, 0 on the second. All main fields are filled in.
- **`applyUrl` and `salary`** come back empty (`""`) from the logged-out LinkedIn pages. They're stored as NULL.
- **Error cases:** a missing token or an unknown search name gives a clear error and exit code 1.
- **Against real Postgres 16:** run.js and stats.js tested with the real Actor items through a stand-in Apify client. 5 new jobs, then 0 on a re-run. A failing search is recorded and the others still run (exit 1). The GitHub step summary table renders.
- **Not yet run:** an actual GitHub Actions run with real secrets, and a Supabase connection. Needs the secrets set first.

---

## Resolved: Docker build on an Apple Silicon Mac
Building `better-sqlite3` from source failed on linux/arm64 (no python3, make or g++ in the slim image). Moving to Supabase with `pg`, which is pure JS, removed the native dependency, so the simple Dockerfile works everywhere.

---

## Next steps

### Now
1. Create a Supabase project and add GitHub secrets `APIFY_TOKEN` and `DATABASE_URL` (the Session pooler string). Then Actions → Scrape jobs → Run workflow.
2. Edit the searches in `config/config.yaml` to the real keywords and locations. The two current ones are samples, 25 jobs each.

### Next phases
| Phase | Work |
|---|---|
| 3. Skills + draft | `src/skills.js` (skill list, ~300 skills; optional LLM via `LLM_PROVIDER=none/claude-cli/gemini/groq/ollama`), `src/post.js` (template + 3–5 hashtags). Set `status = 'drafted'` and store `skills` and `post_text`. |
| 4. Review | Approve / edit / skip drafts (command line first; UI is part of the presentation-layer discussion) |
| 5. Publish | `PUBLISH_MODE=manual` (copy-paste) / `webhook` (Zapier or Make posting to the Company Page) / `linkedin_api`. Max 3–5 posts per run, at least 60 minutes apart, dry run on by default. |
| Later | Cron job; salary range (AmbitionBox/Glassdoor/Levels.fyi, cached by role+city+level, worded as "estimated"); other job sources |

### LinkedIn setup the user needs to do
1. **Create the Company Page** (For Business → Create a Company Page). Takes about 5 minutes. Don't invite connections; don't add it to your own Experience section.
2. **Create a developer app** at developer.linkedin.com, linked to that page.
3. **Request the Community Management API** (`w_organization_social`). It takes days to weeks, and LinkedIn usually grants it only to registered businesses. Until then: manual posting, or Zapier/Make.

### LinkedIn API facts (checked against the docs)
- Posting through the API is free; no Premium needed.
- Share on LinkedIn limits: 150 requests per member per day, 100,000 per app per day, reset at midnight UTC; going over returns 429. Actual limits per endpoint are shown on the app's Analytics tab.
- The access token lasts 60 days, and self-serve apps usually get no refresh token.
- Endpoint: `POST https://api.linkedin.com/rest/posts` with headers `LinkedIn-Version: YYYYMM` and `X-Restli-Protocol-Version: 2.0.0`. Body: `author` (`urn:li:person:…` or `urn:li:organization:…`), `commentary`, `visibility: PUBLIC`, `distribution`, `lifecycleState: PUBLISHED`. Success is 201, with the post ID in the `x-restli-id` header.
- `commentary` can be up to 3,000 characters. Escape `( ) [ ] { } < > @ | ~ _ *` with a backslash.
- The Groups API is not available, and the Job Posting API is for partners only.

### Risks to remember
- LinkedIn's User Agreement §8.2 forbids scraping (item 2) and redistributing LinkedIn content (item 4). Apify scrapes logged out, so the personal account isn't directly involved, but posting LinkedIn-sourced jobs back onto LinkedIn links them to the page.
- To lower that risk: keep the volume low, write posts in our own words and link to the original job, and consider other sources (company career pages, Greenhouse/Lever boards, Naukri/Indeed). To switch source, change `actor`/`source` in the config and add any new field names to `normalizeJob`.

### Costs (Apify Free/Starter plan rates)
- Scraping through the Store Actor: ~$1–2 per 1,000 jobs. About 150 jobs/day comes to roughly $3–9/month. The Free plan includes $5/month of usage.
- LinkedIn API: $0. LLM: under $1/month. Zapier or Make: free tier if used.
