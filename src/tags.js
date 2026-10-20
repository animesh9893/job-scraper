// Tags a job from its title and description with plain keyword rules, no AI: its role, its level and the
// tech it names. Matching reuses the Telegram alert word rules, so "React.js", "ReactJS" and "react js" agree.
// To tag a new technology, add a line to STACK.
import { words, hasPhrase } from './telegram-match.js';

// Tag → phrases that mean it. Matched as whole words in the title and the description.
export const STACK = {
    JavaScript: ['javascript', 'js', 'es6'],
    TypeScript: ['typescript', 'ts'],
    React: ['react'],
    'React Native': ['react native'],
    'Next.js': ['nextjs', 'next'],
    Angular: ['angular', 'angularjs'],
    Vue: ['vue', 'vuejs', 'nuxt'],
    'Node.js': ['node', 'nodejs'],
    Java: ['java'],
    'Spring Boot': ['spring boot', 'springboot', 'spring'],
    Kotlin: ['kotlin'],
    Swift: ['swift', 'swiftui'],
    Flutter: ['flutter', 'dart'],
    Python: ['python', 'django', 'flask', 'fastapi'],
    Go: ['go'],
    Rust: ['rust'],
    'C++': ['c++', 'cpp'],
    'C#': ['c#', 'dotnet', 'net core', 'asp net'],
    Ruby: ['ruby', 'rails'],
    PHP: ['php', 'laravel'],
    Scala: ['scala'],
    SQL: ['sql', 'mysql', 'postgres', 'postgresql'],
    MongoDB: ['mongodb', 'mongo'],
    Redis: ['redis'],
    Kafka: ['kafka'],
    GraphQL: ['graphql'],
    AWS: ['aws', 'amazon web services'],
    GCP: ['gcp', 'google cloud'],
    Azure: ['azure'],
    Docker: ['docker'],
    Kubernetes: ['kubernetes'],
    Terraform: ['terraform'],
    Spark: ['spark', 'pyspark'],
    'Machine Learning': ['machine learning', 'ml', 'deep learning', 'pytorch', 'tensorflow'],
    GenAI: ['genai', 'generative ai', 'llm', 'llms'],
    Microservices: ['microservices', 'microservice'],
};

// First match wins, so the more specific roles come first. Read from the title only.
const ROLES = [
    ['manager', ['engineering manager', 'manager engineering', 'head of engineering', 'director', 'vp engineering']],
    ['product', ['product manager', 'product owner']],
    ['design', ['designer', 'ux', 'ui ux']],
    ['ml', ['machine learning', 'ml', 'ai engineer', 'applied scientist', 'research scientist', 'genai', 'llm']],
    ['data', ['data engineer', 'data scientist', 'data analyst', 'analytics engineer', 'big data', 'etl']],
    ['devops', ['devops', 'sre', 'site reliability', 'platform engineer', 'cloud engineer', 'infrastructure']],
    ['security', ['security', 'appsec', 'devsecops']],
    ['qa', ['qa', 'sdet', 'test engineer', 'automation tester', 'quality']],
    ['mobile', ['android', 'ios', 'mobile', 'flutter', 'react native']],
    ['fullstack', ['full stack', 'fullstack', 'mern', 'mean']],
    ['frontend', ['frontend', 'front end', 'ui developer', 'ui engineer', 'react', 'angular', 'vue']],
    ['backend', ['backend', 'back end', 'java', 'golang', 'go', 'python', 'node', 'api', 'server side']],
];

// Highest level first, so "Senior Staff Engineer" is staff.
const LEVELS = [
    ['principal', ['principal', 'distinguished', 'architect']],
    ['staff', ['staff']],
    ['lead', ['lead', 'tech lead', 'team lead']],
    ['senior', ['senior', 'sr', 'sde 3', 'sde iii', 'iii', 'sde3']],
    ['junior', ['junior', 'jr', 'fresher', 'entry level', 'graduate', 'trainee', 'associate', 'sde 1', 'sde i', 'sde1']],
    ['intern', ['intern', 'internship']],
];

// Everyday words ("go live", "next steps", "swift response") count only in the title, never the description.
const TITLE_ONLY = new Set(['go', 'next', 'swift', 'spring', 'rust', 'node', 'ts', 'js']);

const phrases = (list) => list.map((p) => words(p));
const STACK_WORDS = Object.entries(STACK).map(([tag, list]) => [tag, phrases(list)]);
const ROLE_WORDS = ROLES.map(([role, list]) => [role, phrases(list)]);
const LEVEL_WORDS = LEVELS.map(([level, list]) => [level, phrases(list)]);
const first = (rules, hay) => rules.find(([, list]) => list.some((p) => hasPhrase(hay, p)))?.[0] ?? null;

/**
 * { role, level, tags } for a job. `role` falls back to the search's category (frontend / backend / …), `level`
 * to "mid", and `tags` lists the tech the title names first, then what only the description names.
 */
export function tagJob({ title, description, category }) {
    const t = words(title);
    const d = words(description);
    const inTitle = STACK_WORDS.filter(([, list]) => list.some((p) => hasPhrase(t, p))).map(([tag]) => tag);
    const inText = STACK_WORDS.filter(([tag, list]) => !inTitle.includes(tag) &&
        list.some((p) => !TITLE_ONLY.has(p.join(' ')) && hasPhrase(d, p))).map(([tag]) => tag);
    return {
        role: first(ROLE_WORDS, t) ?? category ?? null,
        level: first(LEVEL_WORDS, t) ?? 'mid',
        tags: [...inTitle, ...inText],
    };
}
