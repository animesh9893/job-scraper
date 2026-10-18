// Manages the searches (and categories) the scraper runs, stored in Supabase.
// Usage:
//   node src/searches.js                                   → list searches, stalest first
//   node src/searches.js add <name> --keywords "react developer" [--category frontend]
//                            [--workplace remote] [--location India] [--priority 100] [--input '{"distance":25}']
//   node src/searches.js enable|disable|remove <name>
//   node src/searches.js categories                        → list categories
//   node src/searches.js category <slug> <label> [sort]    → add or rename a category
//   node src/searches.js seed                              → add the starting searches and categories again
//   node src/searches.js import <file.json>                → add or update many searches at once
//                            (a list of { name, category, workplace, input, priority })
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openDb, seed } from './db.js';

const USAGE = 'Usage: node src/searches.js [list | add <name> --keywords "..." | enable <name> | disable <name> | ' +
    'remove <name> | categories | category <slug> <label> [sort] | seed | import <file.json>]';

const { positionals: [command = 'list', ...args], values } = parseArgs({
    allowPositionals: true,
    options: {
        keywords: { type: 'string' },
        category: { type: 'string' },
        workplace: { type: 'string' },
        location: { type: 'string' },
        priority: { type: 'string' },
        input: { type: 'string' },
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
    const [name] = args;

    switch (command) {
    case 'list': {
        const { rows } = await q(`
            SELECT name, category, workplace, input->>'keywords' AS keywords, input->>'location' AS location,
                   is_active AS active, priority, interval_hours AS every_h, to_char(last_run_at, 'YYYY-MM-DD HH24:MI') AS last_run,
                   last_status, last_error
            FROM searches ORDER BY is_active DESC, last_run_at ASC NULLS FIRST, priority, created_at DESC, name`);
        console.table(rows);
        console.log('Rows at the top run next.');
        break;
    }
    case 'add': {
        if (!name) throw new Error('Usage: add <name> --keywords "..." [--category slug] [--workplace remote|hybrid]');
        const input = values.input ? JSON.parse(values.input) : {};
        if (values.keywords) input.keywords = values.keywords;
        if (values.location) input.location = values.location;
        if (!input.keywords && !input.urls) throw new Error('Give --keywords (or "urls" in --input)');
        if (values.workplace && !['remote', 'hybrid'].includes(values.workplace)) {
            throw new Error('--workplace must be remote or hybrid');
        }
        if (values.category && !(await q('SELECT 1 FROM categories WHERE slug = $1', [values.category])).rowCount) {
            throw new Error(`No category "${values.category}". Add it first: node src/searches.js category ${values.category} "<Label>"`);
        }
        const priority = values.priority === undefined ? 100 : Number(values.priority);
        if (!Number.isInteger(priority)) throw new Error('--priority must be a whole number');

        await q(`INSERT INTO searches (name, category, workplace, input, priority) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (name) DO UPDATE SET category = EXCLUDED.category, workplace = EXCLUDED.workplace,
                                                  input = EXCLUDED.input, priority = EXCLUDED.priority, is_active = true`,
        [name, values.category ?? null, values.workplace ?? null, input, priority]);
        console.log(`Saved search "${name}". It runs in an upcoming scrape (never-run searches go first).`);
        break;
    }
    case 'enable':
    case 'disable': {
        const { rowCount } = await q('UPDATE searches SET is_active = $2 WHERE name = $1', [name, command === 'enable']);
        if (!rowCount) throw new Error(`No search named "${name}"`);
        console.log(`${command === 'enable' ? 'Enabled' : 'Disabled'} "${name}".`);
        break;
    }
    case 'remove': {
        const { rowCount } = await q('DELETE FROM searches WHERE name = $1', [name]);
        if (!rowCount) throw new Error(`No search named "${name}"`);
        console.log(`Removed "${name}". Jobs it already found stay.`);
        break;
    }
    case 'categories':
        console.table((await q('SELECT slug, label, sort_order FROM categories ORDER BY sort_order, slug')).rows);
        break;
    case 'category': {
        const [slug, label, sort] = args;
        if (!slug || !label) throw new Error('Usage: category <slug> <label> [sort]');
        if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('slug may only use a-z, 0-9 and -');
        await q(`INSERT INTO categories (slug, label, sort_order) VALUES ($1, $2, $3)
                 ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order`,
        [slug, label, sort === undefined ? 100 : Number(sort)]);
        console.log(`Saved category "${slug}" (${label}).`);
        break;
    }
    case 'import': {
        if (!name) throw new Error('Usage: import <file.json>');
        const list = JSON.parse(readFileSync(name, 'utf8'));
        const { rows } = await q('SELECT slug FROM categories');
        const known = new Set(rows.map((r) => r.slug));
        for (const s of list) {
            if (!s.name || !(s.input?.keywords || s.input?.urls)) throw new Error(`Each search needs "name" and "input.keywords": ${JSON.stringify(s)}`);
            if (s.category && !known.has(s.category)) throw new Error(`${s.name}: no category "${s.category}"`);
            if (s.workplace && !['remote', 'hybrid'].includes(s.workplace)) throw new Error(`${s.name}: workplace must be remote or hybrid`);
        }
        for (const s of list) {
            await q(`INSERT INTO searches (name, category, workplace, input, priority) VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (name) DO UPDATE SET category = EXCLUDED.category, workplace = EXCLUDED.workplace,
                                                      input = EXCLUDED.input, priority = EXCLUDED.priority`,
            [s.name, s.category ?? null, s.workplace ?? null, s.input, s.priority ?? 100]);
        }
        console.log(`Imported ${list.length} searches from ${name}.`);
        break;
    }
    case 'seed':
        await seed(store);
        console.log('Added the starting categories and searches (existing ones were kept).');
        break;
    default:
        throw new Error(USAGE);
    }
}
