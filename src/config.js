import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const CONFIG_PATH = process.env.CONFIG_PATH ?? 'config/config.yaml';

export function loadConfig() {
    const config = parse(readFileSync(CONFIG_PATH, 'utf8'));

    if (!config.actor) throw new Error(`${CONFIG_PATH}: "actor" is required`);
    if (config.searchesPerRun !== undefined && config.searchesPerRun !== 'all'
        && !(Number.isInteger(config.searchesPerRun) && config.searchesPerRun > 0)) {
        throw new Error(`${CONFIG_PATH}: "searchesPerRun" must be a whole number above 0, or all`);
    }

    return {
        source: 'linkedin',
        timeoutSecs: 900,
        searchesPerRun: 2,
        minRemainingUsd: 0.1,
        defaults: {},
        ...config,
        filters: { excludeTitleWords: [], excludeCompanies: [], ...config.filters },
        premium: { keywords: 'software engineer', location: 'India', intervalHours: 6, jobsPerSearch: 25, companiesPerSearch: 10, lookupsPerRun: 3, ...config.premium },
        salaries: { actor: 'axlymxp/glassdoor-salary-scraper', companiesPerRun: 2, refreshDays: 14, location: 'India',
            locationType: 'country', roles: ['Software Engineer'], ...config.salaries },
        site: { title: 'Tech Jobs', maxAgeDays: 30, maxJobs: 1000, ...config.site },
        linkedin: { siteUrl: '', jobsPerPost: 6, minJobs: 3, hashtags: [], maxHashtags: 10, people: [], ...config.linkedin },
    };
}

export function requireEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing env var ${name} (set it in .env locally, or as a GitHub Actions secret)`);
    return value;
}
