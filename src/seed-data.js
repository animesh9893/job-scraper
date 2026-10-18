// Starting categories and searches, inserted into Supabase the first time the scraper runs
// (or with `node src/searches.js seed`). After that, Supabase is the source of truth.
export const CATEGORIES = [
    { slug: 'frontend', label: 'Frontend', sort_order: 10 },
    { slug: 'backend', label: 'Backend', sort_order: 20 },
    { slug: 'fullstack', label: 'Full stack', sort_order: 30 },
    { slug: 'mobile', label: 'Mobile', sort_order: 40 },
];

export const SEARCHES = [
    { name: 'frontend-india', category: 'frontend', input: { keywords: 'frontend developer' } },
    { name: 'frontend-remote', category: 'frontend', workplace: 'remote', input: { keywords: 'frontend developer remote' } },
    { name: 'backend-india', category: 'backend', input: { keywords: 'backend developer' } },
    { name: 'backend-remote', category: 'backend', workplace: 'remote', input: { keywords: 'backend developer remote' } },
    { name: 'fullstack-india', category: 'fullstack', input: { keywords: 'full stack developer' } },
    { name: 'fullstack-remote', category: 'fullstack', workplace: 'remote', input: { keywords: 'full stack developer remote' } },
    { name: 'mobile-india', category: 'mobile', input: { keywords: 'mobile app developer android ios' } },
    { name: 'mobile-remote', category: 'mobile', workplace: 'remote', input: { keywords: 'mobile app developer remote' } },
];
