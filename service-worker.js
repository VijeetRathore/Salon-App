/* ============================================
   service-worker.js — offline app shell caching
   + Firebase Cloud Messaging background handler
   + Auto-update detection (postMessage to clients)

   CHANGES:
   - Silent sync ping: type='sync' → PULL_NOW → no notification shown
   - Notification URLs: data.url se sahi page open hoga
     (bills → billing.html, whatsapp → whatsapp-queue.html)
   - Fallback URL fix: attendance.html → home.html
   - Cache version: v20
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

    // Silent sync ping — notification mat dikhao, sirf clients ko pull karo
    // Ye tab aata hai jab koi aur device data push karta hai
    if (type === 'sync') {
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'PULL_NOW' }));
      });
      return; // Koi showNotification nahi
    }

    // Normal visible notification (bills, whatsapp queue)
    const title   = (payload.notification && payload.notification.title) || 'Get Gorgeous';
    const options = {
      body:  (payload.notification && payload.notification.body) || '',
      icon:  './assets/icons/icon-192.png',
      // data mein url save karo taaki notificationclick pe sahi page khule
      data:  { url: targetUrl, type: type },
    };
    self.registration.showNotification(title, options);
  });
} catch (e) { /* Firebase not configured yet */ }

/* ---- BUMP THIS every time you push new code ---- */
const CACHE_NAME = 'get-gorgeous-v20';

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
    ]).then(() => {
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'SW_UPDATED' }));
      });
    })
  );
});

// Cache-first for app shell; network-first fallback for everything else
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

// Notification click → sahi page open karo
// data.url se page decide hota hai (GAS ne set kiya tha)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // data.url GAS ne set kiya tha (e.g. './billing.html', './whatsapp-queue.html')
  // FIX: pehle attendance.html tha — ab home.html fallback hai
  const url = (event.notification.data && event.notification.data.url) || './home.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.includes(self.location.origin));
      if (existing) { existing.focus(); existing.navigate(url); }
      else self.clients.openWindow(url);
    })
  );
});
