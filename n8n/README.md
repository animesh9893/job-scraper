# LinkedIn hiring-alert posts with n8n

Each person (Animesh, Sachin, …) runs their own n8n on Railway with their own LinkedIn and email. The flow:

1. **Scrape** (GitHub Actions, every 3 hours): new jobs are stored, tagged and ranked.
2. **Write posts** (`src/linkedin-posts.js`, same run): the best new jobs are split between the people in
   `config/config.yaml` → `linkedin.people`, so each gets a different set, and one post is written for each.
   They show on the private page `/posts.html` and, as data, in the Supabase view `public_linkedin_posts`.
3. **Ping**: the same run calls each person's n8n webhook (GitHub secret `N8N_WEBHOOK_<ID>`) with the post ID.
4. **Fetch and check** (n8n): reads the post from Supabase and checks it against the template (first line,
   numbered job lines, one link to its `/alert.html` page, 1 to 5 hashtags, at most 3,000 characters).
5. **Email approval** (n8n): emails you the post with Approve and Decline buttons, and waits.
6. **Post** (n8n): on Approve, posts it to your LinkedIn with your LinkedIn credential.
7. **Report back** (n8n): tells the site the post was posted (with its LinkedIn link) or declined, so the posts
   page shows it.

Each job goes into one post only, ever, so the two of you never post the same opening.

## Setup for each person

Do this once per person; `<ID>` is their id in `linkedin.people` in capitals (`ANIMESH`, `SACHIN`).

1. **A token.** Make a long random string, e.g. `openssl rand -hex 24`. It proves that pings and reports come
   from your own n8n.
2. **Import the workflow.** In n8n: Workflows → Import from file → `n8n/hiring-alert-workflow.json`.
3. **Fill in the Settings node:** `person` (your id, e.g. `sachin`), `siteUrl` (the job board), `supabaseUrl`
   and `supabaseKey` (the public values from `web/config.js`), `approvalEmail` (where approval emails go) and
   `token` (step 1).
4. **Webhook auth.** Open the Webhook node → Authentication: Header Auth → new credential with name
   `Authorization` and value `Bearer <token>`.
5. **Email.** Open "Ask for approval" and "Report failed check" and pick a Gmail credential (Google sign-in in
   n8n). Any other email node with "Send and Wait for Response" works too.
6. **LinkedIn.** Create an app at linkedin.com/developers on a LinkedIn Page you own, add the products "Share on
   LinkedIn" and "Sign In with LinkedIn using OpenID Connect", put n8n's OAuth redirect URL in the app, then open
   "Post to LinkedIn", create a LinkedIn credential with the app's client ID and secret, and pick yourself under
   Person. The login lasts 60 days; reconnect it in n8n about every two months.
7. **Activate** the workflow and copy its Production URL from the Webhook node.
8. **GitHub secrets** (repo → Settings → Secrets and variables → Actions): `N8N_WEBHOOK_<ID>` = that URL,
   `POST_TOKEN_<ID>` = the token.
9. **Vercel env** (project → Settings → Environment Variables): `POST_TOKEN_<ID>` = the same token, plus
   `SUPABASE_URL` and `SUPABASE_SECRET_KEY` if the Telegram bot setup didn't already add them. Redeploy.

A person without `N8N_WEBHOOK_<ID>` still gets posts on `/posts.html`; nothing is sent to them.

## What n8n receives and reads

Ping from GitHub: `POST <webhook URL>` with `Authorization: Bearer <token>` and

```json
{ "postId": 12, "person": "sachin", "jobs": 6, "alertUrl": "https://…/alert.html?id=12" }
```

The post itself: `GET <supabaseUrl>/rest/v1/public_linkedin_posts?id=eq.12&person=eq.sachin` with header
`apikey: <supabaseKey>` returns `[{ "id", "person", "status", "body", "linkedinUrl", "createdAt", "postedAt", "jobs" }]`.

Report back: `POST <siteUrl>/api/post-status` with `Authorization: Bearer <token>` and
`{ "id": 12, "status": "posted", "linkedinUrl": "https://www.linkedin.com/feed/update/…" }` or
`{ "id": 12, "status": "skipped" }`. Only a draft changes, and only with the token of the post's own person.

## The template

```
🚀 Hiring alert: 6 new openings at 5 companies

1. Google: Senior Software Engineer · Bengaluru
2. Razorpay: Backend Engineer (Golang) · Bengaluru (Remote)
…

🔥 In demand: Go, React, AWS

👉 Every opening with its apply link: https://…/alert.html?id=12

#hiring #softwareengineering #techjobs #go #react
```

It's written by `buildPost()` and checked by `checkPost()` in `src/linkedin-posts.js`. The workflow's "Check
against template" node runs the same checks; change both together.
