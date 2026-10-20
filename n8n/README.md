# LinkedIn hiring-alert posts with n8n

The scraper ranks jobs and companies after every scrape (see "Tags, company index and posts" in the main
README). n8n, running on Railway, turns the best of them into a LinkedIn post, sends it to you on Telegram, and
posts it only after you approve. Every post links to a page on the job board listing its openings:
`https://<your-site>/alert.html?id=<post id>`.

## Database login for n8n

n8n gets its own login that can do exactly two things: call `draft_post()` and `finish_post()`. It can't read
or change any table. Run this once in Supabase → SQL Editor, with a long random password:

```sql
CREATE ROLE n8n_poster LOGIN PASSWORD '<long random password>';
GRANT EXECUTE ON FUNCTION draft_post(INTEGER), finish_post(BIGINT, TEXT, TEXT, TEXT) TO n8n_poster;
```

In n8n, add a **Postgres** credential with the values from Supabase → Connect → Session pooler: host
`aws-…pooler.supabase.com`, port `5432`, database `postgres`, user `n8n_poster.<project ref>`, that password,
SSL on.

## The workflow

1. **Schedule Trigger**: how often to post (to decide; once a day at most is a sensible start).
2. **Postgres → Execute Query**: `SELECT * FROM draft_post(8);`
   Saves the 8 best new jobs as a draft post and returns them in post order, with `post_id`, `title`,
   `company`, `location`, `workplace`, `role`, `level`, `tags`, `is_premium`, `company_score`. No rows means
   nothing new to post: stop here. Jobs in a draft aren't offered again for a day.
3. **Code**: build the post text from the template below.
4. **Telegram → Send and Wait for Response** (approval type: approve and disapprove), to your own chat ID, with
   a separate bot made for this (not the public alerts bot, which can't share its updates with n8n).
5. **If approved → LinkedIn → Create Post** (as a person, your profile), then
   **Postgres**: `SELECT finish_post($1, 'posted', $2, $3);` with post_id, the post text and the LinkedIn post URL.
6. **If not approved → Postgres**: `SELECT finish_post($1, 'skipped');` with post_id.
   The jobs go back into the pool for the next post.

Pass the values with the node's "Query Parameters" option, not pasted into the SQL, since post text can contain
quotes.

## Post template

```
🚀 Hiring alert: {{count}} openings at {{companies}} companies

{{for the first 5 jobs}}
• {{company}}: {{title}} ({{location}}{{, Remote if workplace = remote}})
{{end}}

Top stacks this round: {{3 most common tags}}

All openings with links: https://<your-site>/alert.html?id={{post_id}}

#hiring #softwareengineering #{{top tag}} #jobs #india
```

One link only: LinkedIn previews just one link per post, and the page lists every opening.

## LinkedIn connection

Create an app at linkedin.com/developers on a LinkedIn Page you own, add the products "Share on LinkedIn" and
"Sign In with LinkedIn using OpenID Connect", and connect it in n8n's LinkedIn credential (redirect URL from
n8n). The login lasts 60 days, so reconnect it in n8n about every two months.
