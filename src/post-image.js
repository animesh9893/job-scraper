// The picture that goes with a LinkedIn hiring-alert post: a 1200×1200 card listing the post's jobs (company,
// pay when known, title and place), drawn as SVG and turned into a PNG with resvg. The font (Inter, OFL) ships
// in assets/fonts, so the card looks the same wherever it is drawn.
import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';

const FONTS = ['Inter-Regular.ttf', 'Inter-Bold.ttf'].map((f) => fileURLToPath(new URL(`../assets/fonts/${f}`, import.meta.url)));
const SIZE = 1200;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cut = (s, max) => {
    const t = String(s ?? '').trim();
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** The card as SVG. jobs: [{ company, title, place, pay }], best first; siteUrl is shown at the bottom. */
export function postImageSvg({ jobs, siteUrl, date = new Date() }) {
    const companies = new Set(jobs.map((j) => j.company)).size;
    const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const site = String(siteUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const top = 330, bottom = 1100, gap = 14;
    const h = Math.min(130, (bottom - top - gap * (jobs.length - 1)) / Math.max(jobs.length, 1));
    const cards = jobs.map((j, i) => {
        const y = top + i * (h + gap);
        const line2 = [j.title, j.place].filter(Boolean).join(' · ');
        return `
  <rect x="60" y="${y}" width="1080" height="${h}" rx="18" fill="#ffffff" fill-opacity="0.07"/>
  <rect x="60" y="${y}" width="8" height="${h}" rx="4" fill="#5b8cff"/>
  <text x="96" y="${y + h * 0.42}" font-size="34" font-weight="700" fill="#ffffff">${esc(cut(j.company, j.pay ? 30 : 48))}</text>
  ${j.pay ? `<text x="1110" y="${y + h * 0.42}" font-size="28" font-weight="700" fill="#5fd3a0" text-anchor="end">${esc(cut(j.pay, 22))}</text>` : ''}
  <text x="96" y="${y + h * 0.78}" font-size="26" fill="#c9d4ea">${esc(cut(line2, 70))}</text>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" font-family="Inter">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1a33"/>
      <stop offset="1" stop-color="#16346b"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
  <rect x="60" y="70" width="260" height="54" rx="27" fill="#5b8cff"/>
  <text x="190" y="106" font-size="26" font-weight="700" fill="#ffffff" text-anchor="middle" letter-spacing="3">HIRING ALERT</text>
  <text x="60" y="222" font-size="84" font-weight="700" fill="#ffffff">${jobs.length} new opening${jobs.length === 1 ? '' : 's'}</text>
  <text x="60" y="284" font-size="34" fill="#9fb3d9">at ${companies} compan${companies === 1 ? 'y' : 'ies'} · ${esc(day)}</text>${cards}
  <text x="60" y="1150" font-size="28" fill="#9fb3d9">All jobs and apply links: <tspan font-weight="700" fill="#ffffff">${esc(site)}</tspan></text>
</svg>`;
}

/** The card as a PNG buffer. */
export function renderPostImage(opts) {
    const svg = postImageSvg(opts);
    return new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
}
