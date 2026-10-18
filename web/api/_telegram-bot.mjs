// Telegram bot commands (the _ keeps Vercel from serving this file as its own function): subscribers pick keywords (and optionally locations) and get only the new
// jobs that match. Runs in the Vercel function web/api/telegram.mjs; `store` and `tg` are passed in so this
// file has no dependencies. Matching and sending happen after each scrape in src/telegram-notify.js.

export const MAX_KEYWORDS = 20;
export const POPULAR = ['React', 'Python', 'Node.js', 'Java', 'Golang', 'Frontend Engineer', 'Backend Engineer',
    'Android', 'iOS', 'Machine Learning', 'DevOps', 'Data Engineer'];

export const COMMANDS = [
    { command: 'add', description: 'Add a keyword, e.g. /add react.js' },
    { command: 'remove', description: 'Remove a keyword' },
    { command: 'list', description: 'Show your keywords and locations' },
    { command: 'location', description: 'Only jobs in a place, e.g. /location remote' },
    { command: 'stop', description: 'Pause alerts (/start resumes)' },
    { command: 'help', description: 'How it works' },
];

const HELP = [
    'I send you new tech jobs that match <b>your</b> keywords, after every scrape (every 3 hours).',
    '',
    '<b>/add react.js</b> matches jobs with React in the title',
    '<b>/add frontend engineer</b> matches that phrase, also "Front-End Engineer"',
    '<b>/add python --anywhere</b> also checks the job description',
    '<b>/remove react.js</b> or tap it in /list',
    '<b>/location remote</b> or <b>/location bengaluru</b>, and <b>/location clear</b>',
    '<b>/stop</b> pauses alerts, <b>/start</b> resumes them',
    '',
    'A job is sent when any keyword matches, and it is in one of your locations if you set any.',
].join('\n');

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

function popularButtons(sub) {
    const have = new Set(sub.keywords.map((k) => k.text.toLowerCase()));
    const left = POPULAR.filter((p) => !have.has(p.toLowerCase()));
    const rows = [];
    for (let i = 0; i < left.length; i += 3) {
        rows.push(left.slice(i, i + 3).map((p) => ({ text: `+ ${p}`, callback_data: `add:${p}` })));
    }
    return rows.length ? { inline_keyboard: rows } : undefined;
}

function listText(sub) {
    const kw = sub.keywords.length
        ? sub.keywords.map((k) => `• ${escapeHtml(k.text)}${k.anywhere ? ' <i>(title or description)</i>' : ''}`).join('\n')
        : 'none yet. Add one with /add react.js or tap a button below.';
    const loc = sub.locations.length ? sub.locations.map(escapeHtml).join(', ') : 'anywhere';
    return `<b>Your keywords</b>\n${kw}\n\n<b>Locations:</b> ${loc}` + (sub.is_active ? '' : '\n\nAlerts are paused. /start resumes them.');
}

function listButtons(sub) {
    const rows = sub.keywords.map((k, i) => [{ text: `✕ ${k.text}`, callback_data: `rm:${i}` }]);
    return rows.length ? { inline_keyboard: rows } : undefined;
}

