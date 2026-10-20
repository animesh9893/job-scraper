import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagJob } from '../src/tags.js';

const tag = (title, description = '', category = 'backend') => tagJob({ title, description, category });

test('role from the title, else the search category', () => {
    assert.equal(tag('Senior React Developer').role, 'frontend');
    assert.equal(tag('Android Developer (Kotlin)').role, 'mobile');
    assert.equal(tag('Full Stack Engineer - MERN').role, 'fullstack');
    assert.equal(tag('Data Engineer').role, 'data');
    assert.equal(tag('Site Reliability Engineer').role, 'devops');
    assert.equal(tag('Engineering Manager').role, 'manager');
    assert.equal(tag('Software Engineer', '', 'mobile').role, 'mobile');
});

test('level from the title, mid by default', () => {
    assert.equal(tag('Sr. Software Engineer').level, 'senior');
    assert.equal(tag('Senior Staff Engineer').level, 'staff');
    assert.equal(tag('Principal Engineer').level, 'principal');
    assert.equal(tag('SDE 1').level, 'junior');
    assert.equal(tag('Software Engineer II').level, 'mid');
});

test('tech from the title first, then the description', () => {
    assert.deepEqual(tag('Backend Engineer (Golang)', 'Kafka, k8s and AWS').tags, ['Go', 'Kafka', 'AWS', 'Kubernetes']);
    assert.deepEqual(tag('Frontend Developer', 'React.js and TypeScript').tags, ['TypeScript', 'React']);
    assert.deepEqual(tag('Java Developer', 'JavaScript is a plus').tags, ['Java', 'JavaScript']);
});

test('everyday words in the description are not tech', () => {
    assert.deepEqual(tag('Software Engineer', 'You will go live fast. Next steps: a swift response in spring.').tags, []);
    assert.deepEqual(tag('Go Developer').tags, ['Go']);
});

test('no description is fine', () => {
    assert.deepEqual(tag('QA Engineer', null), { role: 'qa', level: 'mid', tags: [] });
});
