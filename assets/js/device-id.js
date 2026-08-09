/* ============================================
   device-id.js — persistent device identity

   FIX: lastSeenAt heartbeat ab _updateLocalOnly se
   hota hai — synced flag touch nahi hota →
   "1 pending" bug khatam.
   ============================================ */

function getDeviceId() {
  let id = localStorage.getItem('gg_deviceId');
  if (!id) {
    id = 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('gg_deviceId', id);
  }
  return id;
}

window.DEVICE_ID = getDeviceId();

async function registerDevice() {
  const existing = await DB.get('deviceTokens', window.DEVICE_ID);
  const now = new Date().toISOString();

  if (!existing) {
    // First time — create record (synced:false so it gets pushed once)
    await DB.add('deviceTokens', {
      deviceId: window.DEVICE_ID,
      label: `Device ${window.DEVICE_ID.slice(-4)}`,
      isMaster: false,
      fcmToken: null,
      lastSeenAt: now,
    });
    return;
  }

  // Heartbeat — update lastSeenAt WITHOUT touching synced flag
  // DB.update() sets synced:false which was causing spurious "1 pending" on every page load
  const staleMs = Date.now() - new Date(existing.lastSeenAt || 0).getTime();
  if (staleMs > 5 * 60 * 1000) {
    await DB._updateLocalOnly('deviceTokens', window.DEVICE_ID, { lastSeenAt: now });
  }
}
registerDevice();

async function isMasterDevice() {
  const all = await DB.getAll('deviceTokens');
  const anyMaster = all.some((d) => d.isMaster);
  if (!anyMaster) return true;
  const me = all.find((d) => d.deviceId === window.DEVICE_ID);
  return !!(me && me.isMaster);
}
