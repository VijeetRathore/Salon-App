/* ============================================
   sync.js — multi-device sync to Google Sheets/Drive

   REAL-TIME STRATEGY:
   1. visibilityChange  → jab bhi app foreground mein aaye, turant push+pull
   2. sendSyncPing      → push ke baad GAS ko bolte hain, woh FCM se baaki
                          devices ko silent ping bhejta hai → woh pull karte hain
   3. SW message        → SW se PULL_NOW milne pe pull trigger
   4. Pull interval     → 15s (sirf jab tab visible ho), safety net
   5. ggDataUpdated     → pull complete hone pe event — pages turant re-render kar sakti hain

   INCREMENTAL PULL:
   - Pehli baar: full pull (lastPulledAt nahi hai)
   - Baad mein: sirf naye/updated records (pullSince action)
   - pullSince fail ho → fallback to pullAll (older Code.gs compatibility)
   - DELETE_SYNC_STORES ke liye GAS hamesha full data bhejta hai
     (taaki deletions bhi detect ho sakein)

   PUSH:
   - Startup pe + har 30s + save ke 1.5s baad debounced
   ============================================ */

const SYNCABLE_STORES = [
  'customers', 'appointments', 'services', 'bills', 'products',
  'purchases', 'stockTransactions', 'expenses', 'staff',
  'attendance'];

const PULL_STORES = [
  'customers', 'appointments', 'services', 'bills', 'products',
  'purchases', 'stockTransactions', 'expenses', 'staff',
  'attendance'];

// In SABHI stores mein Sheet se delete hone pe local se bhi hatao.
// GAS pullSince mein bhi in stores ka FULL data bhejta hai —
// client remote vs local compare karta hai aur missing records delete karta hai.
// Matlab: Sheet = source of truth. Jo Sheet mein nahi, app mein bhi nahi.
const DELETE_SYNC_STORES = [
  'customers', 'appointments', 'services', 'bills', 'products',
  'purchases', 'stockTransactions', 'expenses', 'staff',
  'attendance'];

// Kuch stores ka keyPath 'id' nahi hota — in par special handling chahiye
const STORE_KEYPATH = {};

const JSON_FIELDS = {
  services: ['consumption'],
  bills: ['items'],
};

const PUSH_INTERVAL_MS = 30 * 1000;
const PULL_INTERVAL_MS = 15 * 1000; // sirf jab tab visible ho
const PUSH_DEBOUNCE_MS = 1500;

let _syncing = false;
let _pulling = false;

async function getSyncConfig() {
  const gasUrl   = GAS_URL;
  const gasToken = GAS_TOKEN;
  const configured = !!(gasUrl && gasToken
    && !gasUrl.startsWith('PASTE-') && !gasToken.startsWith('PASTE-'));
  return { gasUrl, gasToken, configured };
}

/* Store ka actual primary key field kya hai */
function getKeyField(storeName) {
  return STORE_KEYPATH[storeName] || 'id';
}

/* Remote record se primary key value nikalo */
function getRecordKey(storeName, record) {
  const kf = getKeyField(storeName);
  return record[kf] || record.id || record.deviceId;
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
        dataUrl: photo.localDataUrl,
        fileName: `${photo.customerId}_${photo.type}_${photo.id}.jpg`,
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
  let anyPushed = false;

  try {
    for (const store of SYNCABLE_STORES) {
      const r = await pushStore(store, gasUrl, gasToken);
      results.push(r);
      if (r.synced > 0) anyPushed = true;
      if (onProgress) onProgress(r);
    }
    const photoResult = await pushPhotos(gasUrl, gasToken);
    results.push(photoResult);
    if (photoResult.synced > 0) anyPushed = true;
    if (onProgress) onProgress(photoResult);

    await DB.setSetting('lastSyncedAt', new Date().toISOString());

    // Kuch push hua → baaki devices ko silent ping bhejo (fire-and-forget)
    if (anyPushed) sendSyncPing(gasUrl, gasToken);

    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    _syncing = false;
  }
}

/* Push ke baad GAS ko bolta hai: "baaki devices ko pull karo"
   GAS → FCM silent push → SW → PULL_NOW → pull trigger */
function sendSyncPing(gasUrl, gasToken) {
  try {
    fetch(`${gasUrl}?action=sendSyncPing&token=${encodeURIComponent(gasToken)}`);
  } catch (e) { /* silent — fire and forget */ }
}

let _pushDebounceTimer = null;
function requestSync() {
  if (_pushDebounceTimer) clearTimeout(_pushDebounceTimer);
  _pushDebounceTimer = setTimeout(() => { syncNow(); }, PUSH_DEBOUNCE_MS);
}

/* ---------- PULL (Incremental with fallback) ---------- */

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

async function _fetchPullData(gasUrl, gasToken, since) {
  // 1st attempt: incremental (pullSince) agar since available hai
  if (since) {
    try {
      const url = `${gasUrl}?action=pullSince&since=${encodeURIComponent(since)}&token=${encodeURIComponent(gasToken)}`;
      const res  = await fetch(url);
      const json = await res.json();
      if (json.ok) return json;
      // pullSince fail hua (purana Code.gs deployed hai) → fallback
    } catch { /* network error → fallback */ }
  }

  // Fallback: full pull (hamesha kaam karta hai)
  const url = `${gasUrl}?action=pullAll&token=${encodeURIComponent(gasToken)}`;
  const res  = await fetch(url);
  return await res.json();
}

