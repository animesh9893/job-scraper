// The picture that goes with a LinkedIn hiring-alert post, 1080×1350 (4:5, the tallest LinkedIn shows in full in
// the feed). The post's companies get a card each with their logo, top role and place; below them a strip of the
// board's top premium companies says "and these are hiring too". Drawn as SVG and turned into a PNG with resvg.
// The font (Inter, OFL) ships in assets/fonts, so it looks the same everywhere.
import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';

const FONTS = ['Inter-Regular.ttf', 'Inter-Bold.ttf'].map((f) => fileURLToPath(new URL(`../assets/fonts/${f}`, import.meta.url)));
export const WIDTH = 1080, HEIGHT = 1350;
export const MAX_FEATURED = 6;   // company cards
export const MAX_STRIP = 16;     // premium logos in the strip: one row of 8, two when there are few cards
const PER_ROW = 8;
const PAD = 72, INNER = WIDTH - 2 * PAD;

const C = {
    bgTop: '#081226', bgBottom: '#12285a', glow: '#3d6dff', accent: '#5b8cff', green: '#22c55e',
    text: '#ffffff', muted: '#a9badb', card: '#ffffff', ink: '#111a2e', inkMuted: '#5a6680', tile: '#eef2fa',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const initials = (name) => String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
// Rough width of text in Inter (em per character), enough to cut long names before they overflow a card.
const fits = (size, px, weight = 400) => Math.max(4, Math.floor(px / (size * (weight >= 700 ? 0.6 : 0.54))));
const cut = (s, max) => {
    const t = String(s ?? '').trim();
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/**
 * Who goes on the picture. postCompanies: the post's companies, in post order, each { slug, name, logo_url, domain,
 * is_premium, jobs: [{ title, place }] }; premium: the board's premium companies, best first.
 * Returns { featured, more, strip }: up to MAX_FEATURED post companies (premium first, then most jobs), how many
 * post companies didn't fit, and up to MAX_STRIP premium companies that aren't in the post.
 */
export function pickCompanies(postCompanies, premium) {
    const key = (c) => c.slug ?? c.name;
    const inPost = new Set(postCompanies.map(key));
    const ranked = postCompanies.map((c, i) => ({ c, i }))
        .sort((a, b) => (b.c.is_premium - a.c.is_premium) || ((b.c.jobs?.length ?? 0) - (a.c.jobs?.length ?? 0)) || (a.i - b.i))
        .map(({ c }) => c);
    const seen = new Set();
    const strip = premium.filter((c) => !inPost.has(key(c)) && !seen.has(key(c)) && seen.add(key(c))).slice(0, ranked.length > 2 ? PER_ROW : MAX_STRIP);
    return { featured: ranked.slice(0, MAX_FEATURED), more: Math.max(0, ranked.length - MAX_FEATURED), strip };
}

// A logo in a rounded tile: the image clipped to the tile, else the company's initials.
function logoTile(c, x, y, size, id) {
    const r = Math.round(size * 0.22);
    if (c.logo) {
        return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}"/></clipPath>
  <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="#ffffff"/>
  <image href="${c.logo}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" clip-path="url(#${id})"/>`;
    }
    return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${C.tile}"/>
  <text x="${x + size / 2}" y="${y + size / 2 + size * 0.14}" font-size="${Math.round(size * 0.38)}" font-weight="700" fill="#2f5bd3" text-anchor="middle">${esc(initials(c.name))}</text>`;
}

// One post company: logo, name and how many roles it has in the post, then its roles. A narrow card (two
// columns) shows the first role and its place on two lines; a wide one up to `lines` roles, "title · place" each.
function card(c, x, y, w, h, i, lines) {
    const logo = Math.min(lines > 1 ? 112 : 96, h - 56);
    const tx = x + 28 + logo + 24, tw = x + w - 28 - tx;
    const jobs = c.jobs ?? [];
    const count = jobs.length > 1 ? `${jobs.length} roles` : '';
    const badgeW = count ? 22 + count.length * 11 : 0;
    const shown = lines > 1 ? jobs.slice(0, lines) : [];
    const textH = lines > 1 ? 30 + shown.length * 36 : 96;
    const top = y + (h - textH) / 2 + 24;   // baseline of the name
    const roles = lines > 1
        ? shown.map((j, k) => {
            const title = cut(j.title, fits(22, tw * 0.68)), place = j.place ? cut(j.place, fits(22, tw - title.length * 22 * 0.54 - 30)) : '';
            return `<text x="${tx}" y="${top + 40 + k * 36}" font-size="22" fill="${C.ink}">${esc(title)}${place ? `<tspan fill="${C.inkMuted}" dx="10">·</tspan><tspan fill="${C.inkMuted}" dx="10">${esc(place)}</tspan>` : ''}</text>`;
        }).join('\n  ')
        : `<text x="${tx}" y="${top + 38}" font-size="22" fill="${C.ink}">${esc(cut(jobs[0]?.title, fits(22, tw)))}</text>
  <text x="${tx}" y="${top + 68}" font-size="19" fill="${C.inkMuted}">${esc(cut(jobs[0]?.place, fits(19, tw)))}</text>`;
    return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="${C.card}"/>
  ${logoTile(c, x + 28, y + (h - logo) / 2, logo, `logo${i}`)}
  <text x="${tx}" y="${top}" font-size="30" font-weight="700" fill="${C.ink}">${esc(cut(c.name, fits(30, tw - badgeW - (count ? 12 : 0), 700)))}</text>${count ? `
  <rect x="${x + w - 28 - badgeW}" y="${top - 25}" width="${badgeW}" height="32" rx="16" fill="#dcfce7"/>
  <text x="${x + w - 28 - badgeW / 2}" y="${top - 3}" font-size="18" font-weight="700" fill="#15803d" text-anchor="middle">${esc(count)}</text>` : ''}
  ${roles}`;
}

/**
 * The picture as SVG. featured, more and strip come from pickCompanies(), each company with `logo` (a data: URI or
 * null); jobs and companiesInPost are the post's counts; siteUrl is shown at the bottom.
 */
export function postImageSvg({ featured, more = 0, strip = [], jobs, companiesInPost, siteUrl, date = new Date() }) {
    const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const site = String(siteUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    // "at A, B & 3 more": as many names as fit on one line.
    const names = featured.map((c) => cut(c.name, 20)), room = fits(32, INNER - 40, 700);
    let at = cut(names[0], room);
    for (let n = Math.min(names.length, 3); n >= 1; n--) {
        const rest = companiesInPost - n;
        const line = rest ? `${names.slice(0, n).join(', ')} & ${rest} more` : names.slice(0, n - 1).join(', ') + (n > 1 ? ` & ${names[n - 1]}` : names[0]);
        if (line.length <= room) { at = line; break; }
    }

    // Bottom up: the footer, the premium strip above it, then the cards fill what's left under the heading.
    const footY = HEIGHT - PAD - 76;
    const tile = 88, stripGap = (INNER - PER_ROW * tile) / (PER_ROW - 1), stripRows = Math.ceil(strip.length / PER_ROW);
    const stripY = strip.length ? footY - 56 - stripRows * tile - (stripRows - 1) * 24 : footY;
    const top = 470, bottom = (strip.length ? stripY - 70 : footY) - 36 - (more ? 40 : 0);
    const cols = featured.length > 3 ? 2 : 1, rows = Math.ceil(featured.length / cols) || 1, gap = 24;
    const w = (INNER - (cols - 1) * gap) / cols;
    // Wide cards list up to 3 roles each, when there's room for them.
    const most = Math.max(1, ...featured.map((c) => c.jobs?.length ?? 0));
    const lines = cols === 1 ? Math.max(1, Math.min(3, most, Math.floor(((bottom - top - (rows - 1) * gap) / rows - 100) / 36))) : 1;
    const h = Math.min(cols === 1 ? Math.max(150, 100 + lines * 36 + 30) : 200, (bottom - top - (rows - 1) * gap) / rows);
    const y0 = top + Math.max(0, (bottom - top - rows * h - (rows - 1) * gap) / 2);
    const cards = featured.map((c, i) => card(c, PAD + (i % cols) * (w + gap), y0 + Math.floor(i / cols) * (h + gap), w, h, i, lines)).join('');
    const moreLine = more ? `
  <text x="${WIDTH / 2}" y="${y0 + rows * h + (rows - 1) * gap + 44}" font-size="24" font-weight="700" fill="${C.muted}" text-anchor="middle">+ ${more} more compan${more === 1 ? 'y' : 'ies'} in the post</text>` : '';
    const stripSvg = strip.length ? `
  <text x="${PAD}" y="${stripY - 26}" font-size="20" font-weight="700" fill="${C.muted}" letter-spacing="3">ALSO HIRING ON THE BOARD</text>
  ${strip.map((c, i) => logoTile(c, PAD + (i % PER_ROW) * (tile + stripGap), stripY + Math.floor(i / PER_ROW) * (tile + 24), tile, `strip${i}`)).join('\n  ')}` : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="Inter">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="${C.bgTop}"/>
      <stop offset="1" stop-color="${C.bgBottom}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.glow}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${C.glow}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.6" fill="#ffffff" fill-opacity="0.07"/>
    </pattern>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#dots)"/>
  <circle cx="${WIDTH - 60}" cy="80" r="420" fill="url(#glow)"/>
  <circle cx="40" cy="${HEIGHT - 120}" r="320" fill="url(#glow)" opacity="0.5"/>

  <g transform="translate(${PAD} ${PAD}) scale(0.75)">
    <rect width="64" height="64" rx="14" fill="#2f5bd3"/>
    <path d="M24 20v-3a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v3" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
    <rect x="12" y="20" width="40" height="30" rx="6" fill="#fff"/>
    <path d="M12 32h40" stroke="#2f5bd3" stroke-width="3"/>
    <rect x="28" y="28" width="8" height="8" rx="2" fill="#2f5bd3"/>
    <circle cx="50" cy="14" r="7" fill="${C.green}" stroke="#2f5bd3" stroke-width="3"/>
  </g>
  <text x="${PAD + 64}" y="${PAD + 34}" font-size="28" font-weight="700" fill="${C.text}">Tech Jobs</text>
  <text x="${WIDTH - PAD}" y="${PAD + 34}" font-size="24" fill="${C.muted}" text-anchor="end">${esc(day)}</text>

  <rect x="${PAD}" y="186" width="262" height="52" rx="26" fill="${C.green}" fill-opacity="0.16" stroke="${C.green}" stroke-opacity="0.6" stroke-width="2"/>
  <circle cx="${PAD + 30}" cy="212" r="8" fill="${C.green}"/>
  <text x="${PAD + 50}" y="221" font-size="24" font-weight="700" fill="#86efac" letter-spacing="3">HIRING ALERT</text>
  <text x="${PAD - 4}" y="350" font-size="104" font-weight="700" fill="${C.text}" letter-spacing="-2">${jobs} new opening${jobs === 1 ? '' : 's'}</text>
  <text x="${PAD}" y="414" font-size="32" fill="${C.muted}">at <tspan fill="${C.text}" font-weight="700">${esc(at)}</tspan></text>
${cards}${moreLine}${stripSvg}

  <rect x="${PAD}" y="${footY}" width="${INNER}" height="76" rx="38" fill="${C.accent}"/>
  <text x="${WIDTH / 2}" y="${footY + 48}" font-size="28" fill="#ffffff" text-anchor="middle">Apply free at <tspan font-weight="700">${esc(site)}</tspan>  →</text>
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
