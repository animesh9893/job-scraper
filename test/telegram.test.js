import { test } from 'node:test';
import assert from 'node:assert/strict';
import { words, prepareJob, matches } from '../src/telegram-match.js';
import { handleUpdate, parseKeyword } from '../web/api/_telegram-bot.mjs';

const job = (title, extra = {}) => prepareJob({ title, company: 'Acme', location: 'Bengaluru, Karnataka, India', ...extra });
const kw = (text, anywhere = false) => ({ text, anywhere });

test('react spellings are the same word', () => {
    for (const t of ['React.js', 'ReactJS', 'react js', 'React']) assert.deepEqual(words(t), ['react']);
    assert.deepEqual(words('Node.js / Next.js'), ['node', 'next']);
});

test('title keywords', () => {
    const sub = { keywords: [kw('react.js'), kw('frontend engineer')] };
    assert.ok(matches(job('Senior React Developer'), sub));
    assert.ok(matches(job('Front-End Engineer II'), sub));
    assert.ok(matches(job('Frontend Engineer, Remote'), sub));
    assert.ok(!matches(job('Python Backend Engineer'), sub));
    assert.ok(!matches(job('Frontend Developer'), sub), 'phrase needs both words together');
    assert.ok(!matches(job('Engineer, Frontend Platform'), sub));
});

test('no partial words', () => {
    assert.ok(!matches(job('JavaScript Developer'), { keywords: [kw('java')] }));
    assert.ok(matches(job('Java Developer'), { keywords: [kw('java')] }));
    assert.ok(matches(job('Senior Golang Engineer'), { keywords: [kw('go')] }));
});

test('--anywhere also checks the description', () => {
    const j = job('Software Engineer', { description: 'You will build UIs with ReactJS and TypeScript.' });
    assert.ok(!matches(j, { keywords: [kw('react')] }));
    assert.ok(matches(j, { keywords: [kw('react', true)] }));
});

test('locations', () => {
    const remote = job('React Developer', { location: 'India', workplace: 'remote' });
    const blr = job('React Developer', { location: 'Bangalore Urban, India' });
    const sub = (locations) => ({ keywords: [kw('react')], locations });
    assert.ok(matches(remote, sub(['remote'])));
    assert.ok(!matches(blr, sub(['remote'])));
    assert.ok(matches(blr, sub(['bengaluru'])));
    assert.ok(matches(blr, sub(['remote', 'Bengaluru'])));
    assert.ok(matches(blr, sub([])));
});

test('parseKeyword', () => {
    assert.deepEqual(parseKeyword('python --anywhere'), { text: 'python', anywhere: true });
    assert.deepEqual(parseKeyword('  frontend   engineer '), { text: 'frontend engineer', anywhere: false });
});

function fakeBot() {
    const db = new Map();
    const sent = [];
    const store = {
        get: async (id) => (db.has(id) ? structuredClone(db.get(id)) : null),
        save: async (sub) => { db.set(sub.chat_id, structuredClone(sub)); },
    };
    const tg = async (method, body) => { sent.push({ method, ...body }); return { ok: true }; };
    const say = (text, chat = { id: 7, type: 'private' }) => handleUpdate({ message: { chat, from: { username: 'a' }, text } }, { store, tg });
    return { db, sent, say, store, tg };
}

test('bot commands', async () => {
    const { db, sent, say, store, tg } = fakeBot();
    await say('/start');
    assert.equal(db.get(7).is_active, true);
    await say('/add react.js');
    await say('/add Frontend Engineer --anywhere');
    await say('/add REACT.JS');
    assert.match(sent.at(-1).text, /already have/);
    await say('/location remote');
    assert.deepEqual(db.get(7).keywords, [kw('react.js'), kw('Frontend Engineer', true)]);
    assert.deepEqual(db.get(7).locations, ['remote']);
    await say('/remove react.js');
    assert.deepEqual(db.get(7).keywords.map((k) => k.text), ['Frontend Engineer']);
    await say('/location clear');
    assert.deepEqual(db.get(7).locations, []);
    await say('/stop');
    assert.equal(db.get(7).is_active, false);
    await say('hello');
    assert.match(sent.at(-1).text, /\/add/);

    // Tapping a popular keyword button, then removing it from /list.
    await handleUpdate({ callback_query: { id: 'q', data: 'add:Python', from: {}, message: { message_id: 1, chat: { id: 7, type: 'private' } } } }, { store, tg });
    assert.ok(db.get(7).keywords.some((k) => k.text === 'Python'));
    await handleUpdate({ callback_query: { id: 'q', data: 'rm:0', from: {}, message: { message_id: 1, chat: { id: 7, type: 'private' } } } }, { store, tg });
    assert.deepEqual(db.get(7).keywords.map((k) => k.text), ['Python']);
});

test('bot ignores group chats', async () => {
    const { db, sent, say } = fakeBot();
    await say('/start', { id: -5, type: 'group' });
    assert.equal(db.size, 0);
    assert.equal(sent.length, 0);
});
