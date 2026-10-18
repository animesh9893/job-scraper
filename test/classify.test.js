import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLabels, availableProviders, classifyBatch, buildPrompt } from '../src/classify-ai.js';

const reply = (status, body = {}, headers = {}) => ({
    ok: status === 200, status,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    json: async () => body,
});
const answer = (jobs) => reply(200, { choices: [{ message: { content: JSON.stringify({ jobs }) } }] });
const providers = availableProviders(
    [{ name: 'gemini', model: 'g' }, { name: 'groq', model: 'q' }, { name: 'openrouter', model: 'o' }],
    { GEMINI_API_KEY: 'a', GROQ_API_KEY: 'b' });
const jobs = [{ title: 'React Developer', description: 'x' }, { title: 'Data Engineer', description: 'y' }];

test('parseLabels keeps only valid labels', () => {
    const labels = parseLabels('```json\n' + JSON.stringify({ jobs: [
        { id: 0, role: 'Frontend', skills: ['React', 'react', ' TypeScript ', 5], minYears: 3 },
        { id: 1, role: 'wizard', skills: [] },
        { id: 7, role: 'backend' },
        { id: 0, role: 'backend' },
    ] }) + '\n```', 2);
    assert.deepEqual([...labels], [[0, { role: 'frontend', skills: ['react', 'typescript'], minYears: 3 }]]);
    assert.equal(parseLabels('not json', 2).size, 0);
    assert.equal(parseLabels(JSON.stringify([{ id: 1, role: 'data', minYears: 'five' }]), 2).get(1).minYears, null);
});

test('only providers with a key are used, in config order', () => {
    assert.deepEqual(providers.map((p) => p.name), ['gemini', 'groq']);
});

test('prompt truncates descriptions', () => {
    assert.match(buildPrompt([{ title: 'T', description: 'a  b\n' + 'c'.repeat(100) }], 10), /Description: a b c{6}$/);
});

test('a rate-limited provider falls back to the next and stays out for the run', async () => {
    const calls = [];
    const fetchFn = async (url) => {
        calls.push(url.includes('groq') ? 'groq' : 'gemini');
        return url.includes('groq') ? answer([{ id: 0, role: 'frontend' }, { id: 1, role: 'data' }]) : reply(429, {}, { 'retry-after': '3600' });
    };
    const state = { skipped: new Set(), errors: [] };
    const first = await classifyBatch(jobs, providers, state, { fetchFn });
    assert.equal(first.model, 'groq:q');
    assert.equal(first.labels.size, 2);
    await classifyBatch(jobs, providers, state, { fetchFn });
    assert.deepEqual(calls, ['gemini', 'groq', 'groq']);
});

test('every provider failing leaves the batch unlabeled without throwing', async () => {
    const state = { skipped: new Set(), errors: [] };
    const fetchFn = async (url) => (url.includes('groq') ? reply(500) : Promise.reject(new Error('offline')));
    const result = await classifyBatch(jobs, providers, state, { fetchFn });
    assert.equal(result.model, null);
    assert.deepEqual([...state.skipped], ['gemini', 'groq']);
});
