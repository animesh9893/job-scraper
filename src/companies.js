// Manages companies, stored in Supabase. Premium ones are searched on LinkedIn by company ID (config `premium`)
// and shown as chips on the site; every other company is added automatically when a job mentions it.
// Usage:
//   node src/companies.js                                   → list premium companies, then the ones with most jobs
//   node src/companies.js add <slug> --name "Flipkart" [--linkedin-id 123] [--linkedin-slug flipkart]
//                            [--domain flipkart.com] [--alias "Flipkart Internet"]... [--premium]
//   node src/companies.js premium|unpremium <slug>
//   node src/companies.js link                              → link jobs to companies (also runs after every scrape)
//   node src/companies.js searches                          → rebuild the premium-N LinkedIn searches now
//   node src/companies.js seed                              → add or update the premium companies from seed-data.js
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { openDb, seedCompanies, upsertCompany } from './db.js';

const USAGE = 'Usage: node src/companies.js [list | add <slug> --name "..." [--linkedin-id N] [--domain d] [--alias a] [--premium] | ' +
    'premium <slug> | unpremium <slug> | link | searches | seed]';

const { positionals: [command = 'list', ...args], values } = parseArgs({
    allowPositionals: true,
    options: {
        name: { type: 'string' },
        'linkedin-id': { type: 'string' },
        'linkedin-slug': { type: 'string' },
        domain: { type: 'string' },
        alias: { type: 'string', multiple: true },
        premium: { type: 'boolean' },
    },
});

const store = await openDb();
try {
    await main();
} catch (err) {
    console.error(`✖ ${err.message}`);
    process.exitCode = 1;
} finally {
    await store.close();
}

async function main() {
    const q = (text, params) => store.query(text, params);
    const [slug] = args;

    switch (command) {
    case 'list': {
        const { rows } = await q(`
            SELECT c.slug, c.name, c.is_premium AS premium, c.premium_source AS source, c.linkedin_id,
                   COUNT(j.job_id) FILTER (WHERE j.first_seen_at > now() - interval '30 days')::int AS jobs_30d
            FROM companies c LEFT JOIN jobs j ON j.company_slug = c.slug
            GROUP BY c.slug
            ORDER BY c.is_premium DESC, CASE WHEN c.is_premium THEN c.sort_order END, jobs_30d DESC, c.slug
            LIMIT 60`);
        console.table(rows);
        break;
    }
    case 'add': {
        if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error('Usage: add <slug> --name "..." (slug: a-z, 0-9 and -)');
        const existing = (await q('SELECT name FROM companies WHERE slug = $1', [slug])).rows[0];
        const name = values.name ?? existing?.name;
        if (!name) throw new Error('Give --name for a new company');
        const linkedinId = values['linkedin-id'];
        if (linkedinId && !/^\d+(,\d+)*$/.test(linkedinId)) throw new Error('--linkedin-id is the number(s) in f_C= of a LinkedIn search URL, comma-separated');
        const moved = await upsertCompany(store, {
            slug, name, linkedin_id: linkedinId, linkedin_slug: values['linkedin-slug'], domain: values.domain,
            aliases: values.alias ?? [], ...(values.premium ? { is_premium: true, premium_source: 'default' } : {}),
        });
        console.log(`Saved company "${slug}"; ${moved} job(s) moved onto it.`);
        if (linkedinId || values.premium) await syncSearches();
        break;
    }
    case 'premium':
    case 'unpremium': {
        // premium_source stays set on unpremium, so the seed list doesn't add the company back.
        const { rowCount } = await q('UPDATE companies SET is_premium = $2, premium_source = COALESCE(premium_source, $3) WHERE slug = $1',
            [slug, command === 'premium', 'default']);
        if (!rowCount) throw new Error(`No company "${slug}"`);
        console.log(`${command === 'premium' ? 'Added' : 'Removed'} "${slug}" ${command === 'premium' ? 'to' : 'from'} premium.`);
        await syncSearches();
        break;
    }
    case 'link':
        console.log(`Linked ${await store.linkCompanies()} job(s) to companies.`);
        break;
    case 'searches':
        await syncSearches();
        break;
    case 'seed':
        await seedCompanies(store);
        console.log('Added or updated the premium companies from seed-data.js.');
        await syncSearches();
        break;
    default:
        throw new Error(USAGE);
    }
}

async function syncSearches() {
    const names = await store.syncPremiumSearches(loadConfig().premium);
    console.log(`Premium searches: ${names.join(', ') || 'none (no premium company has a LinkedIn ID)'}`);
}
