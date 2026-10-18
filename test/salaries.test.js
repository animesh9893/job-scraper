import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salaryRows } from '../src/scrape.js';

// Shaped like axlymxp/glassdoor-salary-scraper rows (Razorpay, India, 2026-10-18).
const row = (job_title, extra = {}) => ({
    query: job_title, company_name: 'Razorpay', job_title, pay_period: 'ANNUAL', currency: 'INR', location_name: 'India',
    total_pay_median: 1790000, total_pay_p10: 696000, total_pay_p90: 2820000, ...extra,
});
const fx = new Map([['USD', 1], ['INR', 1 / 94.94]]);

test('annual rows keep total pay percentiles', () => {
    const [r] = salaryRows([row('Software Engineer')], fx);
    assert.deepEqual({ ...r, usdPerUnit: undefined }, {
        title: 'Software Engineer', query: 'Software Engineer', currency: 'INR', payPeriod: 'ANNUAL',
        min: 696000, median: 1790000, max: 2820000, usdPerUnit: undefined, location: 'India',
    });
    assert.equal(r.usdPerUnit, 1 / 94.94);
});

test('monthly pay becomes yearly, hourly and duplicate titles are dropped', () => {
    const rows = salaryRows([
        row('Data Analyst', { pay_period: 'MONTHLY', total_pay_median: 100000, total_pay_p10: 50000, total_pay_p90: 150000 }),
        row('Android Developer', { pay_period: 'HOURLY', total_pay_median: 30 }),
        row('Data Analyst', { query: 'Business Analyst' }),
    ], fx);
    assert.deepEqual(rows.map((r) => [r.title, r.min, r.median, r.max]), [['Data Analyst', 600000, 1200000, 1800000]]);
});

test('falls back to base pay, and leaves USD empty for an unknown currency', () => {
    const [r] = salaryRows([row('QA Engineer', { currency: 'XYZ', total_pay_median: null, base_pay_mean: 480000,
        total_pay_p10: null, total_pay_p90: null })], fx);
    assert.equal(r.median, 480000);
    assert.equal(r.min, null);
    assert.equal(r.usdPerUnit, null);
});
