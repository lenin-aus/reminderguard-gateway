'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createXeroClient, XeroError, buildUrl } = require('./xeroClient');
const { createMemoryLimiter } = require('./xeroLimiter');

const ctx = { clientId: 8, tenantId: 'T1', accessToken: 'tok' };

function response(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// A client whose fetch replays the given responses in order, recording each request.
function setup(responses, options = {}) {
  const requests = [];
  const sleeps = [];
  const queue = [...responses];
  const limiter = options.limiter || createMemoryLimiter({ rate: 1000, concurrency: 5 });
  const client = createXeroClient({
    limiter,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0,
    log: { warn() {} },
    ...options.client,
  });
  return { client, requests, sleeps, limiter };
}

test('sends a GET with the bearer token and tenant, and encodes filters', async () => {
  const { client, requests } = setup([response(200, { Invoices: [] })]);
  await client.request(ctx, 'Invoices', {
    query: { where: 'Contact.ContactID==Guid("abc")', page: 1 },
    headers: { 'If-Modified-Since': '2026-05-26T14:00:00' },
  });

  const { url, init } = requests[0];
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  assert.equal(init.headers['Xero-tenant-id'], 'T1');
  assert.equal(init.headers['If-Modified-Since'], '2026-05-26T14:00:00');
  assert.equal(url, 'https://api.xero.com/api.xro/2.0/Invoices?where=Contact.ContactID%3D%3DGuid(%22abc%22)&page=1');
});

test('buildUrl skips undefined values', () => {
  assert.equal(buildUrl('Invoices', { a: 1, b: undefined, c: null }), 'https://api.xero.com/api.xro/2.0/Invoices?a=1');
  assert.equal(buildUrl('Organisation'), 'https://api.xero.com/api.xro/2.0/Organisation');
});

test('a 429 waits for Retry-After and then succeeds', async () => {
  const { client, requests, sleeps } = setup([
    response(429, {}, { 'Retry-After': 2, 'X-Rate-Limit-Problem': 'minute' }),
    response(200, { ok: true }),
  ]);
  const data = await client.request(ctx, 'Organisation');
  assert.deepEqual(data, { ok: true });
  assert.equal(requests.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('a 429 for the daily limit fails at once without retrying', async () => {
  const { client, requests } = setup([response(429, {}, { 'Retry-After': 30000, 'X-Rate-Limit-Problem': 'day' })]);
  await assert.rejects(client.request(ctx, 'Organisation'), (err) => err instanceof XeroError && err.code === 'XERO_DAILY_LIMIT' && !err.retryable);
  assert.equal(requests.length, 1);
});

test('a 429 that never clears gives up after the attempt limit as retryable', async () => {
  const many = Array.from({ length: 3 }, () => response(429, {}, { 'Retry-After': 1, 'X-Rate-Limit-Problem': 'minute' }));
  const { client, requests } = setup(many, { client: { maxAttempts: 3 } });
  await assert.rejects(client.request(ctx, 'Organisation'), (err) => err.code === 'XERO_RATE_LIMITED' && err.retryable === true);
  assert.equal(requests.length, 3);
});

test('a long Retry-After is capped', async () => {
  const { client, sleeps } = setup([response(429, {}, { 'Retry-After': 600, 'X-Rate-Limit-Problem': 'minute' }), response(200, {})], {
    client: { maxRetryWaitMs: 10000 },
  });
  await client.request(ctx, 'Organisation');
  assert.deepEqual(sleeps, [10000]);
});

test('stops before the daily quota runs out', async () => {
  const { client, requests, limiter } = setup([response(200, {})]);
  await limiter.setDayRemaining('T1', 20); // reserve is 25
  await assert.rejects(client.request(ctx, 'Organisation'), (err) => err.code === 'XERO_DAILY_LIMIT');
  assert.equal(requests.length, 0);
});

test('records the daily quota Xero reports and blocks once it is nearly used up', async () => {
  const { client, limiter } = setup([response(200, {}, { 'X-DayLimit-Remaining': 986 }), response(200, {}, { 'X-DayLimit-Remaining': 10 }), response(200, {})]);
  await client.request(ctx, 'Organisation');
  assert.equal(await limiter.getDayRemaining('T1'), 986);
  await client.request(ctx, 'Organisation');
  assert.equal(await limiter.getDayRemaining('T1'), 10);
  await assert.rejects(client.request(ctx, 'Organisation'), (err) => err.code === 'XERO_DAILY_LIMIT');
});

test('retries server errors with backoff, then succeeds', async () => {
  const { client, requests, sleeps } = setup([response(503, 'unavailable'), response(502, 'bad gateway'), response(200, { ok: 1 })]);
  assert.deepEqual(await client.request(ctx, 'Organisation'), { ok: 1 });
  assert.equal(requests.length, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('a persistent server error is reported as retryable', async () => {
  const { client } = setup([response(500, ''), response(500, ''), response(500, '')], { client: { maxAttempts: 3 } });
  await assert.rejects(client.request(ctx, 'Organisation'), (err) => err.code === 'XERO_SERVER_ERROR' && err.retryable);
});

test('retries a network failure', async () => {
  const { client, requests } = setup([new Error('socket hang up'), response(200, { ok: 1 })]);
  assert.deepEqual(await client.request(ctx, 'Organisation'), { ok: 1 });
  assert.equal(requests.length, 2);
});

test('maps 401, 403 and 404 to distinct non-retryable errors', async () => {
  for (const [status, code] of [[401, 'XERO_UNAUTHORIZED'], [403, 'XERO_FORBIDDEN'], [404, 'XERO_NOT_FOUND']]) {
    const { client, requests } = setup([response(status, { Title: 'x' })]);
    await assert.rejects(client.request(ctx, 'Organisation'), (err) => err.code === code && !err.retryable);
    assert.equal(requests.length, 1);
  }
});

test('rejects a 200 that is not JSON', async () => {
  const { client } = setup([response(200, '<html>')]);
  await assert.rejects(client.request(ctx, 'Organisation'), (err) => err.code === 'XERO_BAD_RESPONSE');
});

test('releases the concurrency lease after success and after failure', async () => {
  const limiter = createMemoryLimiter({ rate: 1000, concurrency: 1, pollMs: 1 });
  const { client } = setup([response(200, {}), response(404, {}), response(200, {})], { limiter });
  await client.request(ctx, 'A');
  await assert.rejects(client.request(ctx, 'B'));
  await client.request(ctx, 'C'); // would hang if a lease leaked
});

test('getAllPages follows pages until a short one, and merges them', async () => {
  const page = (n, count) => response(200, { Invoices: Array.from({ length: count }, (_, i) => ({ InvoiceID: `${n}-${i}` })) });
  const { client, requests } = setup([page(1, 100), page(2, 100), page(3, 37)]);
  const items = await client.getAllPages(ctx, 'Invoices', { query: { Statuses: 'AUTHORISED' }, listKey: 'Invoices' });

  assert.equal(items.length, 237);
  assert.deepEqual(requests.map((r) => new URL(r.url).searchParams.get('page')), ['1', '2', '3']);
  assert.ok(!requests[0].url.includes('pageSize'), 'the default page size is not sent');
});

test('getAllPages asks for another page when a page is exactly full', async () => {
  const full = response(200, { Invoices: Array.from({ length: 100 }, () => ({})) });
  const empty = response(200, { Invoices: [] });
  const { client, requests } = setup([full, empty]);
  const items = await client.getAllPages(ctx, 'Invoices', { listKey: 'Invoices' });
  assert.equal(items.length, 100);
  assert.equal(requests.length, 2);
});

test('getAllPages passes a custom page size and the extra headers on every page', async () => {
  const { client, requests } = setup([response(200, { Invoices: [{}, {}] })]);
  await client.getAllPages(ctx, 'Invoices', { listKey: 'Invoices', pageSize: 200, headers: { 'If-Modified-Since': 'x' } });
  assert.ok(requests[0].url.includes('pageSize=200'));
  assert.equal(requests[0].init.headers['If-Modified-Since'], 'x');
});

test('getAllPages refuses to page forever', async () => {
  const full = () => response(200, { Invoices: Array.from({ length: 100 }, () => ({})) });
  const { client } = setup([full(), full(), full()]);
  await assert.rejects(client.getAllPages(ctx, 'Invoices', { listKey: 'Invoices', maxPages: 3 }), (err) => err.code === 'XERO_TOO_MANY_PAGES');
});

test('getAllPages warns when a list needs more pages than warnPages, and not otherwise', async () => {
  const warnings = [];
  const page = (count) => response(200, { Invoices: Array.from({ length: count }, () => ({})) });
  const many = setup([page(100), page(100), page(100), page(5)], { client: { log: { warn: (m) => warnings.push(m) } } });
  await many.client.getAllPages(ctx, 'Invoices', { listKey: 'Invoices', warnPages: 3, label: 'history of contact X' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /large list: history of contact X for tenant T1 needed 4 pages \(305 records\)/);

  const few = setup([page(100), page(5)], { client: { log: { warn: (m) => warnings.push(m) } } });
  await few.client.getAllPages(ctx, 'Invoices', { listKey: 'Invoices', warnPages: 3 });
  assert.equal(warnings.length, 1, 'two pages is under the threshold');
});

test('assertBudget fails with a clear reason when queued statements need more calls than are left today', async () => {
  const { client, limiter } = setup([]);
  await client.assertBudget(ctx); // quota unknown: passes

  await limiter.setDayRemaining('T1', 300);
  await limiter.addPending('T1', 250);
  await client.assertBudget(ctx); // 300 - 25 reserve = 275 >= 250

  await limiter.addPending('T1', 30);
  await assert.rejects(client.assertBudget(ctx), (err) => err.code === 'XERO_DAILY_LIMIT' && /280 calls are still needed .* only 300 are left/.test(err.message));

  await limiter.takePending('T1', 100); // some queued statements finished
  await client.assertBudget(ctx);
});
