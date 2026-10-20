// The picture that goes with a LinkedIn hiring-alert post: a 1200×1200 wall of company logos, the post's
// companies (marked NEW) and the top premium companies on the job board, to catch the eye. Drawn as SVG and
// turned into a PNG with resvg. The font (Inter, OFL) ships in assets/fonts, so it looks the same everywhere.
import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';

const FONTS = ['Inter-Regular.ttf', 'Inter-Bold.ttf'].map((f) => fileURLToPath(new URL(`../assets/fonts/${f}`, import.meta.url)));
const SIZE = 1200;
const COLS = 5, ROWS = 4;
export const MAX_LOGOS = COLS * ROWS;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cut = (s, max) => {
    const t = String(s ?? '').trim();
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const initials = (name) => String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

/**
 * The companies to show, at most MAX_LOGOS: premium ones first (the post's, then the board's best by score),
 * then the post's other companies, so every company in the post is on the wall.
 * postCompanies and premium: [{ slug, name, logo_url, domain, is_premium }], premium best first.
 */
export function pickCompanies(postCompanies, premium) {
    const inPost = new Set(postCompanies.map((c) => c.slug ?? c.name));
    const others = postCompanies.filter((c) => !c.is_premium);
    const room = Math.max(0, MAX_LOGOS - others.length);
    const seen = new Set();
    const top = [...postCompanies.filter((c) => c.is_premium), ...premium]
        .filter((c) => !seen.has(c.slug ?? c.name) && seen.add(c.slug ?? c.name)).slice(0, room);
    return [...top, ...others].slice(0, MAX_LOGOS).map((c) => ({ ...c, isNew: inPost.has(c.slug ?? c.name) }));
}

/**
 * The picture as SVG. companies: [{ name, logo (a data: URI or null), isNew }]; jobs and companiesInPost are the
 * post's counts; siteUrl is shown at the bottom.
 */
export function postImageSvg({ companies, jobs, companiesInPost, siteUrl, date = new Date() }) {
    const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const site = String(siteUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const w = 196, h = 172, gap = 16, x0 = (SIZE - COLS * w - (COLS - 1) * gap) / 2, y0 = 330;
    const tiles = companies.slice(0, MAX_LOGOS).map((c, i) => {
        const x = x0 + (i % COLS) * (w + gap), y = y0 + Math.floor(i / COLS) * (h + gap);
        const art = c.logo
            ? `<image href="${c.logo}" x="${x + (w - 92) / 2}" y="${y + 18}" width="92" height="92" preserveAspectRatio="xMidYMid meet"/>`
            : `<circle cx="${x + w / 2}" cy="${y + 64}" r="46" fill="#dfe6f5"/>
  <text x="${x + w / 2}" y="${y + 77}" font-size="36" font-weight="700" fill="#16346b" text-anchor="middle">${esc(initials(c.name))}</text>`;
        return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#ffffff"/>
  ${art}
  <text x="${x + w / 2}" y="${y + 146}" font-size="21" font-weight="700" fill="#1d2433" text-anchor="middle">${esc(cut(c.name, 16))}</text>${c.isNew ? `
  <rect x="${x + w - 62}" y="${y + 10}" width="52" height="26" rx="13" fill="#0f9d63"/>
  <text x="${x + w - 36}" y="${y + 29}" font-size="15" font-weight="700" fill="#ffffff" text-anchor="middle">NEW</text>` : ''}`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" font-family="Inter">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1a33"/>
      <stop offset="1" stop-color="#16346b"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
  <rect x="${x0}" y="70" width="260" height="54" rx="27" fill="#5b8cff"/>
  <text x="${x0 + 130}" y="106" font-size="26" font-weight="700" fill="#ffffff" text-anchor="middle" letter-spacing="3">HIRING ALERT</text>
  <text x="${x0}" y="214" font-size="76" font-weight="700" fill="#ffffff">${jobs} new opening${jobs === 1 ? '' : 's'}</text>
  <text x="${x0}" y="276" font-size="32" fill="#9fb3d9">at ${companiesInPost} compan${companiesInPost === 1 ? 'y' : 'ies'} · ${esc(day)}</text>${tiles}
  <text x="${x0}" y="1150" font-size="28" fill="#9fb3d9">Jobs at these companies and more: <tspan font-weight="700" fill="#ffffff">${esc(site)}</tspan></text>
</svg>`;
}

/** The picture as a PNG buffer. */
export function renderPostImage(opts) {
    return new Resvg(postImageSvg(opts), { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
}

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/;

// One image as a data: URI, or null when it can't be fetched or isn't a picture resvg can draw.
async function fetchImage(url) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
        if (!res.ok || !IMAGE_TYPES.test(type)) return null;
        return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    } catch {
        return null;
    }
}

/** Adds `logo` (a data: URI or null) to each company: its LinkedIn logo, else its site's icon, else none. */
export async function loadLogos(companies, fetchLogo = fetchImage) {
    return Promise.all(companies.map(async (c) => ({
        ...c,
        logo: (c.logo_url && await fetchLogo(c.logo_url))
            || (c.domain && await fetchLogo(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=128`))
            || null,
    })));
}
