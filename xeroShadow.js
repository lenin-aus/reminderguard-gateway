'use strict';

// Shadow mode: the customer list is answered from Xero as usual, and the same list built from the
// synced copy is compared with it. Any difference is logged, so the copy can be trusted (or not)
// before an organisation is switched to 'local'. Pure.

const FIELDS = ['contactName', 'currencyCode', 'hasEmail', 'theyOwe', 'overdueAmount', 'daysOverdue'];

function diffCustomers(liveList, localList) {
  const live = new Map(liveList.map((c) => [c.bucketKey, c]));
  const local = new Map(localList.map((c) => [c.bucketKey, c]));
  const onlyLive = [...live.keys()].filter((k) => !local.has(k)).sort();
  const onlyLocal = [...local.keys()].filter((k) => !live.has(k)).sort();
  const changed = [];
  for (const [key, a] of live) {
    const b = local.get(key);
    if (!b) continue;
    const fields = FIELDS.filter((f) => a[f] !== b[f]).map((f) => ({ field: f, live: a[f], local: b[f] }));
    if (fields.length > 0) changed.push({ bucketKey: key, fields });
  }
  changed.sort((x, y) => x.bucketKey.localeCompare(y.bucketKey));
  return { live: live.size, local: local.size, onlyLive, onlyLocal, changed, same: onlyLive.length + onlyLocal.length + changed.length === 0 };
}

// One line per comparison; the first few differences are spelled out.
function formatShadowLog(clientId, diff, syncedAt) {
  const head = `[xero-shadow] client=${clientId} live=${diff.live} local=${diff.local} diffs=${diff.onlyLive.length + diff.onlyLocal.length + diff.changed.length} copy_synced=${syncedAt ? new Date(syncedAt).toISOString() : 'never'}`;
  if (diff.same) return head;
  const detail = [
    ...diff.onlyLive.slice(0, 5).map((k) => `only_live:${k}`),
    ...diff.onlyLocal.slice(0, 5).map((k) => `only_local:${k}`),
    ...diff.changed.slice(0, 5).map((c) => `${c.bucketKey}:${c.fields.map((f) => `${f.field} ${f.live}->${f.local}`).join(',')}`),
  ];
  return `${head} ${detail.join(' | ')}`;
}

module.exports = { diffCustomers, formatShadowLog };
