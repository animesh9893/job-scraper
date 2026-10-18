// Vercel serverless function (Vercel's root directory is web/, so it lives in web/api): Telegram sends every message to the bot here (the webhook set by
// src/telegram-setup.js). Subscribers are stored in Supabase over its REST API with the secret key,
// so this needs no npm packages. Vercel env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET,
// SUPABASE_URL, SUPABASE_SECRET_KEY (the service_role / secret key, never the public one).
import { handleUpdate } from './_telegram-bot.mjs';

const env = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env var ${name}`);
    return v;
};

function supabaseStore() {
    const url = `${env('SUPABASE_URL').replace(/\/$/, '')}/rest/v1/telegram_subscribers`;
    const key = env('SUPABASE_SECRET_KEY');
    // New sb_secret_ keys go only in apikey; a legacy service_role JWT also works as a bearer token.
    const headers = { apikey: key, 'Content-Type': 'application/json', ...(key.startsWith('eyJ') && { Authorization: `Bearer ${key}` }) };
    return {
        async get(chatId) {
            const res = await fetch(`${url}?chat_id=eq.${Number(chatId)}&select=*`, { headers });
            if (!res.ok) throw new Error(`Supabase read ${res.status}: ${await res.text()}`);
            return (await res.json())[0] ?? null;
        },
        async save(sub) {
            const row = { chat_id: sub.chat_id, username: sub.username, keywords: sub.keywords, locations: sub.locations,
                is_active: sub.is_active, updated_at: new Date().toISOString() };
            const res = await fetch(`${url}?on_conflict=chat_id`, {
                method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row),
            });
            if (!res.ok) throw new Error(`Supabase save ${res.status}: ${await res.text()}`);
        },
    };
}

async function tg(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) console.error(`Telegram ${method}: ${data.description}`);
    return data;
}

export default async function handler(req, res) {
    // Only Telegram knows the secret (sent with setWebhook), so nobody else can post fake updates.
    if (req.method !== 'POST' || !process.env.TELEGRAM_WEBHOOK_SECRET
        || req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
        return res.status(401).json({ ok: false });
    }
    try {
        await handleUpdate(req.body ?? {}, { store: supabaseStore(), tg });
    } catch (err) {
        console.error(err);   // still 200, or Telegram keeps resending the same update
    }
    return res.status(200).json({ ok: true });
}
