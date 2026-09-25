'use strict';

// The only place that performs HTTP requests against the Xero accounting API for
// statements. Read-only by design (GET). Adds what a bare fetch does not give:
//   - the shared per-tenant limiter (rate, concurrency, daily quota);
//   - 429 handling that honours Retry-After, and retries on 5xx and network errors;
//   - a paging helper, because Xero returns at most 100 items per page and silently
//     truncates an unpaged list.
// Errors are XeroError with a stable `code`; a caller (a BullMQ job) can decide from
// `retryable` whether to give up or let the queue retry.

const XERO_API = 'https://api.xero.com/api.xro/2.0';

class XeroError extends Error {
  constructor(message, { code, status = null, retryable = false, body = null } = {}) {
    super(message);
    this.name = 'XeroError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildUrl(path, query = {}) {
  const parts = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  return `${XERO_API}/${path}${parts.length ? `?${parts.join('&')}` : ''}`;
}

function createXeroClient({
  limiter,
  fetchImpl = (...args) => globalThis.fetch(...args),
  sleep = defaultSleep,
  random = Math.random,
  maxAttempts = 5,
  // Stop calling once Xero reports this few calls left today, so the last of the day's
  // quota is not burnt by a retry loop.
  dayReserve = 25,
  maxRetryWaitMs = 65 * 1000,
  log = console,
} = {}) {
  if (!limiter) throw new Error('createXeroClient needs a limiter');

  // ctx = { clientId, tenantId, accessToken }; the token is fetched once per job.
  async function request(ctx, path, { query, headers = {} } = {}) {
    const url = buildUrl(path, query);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = await limiter.getDayRemaining(ctx.tenantId);
      if (remaining !== null && remaining <= dayReserve) {
        throw new XeroError(`Xero daily call limit nearly reached (${remaining} left)`, {
          code: 'XERO_DAILY_LIMIT',
        });
      }

      const lease = await limiter.acquire(ctx.tenantId);
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${ctx.accessToken}`,
            'Xero-tenant-id': ctx.tenantId,
            Accept: 'application/json',
            ...headers,
          },
        });
      } catch (err) {
        lastError = new XeroError(`Xero request failed: ${err.message}`, { code: 'XERO_NETWORK', retryable: true });
        await lease.release();
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000) + random() * 250);
        continue;
      }
      await lease.release();

      const dayHeader = res.headers.get('x-daylimit-remaining');
      if (dayHeader !== null && dayHeader !== '') await limiter.setDayRemaining(ctx.tenantId, Number(dayHeader));

      if (res.status === 429) {
        const problem = (res.headers.get('x-rate-limit-problem') || '').toLowerCase();
        if (problem === 'day') {
          throw new XeroError('Xero daily call limit reached', { code: 'XERO_DAILY_LIMIT', status: 429 });
        }
        const retryAfterMs = (Number(res.headers.get('retry-after')) || 5) * 1000;
        lastError = new XeroError('Xero rate limit reached', { code: 'XERO_RATE_LIMITED', status: 429, retryable: true });
        log.warn?.(`[xero] 429 (${problem || 'unknown'}) for tenant ${ctx.tenantId}; waiting ${retryAfterMs}ms`);
        await sleep(Math.min(retryAfterMs, maxRetryWaitMs) + random() * 500);
        continue;
      }

      if (res.status >= 500) {
        lastError = new XeroError(`Xero server error ${res.status}`, { code: 'XERO_SERVER_ERROR', status: res.status, retryable: true });
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000) + random() * 250);
        continue;
      }

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // handled below for the ok case
      }

      if (res.status === 401) throw new XeroError('Xero rejected the access token', { code: 'XERO_UNAUTHORIZED', status: 401, body: json });
      if (res.status === 403) throw new XeroError('Xero denied access (missing scope?)', { code: 'XERO_FORBIDDEN', status: 403, body: json });
      if (res.status === 404) throw new XeroError('Xero resource not found', { code: 'XERO_NOT_FOUND', status: 404, body: json });
      if (!res.ok) throw new XeroError(`Xero request failed with ${res.status}`, { code: 'XERO_REQUEST_FAILED', status: res.status, body: json });
      if (json === null) throw new XeroError('Xero returned a body that is not JSON', { code: 'XERO_BAD_RESPONSE', status: res.status });

      return json;
    }

    throw lastError || new XeroError('Xero request failed', { code: 'XERO_REQUEST_FAILED', retryable: true });
  }

  // Fetches every page of a list endpoint. listKey is the property that holds the items
  // ('Invoices', 'CreditNotes', ...). A page shorter than pageSize is the last one.
  async function getAllPages(ctx, path, { query = {}, listKey, pageSize = 100, maxPages = 200, headers } = {}) {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
      const data = await request(ctx, path, {
        query: { ...query, page, ...(pageSize !== 100 ? { pageSize } : {}) },
        headers,
      });
      const batch = data[listKey] || [];
      items.push(...batch);
      if (batch.length < pageSize) return items;
    }
    throw new XeroError(`Xero list ${path} exceeded ${maxPages} pages`, { code: 'XERO_TOO_MANY_PAGES' });
  }

  return { request, getAllPages };
}

module.exports = { createXeroClient, XeroError, buildUrl, XERO_API };
