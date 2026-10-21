import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitJobs, buildPost, checkPost, plain, bold, italic, payFor, payRoles, jobLink, postHashtags, retarget, cityName, country } from '../src/linkedin-posts.js';
import { postImageSvg, renderPostImage, pickCompanies, loadLogos, MAX_FEATURED } from '../src/post-image.js';

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
    assert.deepEqual(lines.slice(2, 11), [
        '1. 𝗖𝗼 𝟭: Engineer 1 · 𝘉𝘦𝘯𝘨𝘢𝘭𝘶𝘳𝘶',
        '💰 ~₹24L/yr on Glassdoor',
        '🔗 https://jobs.example.com/job.html?id=j1',
        '',
        '2. 𝗖𝗼 𝟮: Engineer 2 · 𝘉𝘦𝘯𝘨𝘢𝘭𝘶𝘳𝘶 (𝘙𝘦𝘮𝘰𝘵𝘦)',
        '🔗 https://jobs.example.com/job.html?id=j2',
        '',
        '3. 𝗖𝗼 𝟬: Engineer 3 · 𝘉𝘦𝘯𝘨𝘢𝘭𝘶𝘳𝘶',
        '🔗 https://jobs.example.com/job.html?id=j3',
    ]);
    assert.doesNotMatch(body, /linkedin\.com/);
    assert.match(plain(body), /🔥 In demand: React, C\+\+, TypeScript/);
    assert.match(body, /https:\/\/jobs\.example\.com\/$/m);
    assert.equal(lines.at(-1), '#hiring #india #indiajobs #remote #remotejobs #workfromhome #bengalurujobs #react #cpp #typescript');
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