async function pullLatest() {
  if (_pulling) return;
  const { gasUrl, gasToken, configured } = await getSyncConfig();
  if (!configured || !navigator.onLine) return;

  _pulling = true;
  try {
    const lastPulledAt = await DB.getSetting('lastPulledAt');
    // 60s buffer — clock skew handle karne ke liye
    const since = lastPulledAt
      ? new Date(new Date(lastPulledAt).getTime() - 60_000).toISOString()
      : null;

    const json = await _fetchPullData(gasUrl, gasToken, since);
    if (!json || !json.ok) return;

    for (const storeName of PULL_STORES) {
      const remoteRecords = json.data[storeName] || [];

      // Correct key field use karo (deviceTokens → deviceId, baaki → id)
      const remoteIds = new Set(
        remoteRecords.map(r => getRecordKey(storeName, r)).filter(Boolean)
      );

      for (const remote of remoteRecords) {
        const recordId = getRecordKey(storeName, remote);
        if (!recordId) continue;
        const clean = parseJsonFields(storeName, remote);
        const local = await DB.get(storeName, recordId);

        if (!local) {
          await DB.overwriteFromRemote(storeName, recordId, clean);
        } else if (local.synced !== false) {
          // Sirf overwrite karo agar remote newer hai
          const remoteTime = new Date(remote.updatedAt || 0).getTime();
          const localTime  = new Date(local.updatedAt  || 0).getTime();
          if (remoteTime > localTime) {
            await DB.overwriteFromRemote(storeName, recordId, clean);
          }
        }
        // local.synced === false → unsaved local edit → skip (local wins)
      }

      // DELETE_SYNC_STORES: GAS full data bhejta hai (incremental mein bhi)
      // Local mein jo nahi hai remote mein → delete karo
      if (DELETE_SYNC_STORES.includes(storeName)) {
        const localRecords = await DB.getAll(storeName);
        for (const local of localRecords) {
          const localId = getRecordKey(storeName, local);
          if (localId && !remoteIds.has(localId)) {
            await DB.remove(storeName, localId);
          }
        }
      }
    }

    // Next pull ke liye timestamp save karo
    await DB.setSetting('lastPulledAt', json.pulledAt || new Date().toISOString());

    // Sabhi open pages ko batao: "naya data aaya, re-render karo"
    window.dispatchEvent(new CustomEvent('ggDataUpdated'));

  } catch (err) {
    // silent — agli baar retry hoga
  } finally {
    _pulling = false;
  }
}

/* ---------- Pill updater ---------- */

async function updateSyncPillFull() {
  const pill = document.getElementById('syncPill');
  const text = document.getElementById('syncText');
  if (!text) return;

  if (!navigator.onLine) {
    if (pill) pill.classList.add('offline');
    text.textContent = 'Offline — saving locally';
    return;
  }

  if (pill) pill.classList.remove('offline');
  const pending = await getPendingCount();
  text.textContent = pending > 0 ? `Online — ${pending} pending` : 'Online — synced';
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

  const res  = await fetch(`${gasUrl}?action=pullAll&token=${encodeURIComponent(gasToken)}`);
  const json = await res.json();
  if (!json.ok) return { ok: false, error: json.error };

  for (const [storeName, records] of Object.entries(json.data)) {
    for (const record of records) {
      const recordId = getRecordKey(storeName, record);
      if (!recordId) continue;
      const clean = parseJsonFields(storeName, record);
      const existing = await DB.get(storeName, recordId);
      if (!existing) {
        await DB.add(storeName, { ...clean, synced: true });
      }
    }
  }

  await DB.setSetting('lastPulledAt', new Date().toISOString());
  window.dispatchEvent(new CustomEvent('ggDataUpdated'));
  return { ok: true };
}

window.Sync = {
  now: syncNow,
  requestSync,
  pullLatest,
  getPendingCount,
  restoreFromCloud,
  getSyncConfig,
};

/* ---------- Background loops + Real-time triggers ---------- */

let _pushTimer = null;
let _pullTimer = null;

async function startBackgroundSync() {
  if (_pushTimer) return;

  // ── STARTUP SEQUENCE ──────────────────────────────────────
  if (navigator.onLine) {
    const { configured } = await getSyncConfig();
    if (configured) {
      await syncNow();    // push pending
      await pullLatest(); // fresh data fetch
    }
  }
  await updateSyncPillFull();

  // ── PUSH INTERVAL (30s) ───────────────────────────────────
  _pushTimer = setInterval(async () => {
    await syncNow();
    await updateSyncPillFull();
  }, PUSH_INTERVAL_MS);

  // ── PULL INTERVAL (15s, sirf visible tab) ─────────────────
  _pullTimer = setInterval(async () => {
    if (document.hidden) return;
    await pullLatest();
    await updateSyncPillFull();
  }, PULL_INTERVAL_MS);

  // ── ONLINE/OFFLINE ────────────────────────────────────────
  window.addEventListener('online', async () => {
    await syncNow();
    await pullLatest();
    await updateSyncPillFull();
  });
  window.addEventListener('offline', () => updateSyncPillFull());

  // ── VISIBILITY CHANGE (app foreground = turant sync) ──────
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    const { configured } = await getSyncConfig();
    if (!configured) return;
    await syncNow();
    await pullLatest();
    await updateSyncPillFull();
  });

  // ── FCM SILENT PING (Device A push → PULL_NOW → pull) ────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', async (event) => {
      if (event.data && event.data.type === 'PULL_NOW') {
        if (!_pulling && navigator.onLine) {
          await pullLatest();
          await updateSyncPillFull();
        }
      }
    });
  }
}

startBackgroundSync();
