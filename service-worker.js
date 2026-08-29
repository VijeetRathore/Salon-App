/* ============================================
   service-worker.js — offline app shell caching
   + Firebase Cloud Messaging background handler
   + Auto-update detection (postMessage to clients)

   CACHE VERSION: v21
   CHANGES:
   - type='sync' → PULL_NOW → no notification
   - type='bill'/'whatsapp' → show notification with correct URL
   - SHOW_NOTIFICATION message handler (foreground pages se)
   - Notification click fallback: attendance.html → home.html
   ============================================ */

importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');
importScripts('./assets/js/firebase-config.js');

try {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const type      = (payload.data && payload.data.type) || '';
    const targetUrl = (payload.data && payload.data.url)  || './home.html';

    // Silent sync ping → open clients ko PULL_NOW bhejo
    // IMPORTANT: promise return karo — warna Firebase SDK SW ko
    // promise resolve hone se pehle terminate kar deta hai
    if (type === 'sync') {
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then((clients) => {
          clients.forEach((client) => client.postMessage({ type: 'PULL_NOW' }));
        });
    }

    // Visible notification (bill, whatsapp, etc.)
    // IMPORTANT: showNotification ka promise return karo
    const title   = (payload.notification && payload.notification.title) || 'Get Gorgeous';
    const options = {
      body:  (payload.notification && payload.notification.body) || '',
      icon:  './assets/icons/icon-192.png',
      badge: './assets/icons/icon-72.png',
      data:  { url: targetUrl, type },
      requireInteraction: false,
    };
    return self.registration.showNotification(title, options);
  });
} catch (e) { /* Firebase not configured yet */ }

/* ---- Main page se SHOW_NOTIFICATION request handle karo ---- */
/* (Jab app foreground mein ho aur FCM message aaye) */
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(event.data.title || 'Get Gorgeous', {
      body: event.data.body || '',
      icon: './assets/icons/icon-192.png',
      data: { url: event.data.url || './home.html' },
    });
  }
});

/* ---- BUMP THIS every time you push new code ---- */
const CACHE_NAME = 'get-gorgeous-v27';

const APP_SHELL = [
  './index.html',
  './install.html',
  './home.html',
  './dashboard.html',
  './customers.html',
  './customer-profile.html',
  './billing.html',
  './inventory.html',
  './appointments.html',
  './expenses.html',
  './staff.html',
  './attendance.html',
  './marketing.html',
  './whatsapp-queue.html',
  './reports.html',
  './settings.html',
  './manifest.json',
  './assets/css/base.css',
  './assets/css/home.css',
  './assets/css/dashboard.css',
  './assets/css/customers.css',
  './assets/css/customer-profile.css',
  './assets/css/billing.css',
  './assets/css/inventory.css',
  './assets/css/appointments.css',
  './assets/css/expenses.css',
  './assets/css/staff.css',
  './assets/css/attendance.css',
  './assets/css/marketing.css',
  './assets/css/whatsapp-queue.css',
  './assets/css/reports.css',
  './assets/css/settings.css',
  './assets/js/db.js',
  './assets/js/device-id.js',
  './assets/js/device-guard.js',
  './assets/js/app-config.js',
  './assets/js/shell.js',
  './assets/js/pin-guard.js',
  './assets/js/sync.js',
  './assets/js/reminders.js',
  './assets/js/firebase-config.js',
  './assets/js/push-notify.js',
  './assets/js/settings.js',
  './assets/js/customers.js',
  './assets/js/customer-profile.js',
  './assets/js/billing.js',
  './assets/js/inventory.js',
  './assets/js/appointments.js',
  './assets/js/expenses.js',
  './assets/js/staff.js',
  './assets/js/attendance.js',
  './assets/js/marketing.js',
  './assets/js/queue.js',
  './assets/js/reports.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
      ),
      self.clients.claim(),
    ])
    // NOTE: SW_UPDATED broadcast hataya.
    // Pehle ye activate pe hamesha fire hota tha — real update ho ya fresh install.
    // Update button dabaao → SW unregister → fresh install → activate fire →
    // banner phir se aa jaata tha bina kisi update ke.
    // Ab shell.js ka updatefound path handle karta hai — sirf tab banner
    // dikhega jab ek naya SW kisi purane SW ko actually replace kare.
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok && request.url.startsWith(self.location.origin)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match('./home.html'));
    })
  );
});

// Notification click → data.url se sahi page kholo
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path   = (event.notification.data && event.notification.data.url) || './home.html';
  const absUrl = new URL(path, self.registration.scope).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Open window mili → sahi URL pe navigate karo
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'navigate' in client) {
          return client.focus().then(() => client.navigate(absUrl));
        }
      }
      // Koi window nahi → naya tab kholo
      return self.clients.openWindow(absUrl);
    })
  );
});
