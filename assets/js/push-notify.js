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
// NOTE: messaging.onTokenRefresh() Firebase v9+ mein remove ho gaya.
// Ab har 24 ghante getToken() call karo — same token milega agar valid hai,
// naya token agar Firebase ne rotate kar diya.
function setupTokenRefresh(messaging, swReg) {
  setInterval(async () => {
    try {
      const newToken = await messaging.getToken({
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: swReg,
      });
      if (newToken) {
        await saveFCMToken(newToken);
        console.log('[FCM] Token refreshed.');
      }
    } catch (err) {
      console.warn('[FCM] Token refresh check fail:', err);
    }
  }, 24 * 60 * 60 * 1000); // har 24 ghante
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
  const user = window.CURRENT_USER || getCurrentUser();
  if (!user) { console.warn('[FCM] Not logged in — token save skip.'); return; }

  // Purana token save karo (agar naya alag hai to remove karega GAS se)
  const oldToken = localStorage.getItem('gg_fcmToken');

  // localStorage mein naya token save karo
  localStorage.setItem('gg_fcmToken', token);

  // GAS users table mein save
  try {
    // Pehle purana token remove karo (duplicate notifications rokne ke liye)
    if (oldToken && oldToken !== token) {
      await fetch(
        `${GAS_URL}?action=removeFcmToken&token=${encodeURIComponent(GAS_TOKEN)}` +
        `&userId=${encodeURIComponent(user.userId)}&fcmToken=${encodeURIComponent(oldToken)}`
      );
    }
    // Naya token save karo
    await fetch(
      `${GAS_URL}?action=saveFcmToken&token=${encodeURIComponent(GAS_TOKEN)}` +
      `&userId=${encodeURIComponent(user.userId)}&fcmToken=${encodeURIComponent(token)}`
    );
    console.log('[FCM] Token saved to GAS.');
  } catch (e) {
    console.warn('[FCM] Token save to GAS failed:', e);
  }
}

// Silent push enable — login ke baad automatically call hota hai
// Popup nahi dikhata, sirf permission granted ho to token save karta hai
async function enablePushSilently(user) {
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    if (Notification.permission === 'denied') return;

    const swReg = await navigator.serviceWorker.ready;
    const messaging = firebase.messaging();

    // Permission granted hai → token lo aur save karo
    if (Notification.permission === 'granted') {
      const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
      if (token) await saveFCMToken(token);
      setupTokenRefresh(messaging, swReg);
      return;
    }

    // Permission nahi mila abhi tak → home.html pe banner dikhao
    const banner = document.getElementById('pushBanner');
    if (banner) banner.style.display = 'block';
  } catch (e) {
    console.warn('[FCM] Silent enable fail:', e);
  }
}

/* ---- Push status UI ---- */
async function refreshPushStatus() {
  const el = document.getElementById('pushStatus');
  if (!el) return;
  if (typeof Notification === 'undefined') { el.textContent = 'Not supported'; return; }
  if (Notification.permission === 'denied')  { el.textContent = 'Blocked — browser settings se allow karo'; return; }
  const token = localStorage.getItem('gg_fcmToken');
  el.textContent = (Notification.permission === 'granted' && token) ? 'Enabled ✅' : 'Not enabled yet';
}
