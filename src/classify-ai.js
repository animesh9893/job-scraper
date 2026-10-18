// Labels jobs with an LLM: a role, the main skills and the minimum years of experience. Free providers
// only, tried in order (config classify.providers), each through its OpenAI-compatible chat endpoint.
// A provider that is rate limited or down is skipped for the rest of the run; when every one is, the
// jobs stay unlabeled and the next run picks them up. Nothing here throws on an API failure.

export const ROLES = ['frontend', 'backend', 'fullstack', 'mobile', 'devops', 'data', 'ml', 'qa', 'security',
    'embedded', 'manager', 'product', 'design', 'other'];

export const PROVIDERS = {
    gemini: { env: 'GEMINI_API_KEY', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
    groq: { env: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/chat/completions' },
    openrouter: { env: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1/chat/completions' },
};

const MAX_WAIT_SECS = 20;   // a per-minute limit is worth waiting out once; a daily quota isn't

const SYSTEM = `You classify job postings. For each job reply with an object:
{"id": <the job's id>, "role": one of ${ROLES.map((r) => `"${r}"`).join(', ')},
 "skills": up to 6 main technologies or skills, lowercase, short (e.g. "react", "aws", "kubernetes"),
 "minYears": minimum years of experience asked for as a whole number, or null if not stated}
Use "fullstack" only when the job is clearly both frontend and backend. Use "other" for non-engineering jobs.
Reply with JSON only: {"jobs": [ ... ]} with one object per job, in any order.`;

export function buildPrompt(jobs, descriptionChars) {
    return jobs.map((j, i) => [
        `### id: ${i}`,
        `Title: ${j.title ?? ''}`,
        j.seniority ? `Seniority: ${j.seniority}` : null,
        `Description: ${(j.description ?? '').replace(/\s+/g, ' ').slice(0, descriptionChars)}`,
    ].filter(Boolean).join('\n')).join('\n\n');
}

/** Turns the model's reply into labels by batch index; anything malformed is dropped (that job stays unlabeled). */
export function parseLabels(text, count) {
    const json = String(text ?? '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
    let data;
    try { data = JSON.parse(json); } catch { return new Map(); }
    const items = Array.isArray(data) ? data : data?.jobs;
    const labels = new Map();
    for (const item of Array.isArray(items) ? items : []) {
        const id = Number(item?.id);
        if (!Number.isInteger(id) || id < 0 || id >= count || labels.has(id)) continue;
        const role = String(item.role ?? '').toLowerCase().trim();
        if (!ROLES.includes(role)) continue;
        const skills = [...new Set((Array.isArray(item.skills) ? item.skills : [])
            .filter((s) => typeof s === 'string')
            .map((s) => s.toLowerCase().trim().slice(0, 40))
            .filter(Boolean))].slice(0, 6);
        const years = Number(item.minYears);
        const minYears = item.minYears != null && Number.isInteger(years) && years >= 0 && years <= 30 ? years : null;
        labels.set(id, { role, skills, minYears });
    }
    return labels;
}

/** Providers from config that have their API key set, in order. */
export function availableProviders(list, env = process.env) {
    return (list ?? []).filter((p) => PROVIDERS[p.name] && p.model && env[PROVIDERS[p.name].env])
        .map((p) => ({ ...p, ...PROVIDERS[p.name], key: env[PROVIDERS[p.name].env] }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One request. Returns { text } on success, or { error, skip } where skip means stop using this provider
 * for the rest of the run (rate limit that won't clear soon, bad key, server down).
 */
export async function callProvider(provider, user, { fetchFn = fetch, retried = false } = {}) {
    let res;
    try {
        res = await fetchFn(provider.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
            body: JSON.stringify({
                model: provider.model,
                temperature: 0,
                response_format: { type: 'json_object' },
                messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
            }),
            signal: AbortSignal.timeout(60_000),
        });
    } catch (err) {
        return { error: `network: ${err.message}`, skip: true };
    }
    if (res.ok) {
        const data = await res.json().catch(() => null);
        return { text: data?.choices?.[0]?.message?.content ?? '' };
    }
    // Only the status goes to the log: the repo is public and the body may echo the prompt.
    const wait = Number(res.headers.get('retry-after'));
    if ((res.status === 429 || res.status >= 500) && !retried && Number.isFinite(wait) && wait > 0 && wait <= MAX_WAIT_SECS) {
        await sleep(wait * 1000);
        return callProvider(provider, user, { fetchFn, retried: true });
    }
    return { error: `HTTP ${res.status}`, skip: res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500 };
}

/**
 * Labels one batch with the first provider that answers. `state.skipped` collects providers that are out
 * for this run. Returns { labels: Map(index → label), model } (labels empty when no provider answered).
 */
export async function classifyBatch(jobs, providers, state, { descriptionChars = 600, fetchFn } = {}) {
    const user = buildPrompt(jobs, descriptionChars);
    for (const p of providers) {
        if (state.skipped.has(p.name)) continue;
        const result = await callProvider(p, user, { fetchFn });
        if (result.text !== undefined) {
            const labels = parseLabels(result.text, jobs.length);
            if (labels.size) return { labels, model: `${p.name}:${p.model}` };
            state.errors.push(`${p.name}: unreadable reply`);
            continue;
        }
        state.errors.push(`${p.name}: ${result.error}`);
        if (result.skip) state.skipped.add(p.name);
    }
    return { labels: new Map(), model: null };
}
