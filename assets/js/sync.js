/* ============================================
   sync.js — multi-device sync to Google Sheets/Drive

   STARTUP SEQUENCE (app open pe):
   1. Push: koi bhi local pending records Sheet mein bhejo
   2. Pull: Sheet se sab latest data lo (ALL stores)
   3. Pill: ab accurate pending count dikhao

   BACKGROUND:
   - Push: har 30s (+ har save ke 1.5s baad debounced)
   - Pull: har 45s

   PULL SCOPE: ab SABHI stores pull hote hain — sirf
   6 nahi. Iska matlab jab bhi app open ho, har cheez
   (stock, services, staff, attendance, bills sab)
   latest ho jaati hai Sheet se.

   SPURIOUS PENDING FIX:
   Pill sirf push+pull ke BAAD update hoti hai —
   isliye "2-3 pending" wala jhooth band.
   ============================================ */

const SYNCABLE_STORES = [
  'customers', 'appointments', 'services', 'bills', 'products',
  'purchases', 'stockTransactions', 'expenses', 'staff',
  'attendance', 'pendingMessages', 'deviceTokens',
];

// Ab ALL stores pull hote hain — wahi jo backend bhi bhejta hai
const PULL_STORES = [
  'customers', 'appointments', 'services', 'bills', 'products',
  'purchases', 'stockTransactions', 'expenses', 'staff',
  'attendance', 'pendingMessages', 'deviceTokens',
];

// In stores mein Sheet se delete hone pe local se bhi hatao
const DELETE_SYNC_STORES = ['deviceTokens', 'staff'];

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

      for (const remote of remoteRecords) {
        const recordId = remote.id || remote.deviceId;
        if (!recordId) continue;
        const clean = parseJsonFields(storeName, remote);
        const local = await DB.get(storeName, recordId);

        if (!local) {
          // Nayi record Sheet mein hai, local mein nahi — add karo
          await DB.overwriteFromRemote(storeName, recordId, clean);
        } else if (local.synced !== false) {
          // Local pe koi unsaved edit nahi — Sheet wala newer ho to overwrite
          const remoteTime = new Date(remote.updatedAt || 0).getTime();
          const localTime  = new Date(local.updatedAt  || 0).getTime();
          if (remoteTime > localTime) {
            await DB.overwriteFromRemote(storeName, recordId, clean);
          }
        }
        // local.synced === false → local mein unsaved edit hai → skip (clobber mat karo)
      }

      // Sheet se hata diya → local se bhi hatao (sirf DELETE_SYNC_STORES ke liye)
      if (DELETE_SYNC_STORES.includes(storeName)) {
        const localRecords = await DB.getAll(storeName);
        for (const local of localRecords) {
          const localId = local.id || local.deviceId;
          if (!remoteIds.has(localId)) {
            await DB.remove(storeName, localId);
          }
        }
      }
    }
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

async function startBackgroundSync() {
  if (_pushTimer) return;

  // ── STARTUP SEQUENCE ──────────────────────────────
  // Step 1: Push pehle (marks records as synced)
  // Step 2: Pull (fresh data aata hai, no dirty flags)
  // Step 3: Pill update (ab count accurate hai)
  // Yahi wajah thi "2-3 pending" dikhne ki — pehle
  // pill chalti thi, push/pull baad mein.
  if (navigator.onLine) {
    const { configured } = await getSyncConfig();
    if (configured) {
      await syncNow();    // Step 1: push
      await pullLatest(); // Step 2: pull (sab stores)
    }
  }
  await updateSyncPillFull(); // Step 3: accurate count

  // ── BACKGROUND INTERVALS ──────────────────────────
  _pushTimer = setInterval(async () => {
    await syncNow();
    await updateSyncPillFull();
  }, PUSH_INTERVAL_MS);

  _pullTimer = setInterval(async () => {
    await pullLatest();
    await updateSyncPillFull();
  }, PULL_INTERVAL_MS);

  window.addEventListener('online', async () => {
    await syncNow();
    await pullLatest();
    await updateSyncPillFull();
  });
  window.addEventListener('offline', () => updateSyncPillFull());
}

startBackgroundSync();
