"""Scrape LinkedIn jobs with JobSpy (python-jobspy, no login or Apify) and POST them as JSON to a URL.

Run by .github/workflows/linkedin-jobspy.yml. Everything comes from environment variables so the target
never sits in this public repo:

  JOBS_POST_URL      where to POST, e.g. http://1.2.3.4:8080/jobs (required unless DRY_RUN=yes)
  JOBS_POST_TOKEN    optional; sent as "Authorization: Bearer <token>"
  JOBSPY_PROXIES     optional; comma-separated proxies (user:pass@host:port) if LinkedIn rate-limits the runner
  KEYWORDS           searches, comma-separated (default "software engineer")
  LOCATION           default "India"
  HOURS_OLD          only jobs posted in the last N hours (default 24)
  RESULTS            jobs wanted per search (default 50)
  DESCRIPTIONS       yes = also fetch each job's description (one extra request per job, much slower)
  BATCH_SIZE         jobs per POST (default 200)
  DRY_RUN            yes = don't POST, only write jobs.json
  OUT_FILE           where to write all jobs (default jobs.json)

Payload, one POST per batch:
  {"source": "linkedin", "scraper": "python-jobspy", "run_id": "...", "scraped_at": "...Z",
   "batch": 1, "batches": 2, "total": 230, "count": 200, "jobs": [{...}, ...]}
Each job: id, search, title, company, company_url, location, job_url, job_url_direct, date_posted,
job_type, is_remote, job_level, job_function, company_industry, salary_min, salary_max, salary_currency,
salary_interval, description.
"""

import json
import math
import os
import sys
import time
import uuid
from datetime import datetime, timezone

import pandas as pd
import requests
from jobspy import scrape_jobs

FIELDS = [
    "id", "search", "title", "company", "company_url", "location", "job_url", "job_url_direct", "date_posted",
    "job_type", "is_remote", "job_level", "job_function", "company_industry",
    "min_amount", "max_amount", "currency", "interval", "description",
]
RENAME = {"min_amount": "salary_min", "max_amount": "salary_max", "currency": "salary_currency",
          "interval": "salary_interval"}


def env(name, default=""):
    return (os.environ.get(name) or "").strip() or default


def clean(value):
    """JSON-safe value: NaN/NaT -> None, dates -> ISO strings, numpy scalars -> Python."""
    if value is None or (pd.api.types.is_scalar(value) and pd.isna(value)):
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if hasattr(value, "item"):  # numpy scalar
        return clean(value.item())
    if isinstance(value, str):
        return value.strip() or None
    return value


def scrape(keyword, location, hours_old, results, descriptions, proxies):
    df = scrape_jobs(
        site_name=["linkedin"],
        search_term=keyword,
        location=location,
        hours_old=hours_old,
        results_wanted=results,
        linkedin_fetch_description=descriptions,
        proxies=proxies or None,
        verbose=1,
    )
    jobs = []
    for row in df.to_dict(orient="records"):
        row["search"] = keyword
        job = {RENAME.get(k, k): clean(row.get(k)) for k in FIELDS}
        if job["company_url"] is None and row.get("company_url_direct"):
            job["company_url"] = clean(row["company_url_direct"])
        jobs.append(job)
    return jobs


def post(url, token, payload, attempts=4):
    headers = {"Content-Type": "application/json", "User-Agent": "job-scraper-jobspy"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    for attempt in range(1, attempts + 1):
        try:
            r = requests.post(url, data=json.dumps(payload), headers=headers, timeout=60)
            if r.status_code < 400:
                return r.status_code
            # Don't print the URL: it is a secret. The response body is cut short in case it echoes headers.
            print(f"  POST batch {payload['batch']} got HTTP {r.status_code}: {r.text[:200]!r}")
            if 400 <= r.status_code < 500 and r.status_code not in (408, 429):
                break           # the server rejected it; retrying won't help
        except requests.RequestException as e:
            print(f"  POST batch {payload['batch']} failed: {type(e).__name__}")
        if attempt < attempts:
            time.sleep(2 ** attempt)
    raise SystemExit(f"Could not POST batch {payload['batch']} after {attempts} attempts")


def main():
    keywords = [k.strip() for k in env("KEYWORDS", "software engineer").split(",") if k.strip()]
    location = env("LOCATION", "India")
    hours_old = int(env("HOURS_OLD", "24"))
    results = int(env("RESULTS", "50"))
    descriptions = env("DESCRIPTIONS", "no").lower() == "yes"
    batch_size = max(1, int(env("BATCH_SIZE", "200")))
    dry_run = env("DRY_RUN", "no").lower() == "yes"
    proxies = [p.strip() for p in env("JOBSPY_PROXIES").split(",") if p.strip()]
    url, token = env("JOBS_POST_URL"), env("JOBS_POST_TOKEN")
    if not url and not dry_run:
        raise SystemExit("JOBS_POST_URL is not set (add it as a repo secret) and DRY_RUN is not yes")

    jobs, seen, failed = [], set(), []
    for keyword in keywords:
        print(f"Searching LinkedIn: {keyword!r} in {location!r}, last {hours_old}h, up to {results}")
        try:
            found = scrape(keyword, location, hours_old, results, descriptions, proxies)
        except Exception as e:  # one blocked search shouldn't lose the others
            print(f"  failed: {type(e).__name__}: {e}")
            failed.append(keyword)
            continue
        new = [j for j in found if j["id"] not in seen]
        seen.update(j["id"] for j in new)
        jobs.extend(new)
        print(f"  {len(found)} jobs, {len(new)} not seen in an earlier search")

    out_file = env("OUT_FILE", "jobs.json")
    with open(out_file, "w") as f:
        json.dump(jobs, f, indent=1, ensure_ascii=False)
    print(f"{len(jobs)} jobs in total, written to {out_file}")

    if dry_run:
        print("DRY_RUN=yes: not posting")
    elif jobs:
        run_id = env("GITHUB_RUN_ID") or uuid.uuid4().hex
        scraped_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        batches = math.ceil(len(jobs) / batch_size)
        for i in range(batches):
            chunk = jobs[i * batch_size:(i + 1) * batch_size]
            status = post(url, token, {
                "source": "linkedin", "scraper": "python-jobspy", "run_id": run_id, "scraped_at": scraped_at,
                "searches": keywords, "location": location, "hours_old": hours_old,
                "batch": i + 1, "batches": batches, "total": len(jobs), "count": len(chunk), "jobs": chunk,
            })
            print(f"Posted batch {i + 1}/{batches} ({len(chunk)} jobs): HTTP {status}")
    else:
        print("No jobs found: nothing to post")

    if not jobs:
        # JobSpy logs LinkedIn errors (429, blocked) and returns nothing instead of raising.
        print("::warning::No jobs found. If the log above shows LinkedIn errors, the runner may be blocked: "
              "set JOBSPY_PROXIES")
    if failed and len(failed) == len(keywords):
        sys.exit("Every search failed (LinkedIn may be blocking the runner; try JOBSPY_PROXIES)")
    if failed:
        print(f"::warning::{len(failed)} search(es) failed: {', '.join(failed)}")


if __name__ == "__main__":
    main()
