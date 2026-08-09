/* ============================================
   sync.js — multi-device sync to Google Sheets/Drive

   PUSH: fires ~1.5s after every save (debounced),
         plus a 30s safety-net sweep.
   PULL: every 45s fetches shared master data so all
         phones stay in sync. Also handles remote deletes
         for deviceTokens (Sheet se delete → local se bhi hata).

   BUG FIXES vs previous version:
   1. deviceToken heartbeat now uses _updateLocalOnly →
      never sets synced:false → no spurious "1 pending"
   2. pullLatest uses overwriteFromRemote (synced:true) →
      pulled records never become dirty
   3. deviceTokens pull now deletes local IDs that are
      gone from Sheet → Settings mein stale IDs nahi dikhti
   ============================================ */

const SYNCABLE_STORES = [
  'customers', 'appointments', 'services', 'bills', 'products',
  'purchases', 'stockTransactions', 'expenses', 'staff',
  'attendance', 'pendingMessages', 'deviceTokens',
];

// Stores pulled from Sheet → local (shared master data)
const PULL_STORES = ['customers', 'products', 'services', 'staff', 'pendingMessages', 'deviceTokens'];

// Stores where remote deletes should be mirrored locally
// (only deviceTokens for now — others are append-only logs)
const DELETE_SYNC_STORES = ['deviceTokens'];

const JSON_FIELDS = {
  services: ['consumption'],
  bills: ['items'],
};

const PUSH_INTERVAL_MS  = 30 * 1000;
const PULL_INTERVAL_MS  = 45 * 1000;
const PUSH_DEBOUNCE_MS  = 1500;

let _syncing = false;
let _pulling = false;

async function getSyncConfig() {
  const gasUrl   = GAS_URL;
  const gasToken = GAS_TOKEN;
  const configured = !!(gasUrl && gasToken && !gasUrl.startsWith('PASTE-') && !gasToken.startsWith('PASTE-'));
  return { gasUrl, gasToken, configured };
}

/* ---------- PUSH ---------- */

