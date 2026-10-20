// Supabase → Project Settings → API. Set both to read jobs live from the view public_jobs;
// leave them empty to load jobs.json instead (built by src/build-site.js for GitHub Pages).
// Both values are public by design: the anon / publishable key can only read public_jobs.
// Never put the service_role / secret key here.
window.SUPABASE_URL = 'https://yhhcjffgtdcfvkpxppzb.supabase.co';
window.SUPABASE_ANON_KEY = 'sb_publishable_qDolDAzXkoBaZWJmd-yLKA_ySFQSx9i';
// SHA-256 of the password for the private posts page (posts.html). It only keeps the page out of casual view:
// the posts themselves are readable with the public key above. New password:
//   printf %s 'new password' | sha256sum
window.POSTS_PASSWORD_SHA256 = 'f073146294b84e066865d520ec003bbe804da04b7f53efa416c0965183d92ffc';