/** Parses "react.js --anywhere" into { text, anywhere }. */
export function parseKeyword(args) {
    const anywhere = /(^|\s)--anywhere\b/i.test(args);
    const text = args.replace(/(^|\s)--anywhere\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return { text, anywhere };
}

function addKeyword(sub, args) {
    const { text, anywhere } = parseKeyword(args);
    if (text.length < 2 || text.length > 50) return 'Send a keyword between 2 and 50 characters, e.g. /add react.js';
    const existing = sub.keywords.find((k) => sameText(k.text, text));
    if (existing) {
        if (existing.anywhere === anywhere) return `You already have "${escapeHtml(text)}".`;
        existing.anywhere = anywhere;
        return `Updated "${escapeHtml(text)}": ${anywhere ? 'title or description' : 'title only'}.`;
    }
    if (sub.keywords.length >= MAX_KEYWORDS) return `You can have up to ${MAX_KEYWORDS} keywords. /remove one first.`;
    sub.keywords.push({ text, anywhere });
    return `Added "${escapeHtml(text)}"${anywhere ? ' (title or description)' : ''}. You'll get matching jobs after the next scrape.`;
}

function removeKeyword(sub, text) {
    const i = sub.keywords.findIndex((k) => sameText(k.text, text));
    if (i < 0) return `"${escapeHtml(text)}" isn't one of your keywords. /list shows them.`;
    const [removed] = sub.keywords.splice(i, 1);
    return `Removed "${escapeHtml(removed.text)}".`;
}

function setLocation(sub, args) {
    const loc = args.replace(/\s+/g, ' ').trim();
    if (!loc) return 'Send a place, e.g. /location remote, /location bengaluru, or /location clear';
    if (/^(clear|any|anywhere|all)$/i.test(loc)) {
        sub.locations = [];
        return 'Locations cleared: jobs from anywhere.';
    }
    if (loc.length > 40) return 'That location is too long.';
    const i = sub.locations.findIndex((l) => sameText(l, loc));
    if (i >= 0) {
        sub.locations.splice(i, 1);
        return `Removed location "${escapeHtml(loc)}".`;
    }
    if (sub.locations.length >= 5) return 'You can have up to 5 locations. /location clear starts over.';
    sub.locations.push(loc);
    return `Only jobs in: ${sub.locations.map(escapeHtml).join(', ')}. Send the same /location again to remove it.`;
}

/** Handles one Telegram update. Returns nothing; replies through tg. */
export async function handleUpdate(update, { store, tg }) {
    const msg = update.message;
    const cb = update.callback_query;
    const chat = msg?.chat ?? cb?.message?.chat;
    if (!chat || chat.type !== 'private') return;   // only one-to-one chats, not groups

    const from = msg?.from ?? cb?.from ?? {};
    const sub = (await store.get(chat.id)) ?? { chat_id: chat.id, keywords: [], locations: [], is_active: true, isNew: true };
    sub.username = from.username ?? null;
    sub.keywords ??= [];
    sub.locations ??= [];
    const save = () => store.save(sub);

    if (cb) {
        const [action, value] = [cb.data.slice(0, cb.data.indexOf(':')), cb.data.slice(cb.data.indexOf(':') + 1)];
        let text = '';
        if (action === 'add') text = addKeyword(sub, value);
        else if (action === 'rm' && sub.keywords[Number(value)]) text = removeKeyword(sub, sub.keywords[Number(value)].text);
        await save();
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: text.replace(/<[^>]+>/g, '').slice(0, 190) });
        if (action === 'rm') {
            await tg('editMessageText', { chat_id: chat.id, message_id: cb.message.message_id, text: listText(sub),
                parse_mode: 'HTML', reply_markup: listButtons(sub) });
        }
        return;
    }

    const text = (msg.text ?? '').trim();
    const reply = (body, extra = {}) => tg('sendMessage', { chat_id: chat.id, text: body, parse_mode: 'HTML',
        disable_web_page_preview: true, ...extra });
    const m = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
    if (!m) return reply('To add a keyword, send /add followed by it, e.g. /add react.js. /help shows everything.');
    const [command, args] = [m[1].toLowerCase(), m[2]];

    switch (command) {
        case 'start':
            sub.is_active = true;
            await save();
            return reply(`${sub.isNew ? '👋 Welcome!' : '▶️ Alerts are on.'}\n\n${HELP}\n\nTap to add popular keywords:`,
                { reply_markup: popularButtons(sub) });
        case 'help':
            return reply(HELP);
        case 'stop':
            sub.is_active = false;
            await save();
            return reply('⏸ Alerts paused. Your keywords are kept; /start resumes.');
        case 'list':
            return reply(listText(sub), { reply_markup: listButtons(sub) });
        case 'add':
            if (!args.trim()) return reply('Which keyword? e.g. /add react.js', { reply_markup: popularButtons(sub) });
            { const out = addKeyword(sub, args); await save(); return reply(out); }
        case 'remove':
        case 'rm':
            if (!args.trim()) return reply(listText(sub), { reply_markup: listButtons(sub) });
            { const out = removeKeyword(sub, args); await save(); return reply(out); }
        case 'location':
        case 'loc':
            { const out = setLocation(sub, args); await save(); return reply(out); }
        default:
            return reply(`I don't know /${escapeHtml(command)}.\n\n${HELP}`);
    }
}
