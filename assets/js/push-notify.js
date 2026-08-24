/* ============================================
   push-notify.js — FCM push registration + token refresh

   CHANGES:
   - FCM token refresh: jab token expire/change ho → auto update
   - Firebase init helper: double-init error nahi aayega
   ============================================ */

/* ---- Firebase init (safe — double init nahi hogi) ---- */
function getFirebaseMessaging() {
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
    alert('Firebase abhi configure nahi hua — assets/js/firebase-config.js mein apni Firebase project ki values daalo pehle.');
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

    // Token lo aur save karo
    const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    if (!token) throw new Error('FCM token nahi mila — VAPID key check karo.');

    await saveFCMToken(token);

    // Token refresh listener setup karo
    // Jab FCM token change ho (expire, device change, etc.) → auto update hoga
    setupTokenRefresh(messaging, swReg);

    await refreshPushStatus();
    alert('Push notifications enabled is device ke liye ✅');
  } catch (err) {
    alert('Push enable karne mein error: ' + (err.message || err));
  }
}

/* ---- Token refresh listener ---- */
function setupTokenRefresh(messaging, swReg) {
  // onTokenRefresh: jab FCM purana token invalidate kare → naya token lao
  // Ye tab hota hai jab: user browser data clear kare, Firebase update ho, etc.
  messaging.onTokenRefresh(async () => {
    try {
      const newToken = await messaging.getToken({
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: swReg,
      });
      if (newToken) {
        await saveFCMToken(newToken);
        console.log('FCM token refreshed aur save ho gaya.');
      }
    } catch (err) {
      console.warn('FCM token refresh fail hua:', err);
      // Koi alert nahi — background process hai, user ko disturb mat karo
    }
  });
}

/* ---- Token DB mein save karo + sync trigger karo ---- */
async function saveFCMToken(token) {
  // DB.update fail karega agar record exist nahi karta — DB.get se check karo pehle
  const existing = await DB.get('deviceTokens', window.DEVICE_ID);
  if (existing) {
    await DB.update('deviceTokens', window.DEVICE_ID, { fcmToken: token });
  } else {
    // Device record nahi hai — yahan kuch nahi kar sakte
    // device-id.js pe ensure karo ki deviceTokens mein record pehle se ho
    console.warn('Device token record nahi mila — device setup check karo.');
    return;
  }
  Sync.requestSync(); // Naya token sheet mein push karo
}

/* ---- Push status UI update ---- */
async function refreshPushStatus() {
  const el = document.getElementById('pushStatus');
  if (!el) return;
  if (typeof Notification === 'undefined') { el.textContent = 'Not supported'; return; }
  if (Notification.permission === 'denied')  { el.textContent = 'Blocked in browser settings'; return; }

  const me = await DB.get('deviceTokens', window.DEVICE_ID);
  el.textContent = (me && me.fcmToken) ? 'Enabled ✅' : 'Not enabled yet';
}
