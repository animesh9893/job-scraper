import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const CONFIG_PATH = process.env.CONFIG_PATH ?? 'config/config.yaml';

export function loadConfig() {
    const config = parse(readFileSync(CONFIG_PATH, 'utf8'));

    if (!config.actor) throw new Error(`${CONFIG_PATH}: "actor" is required`);
    if (!Array.isArray(config.searches) || config.searches.length === 0) {
        throw new Error(`${CONFIG_PATH}: add at least one entry under "searches"`);
    }
    for (const s of config.searches) {
        if (!s.name || !s.input) throw new Error(`${CONFIG_PATH}: each search needs "name" and "input"`);
    }

    return {
        source: 'linkedin',
        timeoutSecs: 900,
        ...config,
        searches: config.searches.map((s) => ({ ...s, input: { ...config.defaults, ...s.input } })),
        filters: { excludeTitleWords: [], excludeCompanies: [], ...config.filters },
        site: { title: 'Tech Jobs', maxAgeDays: 30, maxJobs: 1000, ...config.site },
    };
}

export function requireEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing env var ${name} (set it in .env locally, or as a GitHub Actions secret)`);
    return value;
}
