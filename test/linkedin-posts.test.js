import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitJobs, buildPost, checkPost, plain, bold, italic, payFor, payRoles, jobLink } from '../src/linkedin-posts.js';

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
        jobs: [
            job(1, { tags: ['React', 'TypeScript'], pay: '~₹24L/yr on Glassdoor', url: 'https://in.linkedin.com/jobs/view/engineer-1-at-co-4123456789' }),
            job(2, { tags: ['React'], workplace: 'remote', url: 'https://www.linkedin.com/jobs/view/4123456790/' }),
            job(3, { tags: ['C++'] }),
        ],
    });
    const lines = body.split('\n');
    assert.equal(lines[0], '🚀 𝗛𝗶𝗿𝗶𝗻𝗴 𝗮𝗹𝗲𝗿𝘁: 𝟯 𝗻𝗲𝘄 𝗼𝗽𝗲𝗻𝗶𝗻𝗴𝘀 𝗮𝘁 𝟯 𝗰𝗼𝗺𝗽𝗮𝗻𝗶𝗲𝘀');
    assert.deepEqual(lines.slice(2, 10), [
        '1. 𝗖𝗼 𝟭: Engineer 1 · 𝘉𝘦𝘯𝘨𝘢𝘭𝘶𝘳𝘶',
        '💰 ~₹24L/yr on Glassdoor',
        '🔗 https://www.linkedin.com/jobs/view/4123456789',
        '',
        '2. 𝗖𝗼 𝟮: Engineer 2 · 𝘉𝘦𝘯𝘨𝘢𝘭𝘶𝘳𝘶 (𝘙𝘦𝘮𝘰𝘵𝘦)',
        '🔗 https://www.linkedin.com/jobs/view/4123456790',
        '',
        '3. 𝗖𝗼 𝟬: Engineer 3 · 𝘉𝘦𝘯𝘨𝘢𝘭𝘶𝘳𝘶',
    ]);
    assert.match(plain(body), /🔥 In demand: React, C\+\+, TypeScript/);
    assert.match(body, /https:\/\/jobs\.example\.com\/alert\.html\?id=42$/m);
    assert.equal(lines.at(-1), '#hiring #react #cpp #typescript');
    assert.deepEqual(checkPost(body), []);
});

test('pay: the listing\'s own salary, else the Glassdoor median for the closest role', () => {
    const salaries = [
        { company_slug: 'acme', query: 'Software Engineer', currency: 'INR', median: 1850000 },
        { company_slug: 'acme', query: 'Senior Software Engineer', currency: 'INR', median: 3420000 },
        { company_slug: 'acme', query: 'Data Analyst', currency: 'INR', median: 850000 },
        { company_slug: 'globex', query: 'Backend Developer', currency: 'USD', median: 132400 },
    ];
    const pay = (extra) => payFor({ company_slug: 'acme', title: 'Engineer', role: 'backend', level: 'mid', ...extra }, salaries);
    assert.equal(pay({ salary: '₹20,00,000/yr - ₹30,00,000/yr' }), '₹20,00,000/yr - ₹30,00,000/yr');
    assert.equal(pay({ salary: '["₹20L","₹30L"]' }), '₹20L – ₹30L');
    assert.equal(pay({}), '~₹19L/yr on Glassdoor');
    assert.equal(pay({ level: 'senior' }), '~₹34L/yr on Glassdoor');
    assert.equal(pay({ role: 'data', title: 'Data Analyst' }), '~₹8.5L/yr on Glassdoor');
    assert.equal(pay({ role: 'data', title: 'Data Engineer' }), null);
    assert.equal(pay({ level: 'intern' }), null);
    assert.equal(pay({ company_slug: 'globex' }), '~$132k/yr on Glassdoor');
    assert.equal(pay({ company_slug: 'nobody' }), null);
    assert.deepEqual(payRoles({ title: 'Senior Android Engineer', role: 'mobile', level: 'senior' }),
        ['Senior Software Engineer', 'Android Developer', 'Mobile Developer', 'Software Engineer']);
});

test('job links: short LinkedIn job pages, else the apply link', () => {
    assert.equal(jobLink({ url: 'https://in.linkedin.com/jobs/view/sde-ii-at-acme-4123456789' }), 'https://www.linkedin.com/jobs/view/4123456789');
    assert.equal(jobLink({ url: 'https://boards.greenhouse.io/acme/jobs/1' }), 'https://boards.greenhouse.io/acme/jobs/1');
    assert.equal(jobLink({ url: null, apply_url: 'https://acme.com/careers/1' }), 'https://acme.com/careers/1');
    assert.equal(jobLink({ url: 'j1' }), null);
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
    assert.match(checkPost(`${ok}\nhttps://evil.example`).join(), /after all the others/);
    assert.match(checkPost(ok.replace('Engineer 1', 'Engineer 1 https://a.example https://b.example')).join(), /2 job links for 1 jobs/);
    assert.match(checkPost(ok + 'x'.repeat(3000)).join(), /characters/);
});

test('the n8n workflow runs the same template check', async () => {
    const { readFileSync } = await import('node:fs');
    const workflow = JSON.parse(readFileSync(new URL('../n8n/hiring-alert-workflow.json', import.meta.url)));
    const code = workflow.nodes.find((n) => n.name === 'Check against template').parameters.jsCode;
    assert.ok(code.includes(checkPost.toString()), 'copy checkPost() from src/linkedin-posts.js into the workflow');
    assert.ok(code.includes(plain.toString()), 'copy plain() from src/linkedin-posts.js into the workflow');
    assert.equal(code.split('function plain(').length, 2, 'plain() is in the workflow once');
});
