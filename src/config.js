import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const CONFIG_PATH = process.env.CONFIG_PATH ?? 'config/config.yaml';

export function loadConfig() {
    const config = parse(readFileSync(CONFIG_PATH, 'utf8'));

    if (!config.actor) throw new Error(`${CONFIG_PATH}: "actor" is required`);
    if (config.searchesPerRun !== undefined && !(Number.isInteger(config.searchesPerRun) && config.searchesPerRun > 0)) {
        throw new Error(`${CONFIG_PATH}: "searchesPerRun" must be a whole number above 0`);
    }

    return {
        source: 'linkedin',
        timeoutSecs: 900,
        searchesPerRun: 2,
        defaults: {},
        ...config,
        filters: { excludeTitleWords: [], excludeCompanies: [], ...config.filters },
        site: { title: 'Tech Jobs', maxAgeDays: 30, maxJobs: 1000, ...config.site },
    };
}

export function requireEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing env var ${name} (set it in .env locally, or as a GitHub Actions secret)`);
    return value;
}
