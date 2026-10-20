// Shared by the job page (web/job.html) and the LinkedIn posts (src/linkedin-posts.js), so both pick the same
// Glassdoor role for a job.

// The Glassdoor roles (config salaries.roles) that fit a job, best first. Interns get none: a full-time median
// would mislead. Managers, product, design and data roles don't fall back to software engineer pay.
export function payRoles({ title, role, level }) {
    if (level === 'intern') return [];
    const t = String(title ?? '').toLowerCase();
    const senior = ['senior', 'lead', 'staff', 'principal'].includes(level);
    const byLevel = { principal: 'Principal Software Engineer', staff: 'Staff Software Engineer',
        lead: 'Senior Software Engineer', senior: 'Senior Software Engineer' }[level];
    const byRole = {
        manager: ['Engineering Manager'],
        product: [senior ? 'Senior Product Manager' : 'Product Manager', 'Product Manager'],
        design: ['Product Designer'],
        ml: ['Machine Learning Engineer', 'Data Scientist'],
        data: [/scientist/.test(t) ? 'Data Scientist' : /analyst/.test(t) ? 'Data Analyst' : 'Data Engineer'],
        devops: [/reliability|\bsre\b/.test(t) ? 'Site Reliability Engineer' : 'DevOps Engineer', 'Site Reliability Engineer'],
        qa: ['QA Engineer'],
        mobile: [/android/.test(t) ? 'Android Developer' : /\bios\b/.test(t) ? 'iOS Developer' : 'Mobile Developer', 'Mobile Developer'],
        fullstack: ['Full Stack Developer'],
        frontend: ['Frontend Developer'],
        backend: ['Backend Developer'],
    }[role] ?? [];
    const engineering = !['manager', 'product', 'design', 'data'].includes(role);
    return [...new Set([...(engineering && byLevel ? [byLevel] : []), ...byRole, ...(engineering ? ['Software Engineer'] : [])])];
}
