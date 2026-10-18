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

// Premium companies: searched on LinkedIn by company ID every few hours (config `premium`) and shown as chips
// on the site. LinkedIn IDs were checked against live searches; companies without one are only matched by name
// until an ID is added (node src/companies.js add <slug> --linkedin-id <id>).
export const COMPANIES = [
    { slug: 'google', name: 'Google', linkedin_id: '1441', linkedin_slug: 'google', domain: 'google.com', aliases: ['Google India', 'Google LLC', 'Alphabet'] },
    { slug: 'microsoft', name: 'Microsoft', linkedin_id: '1035', linkedin_slug: 'microsoft', domain: 'microsoft.com', aliases: ['Microsoft India', 'Microsoft Corporation'] },
    { slug: 'amazon', name: 'Amazon', linkedin_id: '1586', linkedin_slug: 'amazon', domain: 'amazon.com', aliases: ['Amazon.com', 'Amazon Development Centre India'] },
    { slug: 'meta', name: 'Meta', linkedin_id: '10667', linkedin_slug: 'meta', domain: 'meta.com', aliases: ['Facebook', 'Meta Platforms'] },
    { slug: 'apple', name: 'Apple', linkedin_id: '162479', linkedin_slug: 'apple', domain: 'apple.com', aliases: [] },
    { slug: 'adobe', name: 'Adobe', linkedin_id: '1480', linkedin_slug: 'adobe', domain: 'adobe.com', aliases: [] },
    { slug: 'salesforce', name: 'Salesforce', linkedin_id: '3185', linkedin_slug: 'salesforce', domain: 'salesforce.com', aliases: [] },
    { slug: 'oracle', name: 'Oracle', linkedin_id: '1028', linkedin_slug: 'oracle', domain: 'oracle.com', aliases: [] },
    { slug: 'uber', name: 'Uber', linkedin_id: '1815218', linkedin_slug: 'uber-com', domain: 'uber.com', aliases: [] },
    { slug: 'atlassian', name: 'Atlassian', linkedin_id: '22688', linkedin_slug: 'atlassian', domain: 'atlassian.com', aliases: [] },
    { slug: 'coinbase', name: 'Coinbase', linkedin_id: '2857634', linkedin_slug: 'coinbase', domain: 'coinbase.com', aliases: [] },
    { slug: 'stripe', name: 'Stripe', linkedin_id: '2135371', linkedin_slug: 'stripe', domain: 'stripe.com', aliases: [] },
    { slug: 'paypal', name: 'PayPal', linkedin_id: '1482', linkedin_slug: 'paypal', domain: 'paypal.com', aliases: [] },
    { slug: 'visa', name: 'Visa', linkedin_id: '2190', linkedin_slug: 'visa', domain: 'visa.com', aliases: [] },
    { slug: 'mastercard', name: 'Mastercard', linkedin_id: '3015', linkedin_slug: 'mastercard', domain: 'mastercard.com', aliases: [] },
    { slug: 'goldman-sachs', name: 'Goldman Sachs', linkedin_id: '1382', linkedin_slug: 'goldman-sachs', domain: 'goldmansachs.com', aliases: [] },
    { slug: 'jpmorgan', name: 'JPMorgan Chase', linkedin_id: '1068', linkedin_slug: 'jpmorganchase', domain: 'jpmorganchase.com', aliases: ['JPMorganChase', 'JPMorgan Chase & Co.', 'J.P. Morgan'] },
    { slug: 'swiggy', name: 'Swiggy', linkedin_id: '9252341', linkedin_slug: 'swiggy-in', domain: 'swiggy.com', aliases: [] },
    { slug: 'flipkart', name: 'Flipkart', linkedin_id: '321062', linkedin_slug: 'flipkart', domain: 'flipkart.com', aliases: ['Flipkart Internet'] },
    { slug: 'zomato', name: 'Zomato', linkedin_id: '422813', linkedin_slug: 'zomato', domain: 'zomato.com', aliases: ['Eternal'] },
    { slug: 'razorpay', name: 'Razorpay', linkedin_id: '2770855,13616753,3788927', linkedin_slug: 'razorpay', domain: 'razorpay.com', aliases: [] },
    { slug: 'phonepe', name: 'PhonePe', linkedin_id: '10479149', linkedin_slug: 'phonepe-internet', domain: 'phonepe.com', aliases: ['PhonePe Private Limited'] },
    { slug: 'cred', name: 'CRED', linkedin_id: '14485479', linkedin_slug: 'credapp', domain: 'cred.club', aliases: ['CRED Club', 'Dreamplug Technologies'] },
    { slug: 'zerodha', name: 'Zerodha', linkedin_id: '2160857', linkedin_slug: 'zerodha', domain: 'zerodha.com', aliases: [] },
].map((c, i) => ({ ...c, sort_order: (i + 1) * 10 }));
