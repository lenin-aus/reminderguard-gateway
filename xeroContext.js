'use strict';

// Who we call Xero as, for one client: { clientId, tenantId, accessToken }. Real mode reads the
// stored, encrypted connection (refreshing the token when it is about to expire). With
// XERO_FIXTURES=1 (the local dev stack only) no Xero connection exists or is needed: the data
// layer answers from fixture data and this returns a placeholder context.

// Calls one statement is expected to make (contact, invoices, credit notes, overpayments,
// prepayments). Used to keep count of what queued work still needs from the daily quota.
const CALLS_PER_STATEMENT = 5;

const usingFixtures = () => process.env.XERO_FIXTURES === '1';

async function getXeroContext(clientId) {
  if (usingFixtures()) return { clientId, tenantId: 'fixture-tenant', accessToken: 'fixture' };
  const tokenManager = require('./tokenManager');
  const { accessToken, tenantId } = await tokenManager.getValidToken(clientId);
  return { clientId, tenantId, accessToken };
}

// The tenant id without touching the token, for keeping per-organisation counters.
async function getXeroTenantId(clientId) {
  if (usingFixtures()) return 'fixture-tenant';
  const tokenManager = require('./tokenManager');
  const mapping = await tokenManager.getMapping(clientId);
  return mapping ? mapping.xero_tenant_id : null;
}

module.exports = { getXeroContext, getXeroTenantId, CALLS_PER_STATEMENT, usingFixtures };
