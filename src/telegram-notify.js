// After each scrape: sends every Telegram subscriber the new jobs that match their keywords
// (src/telegram-match.js). Jobs first seen in the last 24 hours are checked, and each job goes to a
// subscriber once (table telegram_sent), so a new keyword also brings the past day's matches.
// Usage: node src/telegram-notify.js   (needs DATABASE_URL and TELEGRAM_BOT_TOKEN; skips without the token)
import { openDb } from './db.js';
import { prepareJob, matches } from './telegram-match.js';
import { loadConfig } from './config.js';

const MAX_PER_RUN = 30;      // per subscriber, newest first; the rest wait for the next run
const PER_MESSAGE = 10;

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.log('TELEGRAM_BOT_TOKEN not set, skipping Telegram alerts');
    process.exit(0);
}

// "View job" opens the job's page on the board (siteUrl in config), like the board and the LinkedIn posts do.
const { siteUrl } = loadConfig();
// utm_source tells the site's analytics (Umami) the visit came from a Telegram alert.
const jobUrl = ({ job_id: jobId, url }) => (siteUrl && jobId
    ? `${siteUrl}/job.html?id=${encodeURIComponent(jobId)}&utm_source=telegram&utm_medium=alert` : url);

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(chatId, text, retry = true) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = await res.json();
    if (data.ok) return { ok: true };
    if (data.error_code === 429 && retry) {
        await sleep(((data.parameters?.retry_after ?? 5) + 1) * 1000);
        return send(chatId, text, false);
    }
    return { ok: false, code: data.error_code, error: data.description };
}

function formatJob(job) {
    const { title, company, location, workplace } = job;
    const where = [location, workplace === 'remote' && !/remote/i.test(location ?? '') ? 'Remote' : null].filter(Boolean).join(' · ');
    return `<b>${escapeHtml(title)}</b>\n${escapeHtml(company ?? '')}${where ? ` · ${escapeHtml(where)}` : ''}\n<a href="${escapeHtml(jobUrl(job))}">View job</a>`;
}

const store = await openDb();
const { rows: subs } = await store.query(
    `SELECT chat_id, keywords, locations FROM telegram_subscribers WHERE is_active AND jsonb_array_length(keywords) > 0`);
const { rows: jobs } = await store.query(
    `SELECT source, job_id, title, company, location, workplace, url, description FROM jobs
     WHERE status <> 'skipped' AND first_seen_at > now() - interval '24 hours' AND url IS NOT NULL
     ORDER BY first_seen_at DESC`);
const { rows: sentRows } = await store.query(
    `SELECT chat_id, source, job_id FROM telegram_sent WHERE sent_at > now() - interval '2 days'`);
const sent = new Set(sentRows.map((r) => `${r.chat_id}|${r.source}|${r.job_id}`));
const prepared = jobs.map(prepareJob);

let messages = 0, delivered = 0, blocked = 0;
const reached = new Set();
for (const sub of subs) {
    const todo = prepared
        .filter((p) => !sent.has(`${sub.chat_id}|${p.job.source}|${p.job.job_id}`) && matches(p, sub))
        .slice(0, MAX_PER_RUN)
        .map((p) => p.job);

    for (let i = 0; i < todo.length; i += PER_MESSAGE) {
        const batch = todo.slice(i, i + PER_MESSAGE);
        const header = i === 0 ? `🔔 <b>${todo.length} new job${todo.length > 1 ? 's' : ''}</b> for your keywords\n\n` : '';
        const result = await send(sub.chat_id, header + batch.map(formatJob).join('\n\n'));
        await sleep(100);   // stay well under Telegram's 30 messages a second
        if (!result.ok) {
            console.error(`  ✖ chat ${sub.chat_id}: ${result.error}`);
            // 403: the user blocked the bot or deleted the chat; stop sending until they /start again.
            if (result.code === 403) {
                await store.query('UPDATE telegram_subscribers SET is_active = false WHERE chat_id = $1', [sub.chat_id]);
                blocked++;
            }
            break;
        }
        await store.query(
            `INSERT INTO telegram_sent (chat_id, source, job_id)
             SELECT $1, unnest($2::text[]), unnest($3::text[]) ON CONFLICT DO NOTHING`,
            [sub.chat_id, batch.map((j) => j.source), batch.map((j) => j.job_id)]);
        messages++;
        reached.add(sub.chat_id);
        delivered += batch.length;
    }
}
await store.query(`DELETE FROM telegram_sent WHERE sent_at < now() - interval '7 days'`);
await store.query('UPDATE telegram_subscribers SET last_sent_at = now() WHERE chat_id = ANY($1)', [[...reached]]);
await store.close();
console.log(`Telegram: ${subs.length} subscriber(s), ${jobs.length} recent job(s), ${delivered} sent in ${messages} message(s)` +
    (blocked ? `, ${blocked} paused (bot blocked)` : ''));
