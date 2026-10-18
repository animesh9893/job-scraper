// Keyword matching for Telegram alerts. Text is cut into lowercase words, so "React.js", "ReactJS"
// and "react js" all become "react", and a keyword matches a run of words even when the job writes
// it with a hyphen or a space ("frontend engineer" matches "Front-End Engineer II").

// "<lib>.js", "<lib>js" and "<lib> js" mean the library itself.
const JS_LIBS = /\b(react|node|vue|next|nuxt|express|angular|nest|svelte|solid|three|ember|backbone|d3)[\s.-]?js\b/g;
const ALIASES = { golang: 'go', bangalore: 'bengaluru', k8s: 'kubernetes', reactnative: 'react native' };

export function words(text) {
    const out = [];
    for (const w of String(text ?? '').toLowerCase().replace(JS_LIBS, '$1').match(/[a-z0-9+#]+/g) ?? []) {
        out.push(...(ALIASES[w] ?? w).split(' '));
    }
    return out;
}

/** True when the words of `needle` appear in `hay` back to back, ignoring how they were split. */
export function hasPhrase(hay, needle) {
    const target = needle.join('');
    if (!target) return false;
    for (let i = 0; i < hay.length; i++) {
        let joined = '';
        for (let j = i; j < hay.length; j++) {
            joined += hay[j];
            if (joined === target) return true;
            if (!target.startsWith(joined)) break;
        }
    }
    return false;
}

/** Wraps a job so its words are only worked out once for all subscribers. */
export function prepareJob(job) {
    const title = words(job.title);
    let anywhere;
    return {
        job,
        title,
        get anywhere() { return (anywhere ??= [...title, ...words(job.company), ...words(job.description)]); },
        location: words(job.location),
    };
}

function locationMatches(prepared, loc) {
    const want = words(loc);
    if (want.length === 1 && (want[0] === 'remote' || want[0] === 'hybrid') && prepared.job.workplace === want[0]) return true;
    return hasPhrase(prepared.location, want);
}

/**
 * A subscriber gets a job when any keyword matches (in the title, or anywhere for `anywhere`
 * keywords) and, if they set locations, any location matches too.
 */
export function matches(prepared, { keywords = [], locations = [] }) {
    const keywordHit = keywords.some((k) => hasPhrase(k.anywhere ? prepared.anywhere : prepared.title, words(k.text)));
    if (!keywordHit) return false;
    return locations.length === 0 || locations.some((loc) => locationMatches(prepared, loc));
}