async function pushStore(storeName, gasUrl, gasToken) {
  const unsynced = await DB.getUnsynced(storeName);
  if (!unsynced.length) return { store: storeName, synced: 0 };

  const res = await fetch(gasUrl, {
    method: 'POST',
    body: JSON.stringify({ token: gasToken, action: 'pushRecords', storeName, records: unsynced }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || `Failed syncing ${storeName}`);

  for (const rec of unsynced) {
    await DB.markSynced(storeName, rec.id);
  }
  return { store: storeName, synced: unsynced.length };
}

async function pushPhotos(gasUrl, gasToken) {
  const unsynced = await DB.getUnsynced('photos');
  let count = 0;
  for (const photo of unsynced) {
    const res = await fetch(gasUrl, {
      method: 'POST',
      body: JSON.stringify({
        token: gasToken, action: 'uploadPhoto',
        dataUrl: photo.localDataUrl, fileName: `${photo.customerId}_${photo.type}_${photo.id}.jpg`,
      }),
    });
    const json = await res.json();
    if (json.ok) { await DB.markPhotoUploaded(photo.id, json.url); count++; }
  }
  return { store: 'photos', synced: count };
}

async function syncNow(onProgress) {
  if (_syncing) return { ok: false, error: 'Sync already in progress' };
  if (!navigator.onLine) return { ok: false, error: 'Offline' };

  const { gasUrl, gasToken, configured } = await getSyncConfig();
  if (!configured) return { ok: false, error: 'Sync not configured' };

  _syncing = true;
  const results = [];
  try {
    for (const store of SYNCABLE_STORES) {
      const r = await pushStore(store, gasUrl, gasToken);
      results.push(r);
      if (onProgress) onProgress(r);
    }
    const photoResult = await pushPhotos(gasUrl, gasToken);
    results.push(photoResult);
    if (onProgress) onProgress(photoResult);

    await DB.setSetting('lastSyncedAt', new Date().toISOString());
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    _syncing = false;
  }
}

let _pushDebounceTimer = null;
function requestSync() {
  if (_pushDebounceTimer) clearTimeout(_pushDebounceTimer);
  _pushDebounceTimer = setTimeout(() => { syncNow(); }, PUSH_DEBOUNCE_MS);
}

/* ---------- PULL ---------- */

function parseJsonFields(storeName, record) {
  const fields = JSON_FIELDS[storeName];
  if (!fields) return record;
  const copy = { ...record };
  fields.forEach((f) => {
    if (typeof copy[f] === 'string' && copy[f].startsWith('[')) {
      try { copy[f] = JSON.parse(copy[f]); } catch { /* leave as-is */ }
    }
  });
  return copy;
}

async function pullLatest() {
  if (_pulling) return;
  const { gasUrl, gasToken, configured } = await getSyncConfig();
  if (!configured || !navigator.onLine) return;

  _pulling = true;
  try {
    const res = await fetch(`${gasUrl}?action=pullAll&token=${encodeURIComponent(gasToken)}`);
    const json = await res.json();
    if (!json.ok) return;

    for (const storeName of PULL_STORES) {
      const remoteRecords = json.data[storeName] || [];
      const remoteIds = new Set(remoteRecords.map(r => r.id || r.deviceId).filter(Boolean));

      // FIX 1: Upsert pulled records using overwriteFromRemote (synced:true always)
      // This means pulled records are NEVER marked dirty → no spurious pending count
      for (const remote of remoteRecords) {
        const recordId = remote.id || remote.deviceId;
        if (!recordId) continue;
        const clean = parseJsonFields(storeName, remote);
        const local = await DB.get(storeName, recordId);

        if (!local) {
          // New record from another device — add it as synced
          await DB.overwriteFromRemote(storeName, recordId, clean);
        } else if (local.synced !== false) {
          // Only overwrite if this device has no unpushed local edits
          const remoteTime = new Date(remote.updatedAt || 0).getTime();
          const localTime  = new Date(local.updatedAt  || 0).getTime();
          if (remoteTime > localTime) {
            await DB.overwriteFromRemote(storeName, recordId, clean);
          }
        }
        // If local.synced === false → local has unpushed edit → skip (don't clobber)
      }

      // FIX 2: Delete-sync — remove local records that were deleted from Sheet
      // Only for DELETE_SYNC_STORES (deviceTokens) to avoid wiping local-only logs
      if (DELETE_SYNC_STORES.includes(storeName)) {
        const localRecords = await DB.getAll(storeName);
        for (const local of localRecords) {
          const localId = local.id || local.deviceId;
          if (!remoteIds.has(localId)) {
            // This ID is gone from Sheet — remove locally too
            await DB.remove(storeName, localId);
          }
        }
      }
    }
  } catch (err) {
    // silent — will retry on next interval
  } finally {
    _pulling = false;
  }
}

/* ---------- Helpers ---------- */

async function getPendingCount() {
  let total = 0;
  for (const store of [...SYNCABLE_STORES, 'photos']) {
    const unsynced = await DB.getUnsynced(store);
    total += unsynced.length;
  }
  return total;
}

async function restoreFromCloud() {
  const { gasUrl, gasToken, configured } = await getSyncConfig();
  if (!configured) return { ok: false, error: 'Sync not set up yet' };
  const res = await fetch(`${gasUrl}?action=pullAll&token=${encodeURIComponent(gasToken)}`);
  const json = await res.json();
  if (!json.ok) return { ok: false, error: json.error };

  for (const [storeName, records] of Object.entries(json.data)) {
    for (const record of records) {
      if (!record.id) continue;
      const clean = parseJsonFields(storeName, record);
      const existing = await DB.get(storeName, record.id);
      if (!existing) {
        await DB.add(storeName, { ...clean, synced: true });
      }
    }
  }
  return { ok: true };
}

window.Sync = { now: syncNow, requestSync, pullLatest, getPendingCount, restoreFromCloud, getSyncConfig };

/* ---------- Background loops ---------- */

let _pushTimer = null;
let _pullTimer = null;

function startBackgroundSync() {
  if (_pushTimer) return;
  _pushTimer = setInterval(() => { syncNow(); }, PUSH_INTERVAL_MS);
  _pullTimer = setInterval(() => { pullLatest(); }, PULL_INTERVAL_MS);
  window.addEventListener('online', () => { syncNow(); pullLatest(); });
  pullLatest(); // pull immediately on page open
}
startBackgroundSync();

// Refresh sync pill with pending count
(async function refreshSyncPillWithPending() {
  const pill = document.getElementById('syncText');
  if (!pill) return;
  const pending = await getPendingCount();
  if (navigator.onLine && pending > 0) {
    pill.textContent = `Online — ${pending} pending`;
  } else if (navigator.onLine) {
    pill.textContent = 'Online — synced';
  }
})();
