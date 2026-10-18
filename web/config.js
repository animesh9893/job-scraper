// Supabase → Project Settings → API. Set both to read jobs live from the view public_jobs;
// leave them empty to load jobs.json instead (built by src/build-site.js for GitHub Pages).
// Both values are public by design: the anon / publishable key can only read public_jobs.
// Never put the service_role / secret key here.
window.SUPABASE_URL = '';
window.SUPABASE_ANON_KEY = '';
