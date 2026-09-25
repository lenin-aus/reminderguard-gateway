'use strict';

// Per-tenant call limiter for the Xero API, shared by every process that talks to
// Xero (the API server and both workers) because the limits are per organisation:
//   - a sliding-window rate limit, kept below Xero's 60 calls a minute;
//   - a concurrency cap (Xero allows 5 calls in flight per organisation);
//   - the daily quota remaining, as last reported by Xero's X-DayLimit-Remaining
//     header, so callers can stop before the limit is hit instead of after.
//
// acquire(tenantId) resolves with a lease once a slot is free; call lease.release()
// when the request has finished. Two stores: Redis (production, shared across
// processes) and in-memory (tests, and single-process fixture mode).

const DEFAULTS = {
  rate: Number(process.env.XERO_RATE_PER_MINUTE) || 55,
  windowMs: 60 * 1000,
  concurrency: 5,
  // A lease that is never released (a crashed process) frees itself after this long.
  leaseMs: 90 * 1000,
  pollMs: 150,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createMemoryLimiter(options = {}) {
  const { rate, windowMs, concurrency, pollMs } = { ...DEFAULTS, ...options };
  const now = options.now || Date.now;
  const sleep = options.sleep || defaultSleep;
  const tenants = new Map();

  function state(tenantId) {
    if (!tenants.has(tenantId)) tenants.set(tenantId, { calls: [], leases: 0, day: null });
    return tenants.get(tenantId);
  }

  return {
    async acquire(tenantId) {
      const s = state(tenantId);
      for (;;) {
        const t = now();
        while (s.calls.length > 0 && s.calls[0] <= t - windowMs) s.calls.shift();
        if (s.calls.length >= rate) {
          await sleep(s.calls[0] + windowMs - t + 1);
        } else if (s.leases >= concurrency) {
          await sleep(pollMs);
        } else {
          s.calls.push(t);
          s.leases += 1;
          let released = false;
          return {
            release() {
              if (!released) {
                released = true;
                s.leases -= 1;
              }
            },
          };
        }
      }
    },
    async setDayRemaining(tenantId, remaining) {
      state(tenantId).day = remaining;
    },
    async getDayRemaining(tenantId) {
      return state(tenantId).day;
    },
    // Calls that queued work is still expected to make against this tenant's daily quota.
    async addPending(tenantId, calls) {
      state(tenantId).pending = (state(tenantId).pending || 0) + calls;
    },
    async takePending(tenantId, calls) {
      state(tenantId).pending = Math.max(0, (state(tenantId).pending || 0) - calls);
    },
    async getPending(tenantId) {
      return state(tenantId).pending || 0;
    },
  };
}

// Atomic in Redis. Time comes from Redis (TIME), not the caller, so processes with
// skewed clocks still share one window. Returns 0 when a slot was taken, otherwise
// how many milliseconds to wait before asking again.
const ACQUIRE_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local windowMs = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local conc = tonumber(ARGV[3])
local leaseMs = tonumber(ARGV[4])
local pollMs = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= rate then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return tonumber(oldest[2]) + windowMs - now + 1
end
if redis.call('ZCARD', KEYS[2]) >= conc then
  return pollMs
end
redis.call('ZADD', KEYS[1], now, ARGV[6])
redis.call('ZADD', KEYS[2], now + leaseMs, ARGV[6])
redis.call('PEXPIRE', KEYS[1], windowMs * 2)
redis.call('PEXPIRE', KEYS[2], leaseMs * 2)
return 0
`;

function createRedisLimiter(redis, options = {}) {
  const { rate, windowMs, concurrency, leaseMs, pollMs } = { ...DEFAULTS, ...options };
  const sleep = options.sleep || defaultSleep;
  let counter = 0;

  return {
    async acquire(tenantId) {
      const member = `${process.pid}:${Date.now()}:${counter++}:${Math.random().toString(36).slice(2, 8)}`;
      const rateKey = `xero:rl:${tenantId}`;
      const leaseKey = `xero:conc:${tenantId}`;
      for (;;) {
        const wait = Number(
          await redis.eval(ACQUIRE_LUA, 2, rateKey, leaseKey, windowMs, rate, concurrency, leaseMs, pollMs, member)
        );
        if (wait === 0) {
          let released = false;
          return {
            async release() {
              if (!released) {
                released = true;
                await redis.zrem(leaseKey, member);
              }
            },
          };
        }
        await sleep(wait);
      }
    },
    async setDayRemaining(tenantId, remaining) {
      await redis.set(`xero:day:${tenantId}`, String(remaining), 'PX', DAY_MS);
    },
    async getDayRemaining(tenantId) {
      const value = await redis.get(`xero:day:${tenantId}`);
      return value === null ? null : Number(value);
    },
    // The pending counter expires on its own so jobs that died cannot hold budget forever.
    async addPending(tenantId, calls) {
      const key = `xero:pending:${tenantId}`;
      await redis.incrby(key, calls);
      await redis.pexpire(key, PENDING_TTL_MS);
    },
    async takePending(tenantId, calls) {
      const key = `xero:pending:${tenantId}`;
      const left = await redis.decrby(key, calls);
      if (left < 0) await redis.set(key, '0', 'PX', PENDING_TTL_MS);
    },
    async getPending(tenantId) {
      return Number(await redis.get(`xero:pending:${tenantId}`)) || 0;
    },
  };
}

module.exports = { createMemoryLimiter, createRedisLimiter, DEFAULTS };
