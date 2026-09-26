'use strict';

// Needs PG_TEST_URL (dev-stack Postgres with migration 004). Rolled back after each test.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createXeroSource, readSyncStatus } = require('./xeroSource');
const { RESOURCES } = require('./xeroSync');

const url = process.env.PG_TEST_URL;
const skip = !url && 'set PG_TEST_URL to run';
const CLIENT = 7;

let pool;
test.before(() => {
  if (!url) return;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: url });
});
test.after(async () => {
  if (pool) await pool.end();
});

async function inTx(fn) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('DELETE FROM xero_sync_state WHERE client_id = $1', [CLIENT]);
    const live = { assertBudget() {}, dayRemaining() {}, addPending() {}, takePending() {}, getPending() {} };
    await fn(db, createXeroSource({ db, live, client: { request() {}, getAllPages() {} } }), live);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}
const setMode = (db, mode) => db.query('UPDATE client_config SET xero_read_mode = $2 WHERE id = $1', [CLIENT, mode]);
const markSynced = async (db, resources, at) => {
  for (const r of resources) await db.query('INSERT INTO xero_sync_state (client_id, resource, last_run_at, last_full_at) VALUES ($1, $2, $3, $3)', [CLIENT, r, at]);
};

test('every org starts on live, and live never reads the copy', { skip }, () =>
  inTx(async (db, source, live) => {
    await setMode(db, 'live'); // the dev seed puts client 7 on local; a real org starts here (the column default)
    const s = await source.forClient(CLIENT);
    assert.deepEqual([s.mode, s.effective, s.data === live, s.localData], ['live', 'live', true, null]);
    await markSynced(db, RESOURCES, new Date());
    assert.equal((await source.forClient(CLIENT)).effective, 'live');
  }));

test('local and shadow behave as live until the copy has had its first full pull', { skip }, () =>
  inTx(async (db, source, live) => {
    for (const mode of ['local', 'shadow']) {
      await setMode(db, mode);
      const none = await source.forClient(CLIENT);
      assert.deepEqual([none.mode, none.effective, none.data === live, none.localData, none.syncedAt], [mode, 'live', true, null, null]);
      await markSynced(db, RESOURCES.slice(0, 3), new Date());
      assert.equal((await source.forClient(CLIENT)).effective, 'live', 'three of five resources is not a complete copy');
      await db.query('DELETE FROM xero_sync_state WHERE client_id = $1', [CLIENT]);
    }
  }));

test('a complete copy is read in local mode, and only compared in shadow mode', { skip }, () =>
  inTx(async (db, source, live) => {
    const older = new Date('2026-09-26T01:00:00Z');
    await markSynced(db, RESOURCES, new Date('2026-09-26T03:00:00Z'));
    await db.query(`UPDATE xero_sync_state SET last_run_at = $2 WHERE client_id = $1 AND resource = 'contacts'`, [CLIENT, older]);

    await setMode(db, 'local');
    const local = await source.forClient(CLIENT);
    assert.deepEqual([local.effective, local.data !== live, local.localData], ['local', true, null]);
    assert.equal(local.syncedAt.getTime(), older.getTime(), 'the copy is as old as its oldest resource');

    await setMode(db, 'shadow');
    const shadow = await source.forClient(CLIENT);
    assert.deepEqual([shadow.effective, shadow.data === live, shadow.localData !== null], ['live', true, true]);
  }));

test('the sync status says whether the copy is complete and how old it can be', { skip }, () =>
  inTx(async (db) => {
    assert.deepEqual(await readSyncStatus(db, CLIENT), { ready: false, syncedAt: null });
    await markSynced(db, RESOURCES, new Date('2026-09-26T03:00:00Z'));
    const status = await readSyncStatus(db, CLIENT);
    assert.equal(status.ready, true);
    assert.equal(status.syncedAt.toISOString(), '2026-09-26T03:00:00.000Z');
  }));