test('job links: the job page on the site, else short LinkedIn job pages, else the apply link', () => {
    assert.equal(jobLink({ job_id: '4123456789', url: 'https://in.linkedin.com/jobs/view/x-4123456789' }, 'https://jobs.example.com/'),
        'https://jobs.example.com/job.html?id=4123456789');
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
    assert.match(checkPost(ok.replace('Engineer 1', 'Engineer 1 https://a.example https://b.example')).join(), /3 job links for 1 jobs/);
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

test('hashtags: configured ones, then roles, countries, remote, cities, tech, companies and filler, without repeats, up to the limit', () => {
    const jobs = [
        job(1, { role: 'backend', tags: ['Java', 'Kafka'] }),
        job(2, { role: 'backend', tags: ['Java'], location: 'Pune, Maharashtra, India' }),
        job(3, { role: 'ml', tags: ['Machine Learning'], workplace: 'remote' }),
    ];
    assert.deepEqual(postHashtags(jobs, ['hiring', 'MachineLearning'], 30, ['jobs', 'Hiring']),
        ['hiring', 'machinelearning', 'backenddeveloper', 'india', 'indiajobs', 'remote', 'remotejobs', 'workfromhome',
            'bengalurujobs', 'punejobs', 'java', 'kafka', 'co0', 'co1', 'co2', 'jobs']);
    assert.equal(postHashtags(jobs, ['hiring'], 4).length, 4);
    assert.deepEqual(postHashtags([job(1, { location: 'Austin, TX', workplace: 'hybrid' })], [], 30).slice(0, 5),
        ['usa', 'usajobs', 'hybrid', 'hybridwork', 'austinjobs']);
});

test('places: LinkedIn districts become cities, and the country comes from the last part', () => {
    const cases = {
        'Pune Division, Maharashtra, India': ['Pune', 'india'],
        'Bengaluru East, Karnataka, India': ['Bengaluru', 'india'],
        'Bangalore Urban, Karnataka, India': ['Bengaluru', 'india'],
        'Greater Hyderabad Area': ['Hyderabad', ''],
        'London Area, United Kingdom': ['London', 'uk'],
        'New York, NY': ['New York', 'usa'],
        'United States': ['', 'usa'],
        Bengaluru: ['Bengaluru', ''],
        Remote: ['', ''],
    };
    for (const [location, [city, land]] of Object.entries(cases)) {
        assert.equal(cityName(location), city, location);
        assert.equal(country(location), land, location);
    }
});

test('picture: the post\'s companies get cards, premium then most jobs first; the strip skips them', () => {
    const premium = Array.from({ length: 25 }, (_, i) => ({ slug: `p${i}`, name: `Premium ${i}`, is_premium: true }));
    const jobs = (n) => Array.from({ length: n }, (_, i) => ({ title: `Role ${i}`, place: 'Pune' }));
    const post = [
        { slug: 'small', name: 'Small Co', is_premium: false, jobs: jobs(1) },
        { slug: 'busy', name: 'Busy Co', is_premium: false, jobs: jobs(3) },
        { slug: 'p3', name: 'Premium 3', is_premium: true, jobs: jobs(1) },
    ];
    const { featured, more, strip } = pickCompanies(post, premium);
    assert.deepEqual(featured.map((c) => c.slug), ['p3', 'busy', 'small']);
    assert.equal(more, 0);
    assert.equal(strip.length, 8);
    assert.ok(!strip.some((c) => c.slug === 'p3'));
    assert.equal(pickCompanies(post.slice(0, 1), premium).strip.length, 16);   // few cards: two rows of logos
    const many = Array.from({ length: 9 }, (_, i) => ({ slug: `c${i}`, name: `Co ${i}`, jobs: jobs(1) }));
    assert.deepEqual([pickCompanies(many, premium).featured.length, pickCompanies(many, premium).more], [MAX_FEATURED, 3]);
});

test('picture: logos fall back to the site icon, then to initials, and text is escaped', async () => {
    const asked = [];
    const fetchLogo = async (url) => (asked.push(url), url.includes('good') ? 'data:image/png;base64,AAAA' : null);
    const [a, b, c] = await loadLogos([
        { name: 'A', logo_url: 'https://good/a' }, { name: 'B', logo_url: 'https://bad/b', domain: 'good.com' }, { name: 'AT&T <Labs>' },
    ], fetchLogo);
    assert.equal(a.logo, 'data:image/png;base64,AAAA');
    assert.equal(b.logo, 'data:image/png;base64,AAAA');
    assert.equal(c.logo, null);
    assert.match(asked[2], /s2\/favicons\?domain=good\.com/);
    const svg = postImageSvg({ featured: [{ ...a, jobs: [{ title: 'Dev <1>', place: 'Pune' }] }, { ...c, jobs: [{ title: 'QA' }, { title: 'SRE' }] }],
        more: 2, strip: [b], jobs: 3, companiesInPost: 4, siteUrl: 'https://jobs.example.com/', date: new Date('2026-10-20T10:00:00Z') });
    assert.match(svg, /AT&amp;T &lt;Labs&gt;/);
    assert.match(svg, />A&lt;</);   // initials when there's no logo
    assert.match(svg, />Dev &lt;1&gt;</);
    assert.match(svg, />2 roles</);
    assert.match(svg, />3 new openings</);
    assert.match(svg, /\+ 2 more companies in the post/);
    assert.match(svg, /ALSO HIRING/);
    assert.match(svg, /20 Oct 2026/);
    assert.match(svg, /jobs\.example\.com</);
    const png = renderPostImage({ featured: [{ ...c, jobs: [] }], jobs: 1, companiesInPost: 1, siteUrl: 'https://jobs.example.com' });
    assert.deepEqual([...png.subarray(1, 4)], [...Buffer.from('PNG')]);
});

test('a long post drops hashtags before going over LinkedIn\'s limit', () => {
    const jobs = Array.from({ length: 10 }, (_, i) => job(i, { title: 'Senior Software Engineer II, Backend Platform (Golang)',
        company: `Cencora Global Capability Center ${i}`, tags: ['Go', 'Kubernetes'], pay: '~₹45L/yr on Glassdoor' }));
    const filler = Array.from({ length: 30 }, (_, i) => `longfillerhashtag${i}`);
    const body = buildPost({ id: 1, siteUrl: 'https://jobs.krawlr.xyz', hashtags: ['hiring'], maxHashtags: 30, fillerHashtags: filler, jobs });
    assert.ok(body.length <= 3000, `${body.length} characters`);
    assert.deepEqual(checkPost(body), []);
});

test('retarget moves draft links from the old site to the new one', () => {
    const old = '🔗 https://old.vercel.app/job.html?id=1\n👉 More: https://old.vercel.app/\n#hiring';
    assert.equal(retarget(old, ['https://old.vercel.app'], 'https://jobs.krawlr.xyz/'),
        '🔗 https://jobs.krawlr.xyz/job.html?id=1\n👉 More: https://jobs.krawlr.xyz/\n#hiring');
    assert.equal(retarget('no links', ['https://old.vercel.app'], 'https://jobs.krawlr.xyz'), 'no links');
});
