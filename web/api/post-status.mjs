// Vercel serverless function: each person's n8n reports here what happened to their LinkedIn post, after the
// approval email. POST /api/post-status with header "Authorization: Bearer <token>" and JSON
// { "id": 12, "status": "posted" | "skipped", "linkedinUrl": "https://www.linkedin.com/feed/update/…" }.
// The token is the post's person's own (Vercel env POST_TOKEN_<ID>, e.g. POST_TOKEN_ANIMESH), so one person's
// n8n can't change the other's posts. Only drafts change. Also needs SUPABASE_URL and SUPABASE_SECRET_KEY.
import { timingSafeEqual } from 'node:crypto';

const env = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env var ${name}`);
    return v;
};

const same = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    const { id, status, linkedinUrl = null } = req.body ?? {};
    if (!Number.isInteger(Number(id)) || !['posted', 'skipped'].includes(status)
        || (linkedinUrl !== null && !/^https:\/\/(www\.)?linkedin\.com\//.test(linkedinUrl))) {
        return res.status(400).json({ ok: false, error: 'Send { id, status: posted | skipped, linkedinUrl? }' });
    }
    try {
        const base = `${env('SUPABASE_URL').replace(/\/$/, '')}/rest/v1/posts`;
        const key = env('SUPABASE_SECRET_KEY');
        // New sb_secret_ keys go only in apikey; a legacy service_role JWT also works as a bearer token.
        const headers = { apikey: key, 'Content-Type': 'application/json', ...(key.startsWith('eyJ') && { Authorization: `Bearer ${key}` }) };

        const found = await fetch(`${base}?id=eq.${Number(id)}&select=person,status`, { headers });
        if (!found.ok) throw new Error(`Supabase read ${found.status}`);
        const [post] = await found.json();
        const token = post && process.env[`POST_TOKEN_${post.person.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
        const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!token || !given || !same(given, token)) return res.status(401).json({ ok: false });
        if (post.status !== 'draft') return res.status(409).json({ ok: false, error: `Post is already ${post.status}` });

        const saved = await fetch(`${base}?id=eq.${Number(id)}&status=eq.draft`, {
            method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ status, linkedin_url: linkedinUrl, posted_at: status === 'posted' ? new Date().toISOString() : null }),
        });
        if (!saved.ok) throw new Error(`Supabase save ${saved.status}`);
        return res.status(200).json({ ok: true });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false });
    }
}
