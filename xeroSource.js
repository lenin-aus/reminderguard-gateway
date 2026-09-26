'use strict';

// Chooses, per organisation, where Xero data is read from (client_config.xero_read_mode):
//   live    Xero on every request (the original behaviour; every org starts here).
//   shadow  Xero, exactly as live, and the synced copy is also read so differences can be logged.
//   local   the synced copy (xeroSync.js), with no call to Xero.
// A copy that has not finished its first full pull is never read: local and shadow behave as live
// until it has. If the column does not exist yet (the migration is not applied), everything is live.

const pool = require('./db');
const { getXeroData, getXeroClient } = require('./xeroData');
const { createXeroSync, RESOURCES } = require('./xeroSync');
const { createLocalData } = require('./xeroDataLocal');

const MODES = new Set(['live', 'shadow', 'local']);

// ready: every resource has had its first full pull. syncedAt: the oldest last successful run, i.e.
// how old the copy can be at worst.
async function readSyncStatus(db, clientId) {
  try {
    const { rows } = await db.query('SELECT resource, last_full_at, last_run_at FROM xero_sync_state WHERE client_id = $1', [clientId]);
    const ready = RESOURCES.every((r) => rows.some((x) => x.resource === r && x.last_full_at));
    const runs = rows.map((r) => r.last_run_at).filter(Boolean).map((d) => new Date(d).getTime());
    return { ready, syncedAt: ready && runs.length ? new Date(Math.min(...runs)) : null };
  } catch {
    return { ready: false, syncedAt: null };
  }
}

async function readMode(db, clientId) {
  try {
    const { rows } = await db.query('SELECT xero_read_mode FROM client_config WHERE id = $1', [clientId]);
    return rows[0] && MODES.has(rows[0].xero_read_mode) ? rows[0].xero_read_mode : 'live';
  } catch {
    return 'live';
  }
}

function createXeroSource({ db, live, client }) {
  const local = createLocalData({ db, live });
  const sync = createXeroSync({ db, client });

  // -> { mode, effective: 'live' | 'local', data, localData, syncedAt }
  //    data is what to read from; localData is set in shadow mode, for comparison only.
  async function forClient(clientId) {
    const mode = await readMode(db, clientId);
    if (mode === 'live') return { mode, effective: 'live', data: live, localData: null, syncedAt: null };
    const status = await readSyncStatus(db, clientId);
    if (!status.ready) return { mode, effective: 'live', data: live, localData: null, syncedAt: null };
    if (mode === 'local') return { mode, effective: 'local', data: local, localData: null, syncedAt: status.syncedAt };
    return { mode, effective: 'live', data: live, localData: local, syncedAt: status.syncedAt };
  }

  return { forClient, sync, local, live };
}

let source = null;
function getXeroSource() {
  if (!source) source = createXeroSource({ db: pool, live: getXeroData(), client: getXeroClient() });
  return source;
}

module.exports = { createXeroSource, getXeroSource, readSyncStatus, readMode };
