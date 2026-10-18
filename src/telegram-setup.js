// Points the Telegram bot at the webhook on the Vercel site and sets its command menu. Run once after
// deploying, and again if the site URL or TELEGRAM_WEBHOOK_SECRET changes.
// Usage: node src/telegram-setup.js https://your-site.vercel.app   (needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET)
import { COMMANDS } from '../web/api/_telegram-bot.mjs';
import { requireEnv } from './config.js';

const site = (process.argv[2] ?? process.env.SITE_URL ?? '').replace(/\/$/, '');
if (!/^https:\/\//.test(site)) {
    console.error('Give the site URL, e.g. node src/telegram-setup.js https://your-site.vercel.app');
    process.exit(1);
}
const token = requireEnv('TELEGRAM_BOT_TOKEN');
const secret = requireEnv('TELEGRAM_WEBHOOK_SECRET');
if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
    console.error('TELEGRAM_WEBHOOK_SECRET must be 16–256 characters of letters, digits, _ or -');
    process.exit(1);
}

async function call(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`${method}: ${data.description}`);
    return data.result;
}

const me = await call('getMe');
await call('setWebhook', { url: `${site}/api/telegram`, secret_token: secret, allowed_updates: ['message', 'callback_query'] });
await call('setMyCommands', { commands: COMMANDS });
const info = await call('getWebhookInfo');
console.log(`@${me.username} → ${info.url}` + (info.last_error_message ? ` (last error: ${info.last_error_message})` : ''));
console.log(`Open https://t.me/${me.username} and send /start`);
