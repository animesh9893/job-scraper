// Apify credit across several tokens, shared by the job scrape (src/run.js) and the salary fetch (src/salaries.js).
import { loadTokens, checkToken, nextUsableToken } from './tokens.js';
import { createClient } from './scrape.js';

/**
 * Loads the tokens (src/tokens.js) and returns { withCredit, current, finish, count, noCreditError }.
 * withCredit(fn) runs fn(client) with a token that has at least minRemainingUsd left. When a run fails and the
 * token turns out to be out of credit, it switches to the next token and runs fn again. It returns { result },
 * or { noCredit: true } when no token has credit left; other errors are thrown.
 */
export async function apifyCredit(store, minRemainingUsd) {
    const tokens = await loadTokens(store);
    const usedUp = new Set();
    let token = null;

    // Keeps the current token while it has enough credit left, otherwise moves on to the next one.
    async function pickToken() {
        if (token) {
            await checkToken(store, token);
            if (token.remaining_usd != null && token.remaining_usd >= minRemainingUsd) return token;
            console.log(`  ↪ token "${token.label}" has ${token.remaining_usd == null ? 'an error' : `$${token.remaining_usd.toFixed(2)} left`}, switching`);
            usedUp.add(token);
        }
        token = await nextUsableToken(store, tokens, minRemainingUsd, usedUp);
        return token;
    }

    async function withCredit(fn) {
        while (true) {
            if (!(await pickToken())) return { noCredit: true };
            try {
                return { result: await fn(createClient(token.token)) };
            } catch (err) {
                await checkToken(store, token);
                if (token.remaining_usd == null || token.remaining_usd < minRemainingUsd) continue;
                throw err;
            }
        }
    }

    return {
        withCredit,
        count: tokens.length,
        /** The token in use, for logging which account paid for a run. */
        current: () => token,
        /** Saves the latest remaining credit of the token we ended on. */
        finish: async () => { if (token) await checkToken(store, token); },
        noCreditError: () => `No Apify token has at least $${minRemainingUsd} left this month`,
    };
}
