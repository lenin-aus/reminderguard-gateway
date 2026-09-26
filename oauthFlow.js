'use strict';

// Server-side memory of one Xero sign-in or "connect another org" round trip, and the one-time
// ticket that starts a signed-in "connect another org". Both live in Redis for 10 minutes and are
// single use, so nothing sensitive travels in a URL or in the (readable, unsigned) OAuth state.
//
//   flow    written when the round trip starts, read once by the callback:
//             { intent: 'signin' | 'add', accountId, returnApp, oidcNonce }
//           keyed by the round trip's CSRF nonce (the one already checked against the cookie).
//   ticket  "Connect another org" is a full-page navigation, which cannot carry the session token.
//           The signed-in app first asks for a ticket, and the navigation carries only that. It is
//           stored hashed and bound to the account.

const crypto = require('crypto');

const TTL_SECONDS = 10 * 60;
const INTENTS = ['signin', 'add'];

const flowKey = (nonce) => `oauth-flow:${nonce}`;
const ticketKey = (ticket) => `connect-ticket:${crypto.createHash('sha256').update(ticket).digest('hex')}`;

// Starts a round trip: returns the CSRF nonce (for the state and the cookie) and the OIDC nonce
// (sent to Xero, expected back inside the id_token).
async function startFlow(redis, { intent, accountId = null, returnApp }) {
  if (!INTENTS.includes(intent)) throw new TypeError(`Unknown intent: ${intent}`);
  if (intent === 'add' && !Number.isInteger(accountId)) throw new TypeError('"Connect another org" needs the account');
  const nonce = crypto.randomBytes(16).toString('hex');
  const oidcNonce = crypto.randomBytes(24).toString('base64url');
  await redis.set(flowKey(nonce), JSON.stringify({ intent, accountId, returnApp, oidcNonce }), 'EX', TTL_SECONDS);
  return { nonce, oidcNonce };
}

// The callback's read: the record for this CSRF nonce, once. A second read, an unknown nonce or an
// expired round trip all return null.
async function consumeFlow(redis, nonce) {
  if (typeof nonce !== 'string' || nonce === '') return null;
  const raw = await redis.getdel(flowKey(nonce));
  return raw ? JSON.parse(raw) : null;
}

async function createConnectTicket(redis, accountId) {
  if (!Number.isInteger(accountId)) throw new TypeError('A ticket needs the account');
  const ticket = crypto.randomBytes(32).toString('base64url');
  await redis.set(ticketKey(ticket), String(accountId), 'EX', TTL_SECONDS);
  return ticket;
}

// The account the ticket was issued to, once; null for anything else.
async function redeemConnectTicket(redis, ticket) {
  if (typeof ticket !== 'string' || ticket === '') return null;
  const accountId = await redis.getdel(ticketKey(ticket));
  return accountId ? Number(accountId) : null;
}

module.exports = { startFlow, consumeFlow, createConnectTicket, redeemConnectTicket, TTL_SECONDS, INTENTS };
