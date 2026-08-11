const Redis = require('ioredis');
const fetch = require('node-fetch');
const pool = require('./db');
const tokenManager = require('./tokenManager');

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD
});

// Melbourne-local YYYY-MM-DD. Single source of truth — never independently
// recomputed by server.js, recipientSelector.js, or the worker. en-CA (not
// en-AU) because en-AU formats as DD/MM/YYYY, which breaks Redis/BullMQ
// job-ID key namespacing if slashes end up inside a jobId string.
function getTenantTodayDateString(timeZone = 'Australia/Melbourne') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

// In-flight promise cache. Wraps the ENTIRE function body — including the
// initial DB read — not just the Xero call, so concurrent cold-start callers
// within this one process share a single in-progress attempt instead of each
// hitting Postgres separately. Always finally-cleared so the map only ever
// holds genuinely in-progress promises, never a stale resolved value.
const inFlightBaseCurrencyPromises = new Map();

async function getOrFetchBaseCurrency(clientId) {
  if (inFlightBaseCurrencyPromises.has(clientId)) {
    return inFlightBaseCurrencyPromises.get(clientId);
  }

  const promise = (async () => {
    const { rows } = await pool.query(
      'SELECT base_currency FROM client_config WHERE id = $1',
      [clientId]
    );
    const existing = rows[0]?.base_currency;
    if (existing) return existing;

    // Cross-process race guard. server.js, autoStatementsWorker.js, and
    // scheduledCheckWorker.js each run as separate Coolify processes — the
    // in-flight map above only protects a single process, so this short
    // Redis lock protects the actual Xero /Organisation call across all of them.
    const lockKey = `base-currency-lock:${clientId}`;
    const lockAcquired = await redis.set(lockKey, '1', 'NX', 'EX', 10);

    if (!lockAcquired) {
      // Another process is already fetching. Poll the DB for up to 5s
      // rather than racing a second /Organisation call.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        const { rows: pollRows } = await pool.query(
          'SELECT base_currency FROM client_config WHERE id = $1',
          [clientId]
        );
        if (pollRows[0]?.base_currency) return pollRows[0].base_currency;
      }
      const err = new Error(`Timed out waiting for base_currency on client ${clientId}`);
      err.code = 'BASE_CURRENCY_TIMEOUT';
      throw err;
    }

    try {
      const { accessToken, tenantId } = await tokenManager.getValidToken(clientId);
      const res = await fetch('https://api.xero.com/api.xro/2.0/Organisation', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Xero-tenant-id': tenantId,
          Accept: 'application/json'
        }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`Xero /Organisation failed: ${res.status}`);

      const fetched = (data.Organisations?.[0]?.BaseCurrency || 'AUD').toUpperCase();

      await pool.query('UPDATE client_config SET base_currency = $1 WHERE id = $2', [
        fetched,
        clientId
      ]);
      return fetched;
    } catch (e) {
      // Xero failure: log, fall back to AUD in-memory for THIS call only.
      // base_currency stays NULL in the DB so the next call retries the
      // real fetch instead of persisting a wrong guess.
      console.warn(`[getOrFetchBaseCurrency] Xero fetch failed for client ${clientId}, falling back to AUD in-memory:`, e.message);
      return 'AUD';
    } finally {
      await redis.del(lockKey).catch(() => {});
    }
  })();

  inFlightBaseCurrencyPromises.set(clientId, promise);
  try {
    return await promise;
  } finally {
    inFlightBaseCurrencyPromises.delete(clientId);
  }
}

module.exports = { getTenantTodayDateString, getOrFetchBaseCurrency };
