# LinkedIn hiring-alert posts with n8n

Each person (Animesh, Sachin, …) runs their own n8n on Railway with their own LinkedIn and Telegram. The flow:

1. **Scrape** (GitHub Actions, every 3 hours): new jobs are stored, tagged and ranked.
2. **Write posts** (`src/linkedin-posts.js`, same run): the best new jobs are split between the people in
   `config/config.yaml` → `linkedin.people`, so each gets a different set, and one post is written for each.
   They show on the private page `/posts.html` and, as data, in the Supabase view `public_linkedin_posts`.
3. **Ping**: the same run calls each person's n8n webhook (GitHub secret `N8N_WEBHOOK_<ID>`) with the post ID.
4. **Fetch and check** (n8n): reads the post from Supabase and checks it against the template (first line,
   numbered job lines, at most one link per job and one link to its `/alert.html` page at the end, 1 to 12 hashtags, at most 3,000 characters).
5. **Telegram approval** (n8n): sends you the post on Telegram with Approve and Decline buttons, and waits.
6. **Post** (n8n): on Approve, fetches the post's picture (view `public_post_images`) and posts both to your
   LinkedIn with your LinkedIn credential.
7. **Report back** (n8n): tells the site the post was posted (with its LinkedIn link) or declined, so the posts
   page shows it.

Each job goes into one post only, ever, so the two of you never post the same opening. A job is also skipped when
the same company's same title (ignoring case and punctuation) was in a post in the last 30 days, or is listed
twice in the same scrape: LinkedIn often lists one opening under new ids or once per city.

Each post gets a picture: a 1200×1200 card listing its jobs (company, pay, title, place) and the site, drawn by
`src/post-image.js` when the post is written and stored in `posts.image`.

## Setup for each person

Do this once per person; `<ID>` is their id in `linkedin.people` in capitals (`ANIMESH`, `SACHIN`).

1. **A token.** Make a long random string, e.g. `openssl rand -hex 24`. It proves that pings and reports come
   from your own n8n.
2. **Import the workflow.** In n8n: Workflows → Import from file → `n8n/hiring-alert-workflow.json`.
3. **Fill in the Settings node:** `person` (your id, e.g. `sachin`), `siteUrl` (the job board), `supabaseUrl`
   and `supabaseKey` (the public values from `web/config.js`), `telegramChatId` (yours: message @userinfobot on Telegram) and
   `token` (step 1).
4. **Webhook auth.** Open the Webhook node → Authentication: Header Auth → new credential with name
   `Authorization` and value `Bearer <token>`.
5. **Telegram.** Make a new bot for approvals with @BotFather (not the job-alerts bot) and send it any message
   so it may write to you. Open "Ask for approval" and "Report failed check" and create a Telegram credential
   with the bot's token.
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

**Trying it by hand:** click **Execute workflow** in n8n. Without a ping it fetches your newest draft post and runs
the rest of the flow on it (so Approve really posts it). To test the webhook itself, arm it the same way and send
`POST <Test URL>` with your `Authorization: Bearer <token>` header and `{ "postId": 12 }`.

**Already imported an older version?** Rather than re-importing (which loses your credentials and Person), add the
picture by hand: between "Approved?" (true) and "Post to LinkedIn" add

- an **HTTP Request** node "Fetch picture": GET `{{ $('Settings').first().json.supabaseUrl }}/rest/v1/public_post_images`
  with query `id` = `eq.{{ $node['Check against template'].json.id }}` and `select` = `image`, and header `apikey` =
  `{{ $('Settings').first().json.supabaseKey }}`;
- a **Convert to File** node "Picture to file": Move Base64 String to File, source property `image`, output field
  `data`, file name `hiring-alert.png`, MIME type `image/png`;

then in "Post to LinkedIn" set Media Category to **Image** with input binary field `data`.

## What n8n receives and reads

Ping from GitHub: `POST <webhook URL>` with `Authorization: Bearer <token>` and

```json
{ "postId": 12, "person": "sachin", "jobs": 6, "alertUrl": "https://…/alert.html?id=12" }
```

The post itself: `GET <supabaseUrl>/rest/v1/public_linkedin_posts?id=eq.12&person=eq.sachin` (or, run by hand,
`?person=eq.sachin&status=eq.draft&order=createdAt.desc&limit=1`) with header
`apikey: <supabaseKey>` returns `[{ "id", "person", "status", "body", "linkedinUrl", "createdAt", "postedAt", "jobs" }]`.

Report back: `POST <siteUrl>/api/post-status` with `Authorization: Bearer <token>` and
`{ "id": 12, "status": "posted", "linkedinUrl": "https://www.linkedin.com/feed/update/…" }` or
`{ "id": 12, "status": "skipped" }`. Only a draft changes, and only with the token of the post's own person.

## The template

```
🚀 𝗛𝗶𝗿𝗶𝗻𝗴 𝗮𝗹𝗲𝗿𝘁: 𝟲 𝗻𝗲𝘄 𝗼𝗽𝗲𝗻𝗶𝗻𝗴𝘀 𝗮𝘁 𝟱 𝗰𝗼𝗺𝗽𝗮𝗻𝗶𝗲𝘀

1. 𝗚𝗼𝗼𝗴𝗹𝗲: Senior Software Engineer · 𝘉𝘦𝘯𝘨𝘢𝘭𝘶𝘳𝘶
💰 ~₹45L/yr on Glassdoor
🔗 https://www.linkedin.com/jobs/view/4123456789

2. 𝗥𝗮𝘇𝗼𝗿𝗽𝗮𝘆: Backend Engineer (Golang) · 𝘉𝘦𝘯𝘨𝘢𝘭𝘶𝘳𝘶 (𝘙𝘦𝘮𝘰𝘵𝘦)
🔗 https://www.linkedin.com/jobs/view/4123456790

…

🔥 𝗜𝗻 𝗱𝗲𝗺𝗮𝗻𝗱: Go, React, AWS

👉 𝗔𝗹𝗹 𝗼𝗳 𝘁𝗵𝗲𝗺 𝗼𝗻 𝗼𝗻𝗲 𝗽𝗮𝗴𝗲: https://…/alert.html?id=12

#hiring #softwareengineering #techjobs #jobsearch #backenddeveloper #go #react #aws #bengalurujobs #remotejobs
```

LinkedIn has no bold or italic, so the heading, labels and company names use Unicode bold letters and places use
Unicode italic ones, the way LinkedIn formatters do it. Job titles and hashtags stay plain so LinkedIn search finds
them.

Hashtags: the ones in `linkedin.hashtags`, then the jobs' two most common roles, three most named technologies and
two most common cities, plus `#remotejobs` when a job is remote, up to `linkedin.maxHashtags` (10).

Each job has its own link (its LinkedIn job page, or its apply link for other sources) and, when known, its pay:
the salary the listing shows, else the Glassdoor median for the closest role at that company (`payFor()`). Jobs
without either just skip that line.

It's written by `buildPost()` and checked by `checkPost()` in `src/linkedin-posts.js`. The workflow's "Check
against template" node runs the same checks; change both together.
