'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  replyToAddress,
  parseReplyToken,
  parseBucketKey,
  classifyLocally,
  classifyReply,
  draftForPromise,
  resumeAfterFor,
} = require('./inboundReply');

test('replyToAddress and parseReplyToken round-trip, including UUID-shaped bucket keys', () => {
  const address = replyToAddress(8, '0a4cf37b-a1a8-4753-9ee2-f9207f63a8ff_AUD');
  assert.equal(address, 'chase+8+0a4cf37b-a1a8-4753-9ee2-f9207f63a8ff_AUD@inbound.fasttrackledger.com');
  assert.deepEqual(parseReplyToken(address), { clientId: 8, bucketKey: '0a4cf37b-a1a8-4753-9ee2-f9207f63a8ff_AUD' });
});

test('parseReplyToken handles a display name before the address, and rejects anything else', () => {
  assert.deepEqual(parseReplyToken('"Acme Pty Ltd" <chase+7+abc_AUD@inbound.fasttrackledger.com>'), {
    clientId: 7,
    bucketKey: 'abc_AUD',
  });
  assert.equal(parseReplyToken('bookkeeper@example.com'), null);
  assert.equal(parseReplyToken(''), null);
  assert.equal(parseReplyToken(undefined), null);
});

test('classifyLocally matches a clean, single-date promise', () => {
  const ref = new Date('2026-10-01T00:00:00Z');
  const result = classifyLocally('Hi, we will pay on Friday 16 October.', ref);
  assert.equal(result.source, 'regex');
  assert.equal(result.intent, 'PROMISE_TO_PAY');
  assert.equal(result.targetDate, '2026-10-16');
  assert.ok(result.confidence >= 0.9);
  assert.match(result.draftReply, /Friday 16 October 2026/);
});

test('classifyLocally refuses dispute language even with a promise-shaped date nearby', () => {
  const ref = new Date('2026-10-01T00:00:00Z');
  assert.equal(classifyLocally('We will not pay until you fix invoice #1002, due 16 Oct.', ref), null);
  assert.equal(classifyLocally('This amount is incorrect, we already paid on 1 Oct.', ref), null);
});

test('classifyLocally refuses when there is no date, or more than one', () => {
  const ref = new Date('2026-10-01T00:00:00Z');
  assert.equal(classifyLocally('We will pay this soon, thanks.', ref), null);
  assert.equal(classifyLocally('We will pay by 16 Oct, or failing that by 23 Oct.', ref), null);
});

test('classifyLocally refuses empty or missing text', () => {
  assert.equal(classifyLocally(''), null);
  assert.equal(classifyLocally(null), null);
  assert.equal(classifyLocally(undefined), null);
});

test('classifyReply falls back to a safe OTHER result when the LLM is not configured', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await classifyReply('We are disputing this invoice entirely.');
    assert.deepEqual(result, { source: 'llm', intent: 'OTHER', confidence: 0, targetDate: null, draftReply: '' });
  } finally {
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('LLM_PROVIDER=ollama routes to Ollama, and an unreachable one falls back the same safe way', async () => {
  const savedProvider = process.env.LLM_PROVIDER;
  const savedUrl = process.env.OLLAMA_BASE_URL;
  process.env.LLM_PROVIDER = 'ollama';
  process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:19191'; // nothing listens here
  try {
    const result = await classifyReply('We are disputing this invoice entirely.');
    assert.deepEqual(result, { source: 'llm', intent: 'OTHER', confidence: 0, targetDate: null, draftReply: '' });
  } finally {
    if (savedProvider) process.env.LLM_PROVIDER = savedProvider;
    else delete process.env.LLM_PROVIDER;
    if (savedUrl) process.env.OLLAMA_BASE_URL = savedUrl;
    else delete process.env.OLLAMA_BASE_URL;
  }
});

test('classifyReply prefers the local regex match and never calls the LLM for a clean case', async () => {
  const ref = new Date('2026-10-01T00:00:00Z');
  const result = await classifyReply('We will pay by 16 Oct.', { referenceDate: ref });
  assert.equal(result.source, 'regex');
  assert.equal(result.targetDate, '2026-10-16');
});

test('parseBucketKey splits on the last underscore, a GUID contactId is safe', () => {
  assert.deepEqual(parseBucketKey('0a4cf37b-a1a8-4753-9ee2-f9207f63a8ff_AUD'), {
    contactId: '0a4cf37b-a1a8-4753-9ee2-f9207f63a8ff',
    currencyCode: 'AUD',
  });
  assert.equal(parseBucketKey('no-underscore'), null);
  assert.equal(parseBucketKey(''), null);
});

test('resumeAfterFor adds the 2-day grace buffer, and is null with no target date', () => {
  assert.equal(resumeAfterFor('2026-10-16').toISOString().slice(0, 10), '2026-10-18');
  assert.equal(resumeAfterFor(null), null);
});

test('draftForPromise reads naturally and names the date', () => {
  assert.match(draftForPromise('2026-10-16'), /Friday 16 October 2026/);
});
