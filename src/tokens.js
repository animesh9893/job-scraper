// Apify tokens: several Apify accounts stored in Supabase (table apify_tokens), each checked against
// its monthly usage and used in priority order, with the APIFY_TOKEN secret as the last one.
// Usage: node src/tokens.js                                  → check every token, save and print what's left
//        node src/tokens.js add <apify_api_...> [label] [priority]  → check a token with Apify and save it
//        node src/tokens.js enable|disable|remove <label>
import { ApifyClient } from 'apify-client';
import { pathToFileURL } from 'node:url';
import { openDb } from './db.js';

/** Active tokens in priority order, then APIFY_TOKEN from the environment if it isn't one of them. */
export async function loadTokens(store) {
    const { rows } = await store.query(
        'SELECT id, label, token, priority FROM apify_tokens WHERE is_active ORDER BY priority, id');
    const env = process.env.APIFY_TOKEN;
    if (env && !rows.some((r) => r.token === env)) rows.push({ id: null, label: 'APIFY_TOKEN secret', token: env });
    return rows;
}

/** Asks Apify how much of this month's usage is left for the token's account, and saves it. */
export async function checkToken(store, tok) {
    let result;
    try {
        const { limits, current, monthlyUsageCycle } = await new ApifyClient({ token: tok.token }).user('me').limits();
        result = {
            monthly_limit_usd: limits.maxMonthlyUsageUsd,
            used_usd: current.monthlyUsageUsd,
            remaining_usd: Math.max(0, Math.round((limits.maxMonthlyUsageUsd - current.monthlyUsageUsd) * 1e4) / 1e4),
            cycle_end_at: monthlyUsageCycle.endAt,
            last_error: null,
        };
    } catch (err) {
        result = { remaining_usd: null, last_error: err.message };
    }
    Object.assign(tok, result);

    if (tok.id != null) {
        try {
            await store.query(
                `UPDATE apify_tokens SET monthly_limit_usd = COALESCE($2, monthly_limit_usd), used_usd = COALESCE($3, used_usd),
                     remaining_usd = $4, cycle_end_at = COALESCE($5, cycle_end_at), last_error = $6, last_checked_at = now()
                 WHERE id = $1`,
                [tok.id, result.monthly_limit_usd ?? null, result.used_usd ?? null, result.remaining_usd,
                    result.cycle_end_at ?? null, result.last_error]);
        } catch (err) {
            console.warn(`  ! couldn't save usage of token "${tok.label}": ${err.message}`);
        }
    }
    return tok;
}

/** First token (in priority order) with at least minRemainingUsd left, or null. Checks tokens lazily. */
export async function nextUsableToken(store, tokens, minRemainingUsd, skip = new Set()) {
    for (const tok of tokens) {
        if (skip.has(tok)) continue;
        if (tok.remaining_usd === undefined) await checkToken(store, tok);
        if (tok.remaining_usd != null && tok.remaining_usd >= minRemainingUsd) return tok;
        skip.add(tok);
    }
    return null;
}

/** Checks the token with Apify, then inserts it (or updates the row with the same token). */
export async function addToken(store, token, label, priority) {
    if (!token?.startsWith('apify_api_')) throw new Error('Usage: add <apify_api_...token> [label] [priority]');
    const user = await new ApifyClient({ token }).user('me').get();   // fails here if the token is wrong
    if (!user) throw new Error('Apify did not accept this token');

    const { rows: [row] } = await store.query(
        `INSERT INTO apify_tokens (label, token, priority, is_active)
         VALUES ($1, $2, COALESCE($3, (SELECT COALESCE(MAX(priority), 0) + 1 FROM apify_tokens)), true)
         ON CONFLICT (token) DO UPDATE SET label = EXCLUDED.label, is_active = true,
             priority = COALESCE($3, apify_tokens.priority)
         RETURNING id, label, token, priority`,
        [label || user.username, token, priority == null ? null : Number(priority)]);
    return checkToken(store, row);
}

const fmt = (n) => (n == null ? '-' : `$${Number(n).toFixed(2)}`);

function printTokens(tokens) {
    console.table(tokens.map((t) => ({
        label: t.label, priority: t.priority ?? 'last', used: fmt(t.used_usd), limit: fmt(t.monthly_limit_usd),
        remaining: fmt(t.remaining_usd), resets: t.cycle_end_at ? new Date(t.cycle_end_at).toISOString().slice(0, 10) : '-',
        error: t.last_error ?? '',
    })));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [command, ...args] = process.argv.slice(2);
    const store = await openDb();
    try {
        if (command === 'add') {
            const tok = await addToken(store, ...args);
            console.log(`Saved token "${tok.label}" (priority ${tok.priority}).`);
            printTokens([tok]);
        } else if (['enable', 'disable', 'remove'].includes(command)) {
            const { rowCount } = command === 'remove'
                ? await store.query('DELETE FROM apify_tokens WHERE label = $1', [args[0]])
                : await store.query('UPDATE apify_tokens SET is_active = $2 WHERE label = $1', [args[0], command === 'enable']);
            if (!rowCount) throw new Error(`No token labelled "${args[0]}"`);
            console.log(`${command[0].toUpperCase()}${command.slice(1, -1)}ed token "${args[0]}".`);
        } else if (!command) {
            const tokens = await loadTokens(store);
            for (const tok of tokens) await checkToken(store, tok);
            printTokens(tokens);
            console.log(`Total remaining: ${fmt(tokens.reduce((sum, t) => sum + (t.remaining_usd ?? 0), 0))}`);
        } else {
            throw new Error('Usage: node src/tokens.js [add <token> [label] [priority] | enable|disable|remove <label>]');
        }
    } catch (err) {
        console.error(`✖ ${err.message}`);
        process.exitCode = 1;
    } finally {
        await store.close();
    }
}
