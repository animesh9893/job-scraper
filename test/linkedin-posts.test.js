import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitJobs, buildPost, checkPost, plain, bold, italic } from '../src/linkedin-posts.js';

const people = [{ id: 'animesh' }, { id: 'sachin' }];
const job = (n, extra = {}) => ({ job_id: `j${n}`, title: `Engineer ${n}`, company: `Co ${n % 3}`, location: 'Bengaluru, Karnataka, India', tags: [], ...extra });

test('jobs are dealt out in turn, different for each person', () => {
    const split = splitJobs([1, 2, 3, 4, 5].map((n) => job(n)), people, 2);
    assert.deepEqual(split.get('animesh').map((j) => j.job_id), ['j1', 'j3']);
    assert.deepEqual(split.get('sachin').map((j) => j.job_id), ['j2', 'j4']);
});

test('a short list goes to whoever still has room', () => {
    const split = splitJobs([1, 2, 3].map((n) => job(n)), people, 5);
    assert.equal(split.get('animesh').length + split.get('sachin').length, 3);
});

test('post follows the template and passes the check', () => {
    const body = buildPost({
        id: 42, siteUrl: 'https://jobs.example.com/', hashtags: ['hiring'],
        jobs: [job(1, { tags: ['React', 'TypeScript'] }), job(2, { tags: ['React'], workplace: 'remote' }), job(3, { tags: ['C++'] })],
    });
    const lines = body.split('\n');
    assert.equal(lines[0], '🚀 𝗛𝗶𝗿𝗶𝗻𝗴 𝗮𝗹𝗲𝗿𝘁: 𝟯 𝗻𝗲𝘄 𝗼𝗽𝗲𝗻𝗶𝗻𝗴𝘀 𝗮𝘁 𝟯 𝗰𝗼𝗺𝗽𝗮𝗻𝗶𝗲𝘀');
    assert.equal(lines[2], '1. 𝗖𝗼 𝟭: Engineer 1 · 𝘉𝘦𝘯𝘨𝘢𝘭𝘶𝘳𝘶');
    assert.equal(plain(lines[3]), '2. Co 2: Engineer 2 · Bengaluru (Remote)');
    assert.match(plain(body), /🔥 In demand: React, C\+\+, TypeScript/);
    assert.match(body, /https:\/\/jobs\.example\.com\/alert\.html\?id=42$/m);
    assert.equal(lines.at(-1), '#hiring #react #cpp #typescript');
    assert.deepEqual(checkPost(body), []);
});

test('bold and italic letters turn back into plain ones', () => {
    const text = 'Hiring 2026: C++ & Go (Remote)';
    assert.equal(plain(bold(text)), text);
    assert.equal(plain(italic(text)), text);
    assert.equal(bold('Ab9'), '𝗔𝗯𝟵');
    assert.equal(italic('Ab9'), '𝘈𝘣9');
});

test('check catches posts that drift from the template', () => {
    assert.ok(checkPost('Hello world').length >= 3);
    const ok = buildPost({ id: 1, siteUrl: 'https://x.dev', hashtags: ['hiring'], jobs: [job(1)] });
    assert.deepEqual(checkPost(ok), []);
    assert.match(checkPost(ok.replace('Engineer 1', 'undefined')).join(), /undefined/);
    assert.match(checkPost(`${ok}\nhttps://evil.example`).join(), /exactly one link/);
    assert.match(checkPost(ok + 'x'.repeat(3000)).join(), /characters/);
});

test('the n8n workflow runs the same template check', async () => {
    const { readFileSync } = await import('node:fs');
    const workflow = JSON.parse(readFileSync(new URL('../n8n/hiring-alert-workflow.json', import.meta.url)));
    const code = workflow.nodes.find((n) => n.name === 'Check against template').parameters.jsCode;
    assert.ok(code.includes(checkPost.toString()), 'copy checkPost() from src/linkedin-posts.js into the workflow');
    assert.ok(code.includes(plain.toString()), 'copy plain() from src/linkedin-posts.js into the workflow');
});
