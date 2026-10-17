// Prints a quick summary of what is in the DB.
import { openDb } from './db.js';

const store = await openDb();
const show = async (title, sql) => {
    console.log(title);
    console.table((await store.query(sql)).rows);
};

await show('Jobs by status:', 'SELECT status, COUNT(*)::int AS count FROM jobs GROUP BY status');
await show('Last 10 runs:', `SELECT id, search_name, status, items_found AS found, items_new AS new,
                                    cost_usd, to_char(started_at, 'YYYY-MM-DD HH24:MI') AS started, error
                             FROM runs ORDER BY id DESC LIMIT 10`);
await show('Latest 10 jobs:', `SELECT title, company, location, posted_at
                               FROM jobs ORDER BY first_seen_at DESC LIMIT 10`);

await store.close();
