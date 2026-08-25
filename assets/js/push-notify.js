/* ============================================
   push-notify.js — FCM push registration + token refresh

   CHANGES:
   - FCM token refresh: jab token expire/change ho → auto update
   - Foreground handler: app open ho tab bhi FCM message handle hoga
   ============================================ */

/* ---- Firebase init (safe — double init nahi hogi) ---- */
function getFirebaseMessaging() {
  if (typeof firebase === 'undefined') return null;
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  return firebase.messaging();
}

/* ---- Push enable karo (Settings page se call hota hai) ---- */
async function enablePush() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    alert('Push notifications is not supported on this browser/device.');
    return;
  }
  if (firebaseConfig.apiKey.startsWith('PASTE-')) {
    alert('Firebase abhi configure nahi hua — assets/js/firebase-config.js update karo.');
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    alert('Notification permission denied — browser/phone settings se allow karna hoga.');
    await refreshPushStatus();
    return;
  }

  try {
    const swReg     = await navigator.serviceWorker.ready;
    const messaging = getFirebaseMessaging();
    if (!messaging) throw new Error('Firebase messaging nahi mila.');

    const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    if (!token) throw new Error('FCM token nahi mila — VAPID key check karo.');

    await saveFCMToken(token);

    // Token refresh + foreground handlers setup karo
    setupTokenRefresh(messaging, swReg);
    setupForegroundHandler(messaging);

    await refreshPushStatus();
    alert('Push notifications enabled ✅');
  } catch (err) {
    alert('Push enable karne mein error: ' + (err.message || err));
  }
}

/* ---- Token refresh listener ---- */
function setupTokenRefresh(messaging, swReg) {
  messaging.onTokenRefresh(async () => {
    try {
      const newToken = await messaging.getToken({
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: swReg,
      });
      if (newToken) {
        await saveFCMToken(newToken);
        console.log('FCM token refreshed.');
      }
    } catch (err) {
      console.warn('FCM token refresh fail hua:', err);
    }
  });
}

/* ---- Foreground handler ────────────────────────────────
   Jab app OPEN ho aur FCM message aaye:
   - type='sync'  → turant pull karo
   - type='bill'/'whatsapp' → SW ko bolo notification dikhaye  */
function setupForegroundHandler(messaging) {
  try {
    messaging.onMessage(async (payload) => {
      const type = (payload.data && payload.data.type) || '';

      if (type === 'sync') {
        // Silent ping → pull trigger
        if (window.Sync && navigator.onLine) {
          await Sync.pullLatest();
        }
        return;
      }

      // Visible notification — SW ko message bhejo woh showNotification karega
      const title = (payload.notification && payload.notification.title) || 'Get Gorgeous';
      const body  = (payload.notification && payload.notification.body)  || '';
      const url   = (payload.data && payload.data.url) || './home.html';

      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'SHOW_NOTIFICATION',
          title, body, url,
        });
      }
    });
  } catch (e) { /* Firebase ready nahi — ignore */ }
}

/* ---- Token DB mein save + sync ---- */
async function saveFCMToken(token) {
  const existing = await DB.get('deviceTokens', window.DEVICE_ID);
  if (existing) {
    await DB.update('deviceTokens', window.DEVICE_ID, { fcmToken: token });
  } else {
    console.warn('Device token record nahi mila — device setup check karo.');
    return;
  }
  Sync.requestSync();
}

/* ---- Push status UI ---- */
async function refreshPushStatus() {
  const el = document.getElementById('pushStatus');
  if (!el) return;
  if (typeof Notification === 'undefined') { el.textContent = 'Not supported'; return; }
  if (Notification.permission === 'denied') { el.textContent = 'Blocked in browser settings'; return; }
  const me = await DB.get('deviceTokens', window.DEVICE_ID);
  el.textContent = (me && me.fcmToken) ? 'Enabled ✅' : 'Not enabled yet';
}
