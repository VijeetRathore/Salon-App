/* ============================================
   shell.js — renders the top nav bar (Back/Home)
   on every inner page. home.html (the launcher
   grid) does NOT call this — it has its own markup.

   Also handles:
   - SW update detection → "Update available" banner
   ============================================ */

/* ---- Force app update: clears SW cache and reloads ---- */
async function forceAppUpdate() {
  const btn = document.getElementById('hardRefreshBtn');
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

  try {
    // Unregister all service workers
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) await reg.unregister();

    // Delete all caches
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  } catch (_) {}

  // Hard reload — browser fetches everything fresh
  window.location.reload(true);
}

function renderShell(activeHref, pageTitle) {
  const bar = document.getElementById('topNavBar');
  if (bar) {
    const canGoBack = window.history.length > 1 && document.referrer.includes(window.location.origin);
    bar.innerHTML = `
      <button class="top-nav-btn ${canGoBack ? '' : 'disabled'}" onclick="goBack()" aria-label="Back">←</button>
      <a class="top-nav-btn" href="home.html" aria-label="Home">⌂</a>
      <div class="top-nav-brand">GG</div>
      <strong style="font-size:0.95rem; flex:1;">${pageTitle}</strong>
      <span class="sync-pill" id="syncPill">
        <span class="dot"></span> <span id="syncText">…</span>
      </span>
    `;
  }

  // Pill is managed by sync.js startBackgroundSync — no need to call here
}

function goBack() {
  if (window.history.length > 1 && document.referrer.includes(window.location.origin)) {
    window.history.back();
  } else {
    window.location.href = 'home.html';
  }
}

// updateSyncPill is now handled by sync.js → updateSyncPillFull()
// Keeping a stub so home.html inline script doesn't break
function updateSyncPill() {
  if (typeof updateSyncPillFull === 'function') updateSyncPillFull();
}

function fmtCurrency(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function buildWhatsAppLink(mobile, text) {
  let clean = String(mobile || '').replace(/\D/g, '');
  if (clean.length === 10) clean = '91' + clean;
  return `https://wa.me/${clean}?text=${encodeURIComponent(text)}`;
}

/* ---- PWA Update Banner ---- */
function showUpdateBanner() {
  if (document.getElementById('swUpdateBanner')) return; // already shown
  const banner = document.createElement('div');
  banner.id = 'swUpdateBanner';
  banner.style.cssText = `
    position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999;
    background: #A3173A; color: #fff;
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 20px; font-family: var(--font-body, sans-serif);
    font-size: 0.9rem; font-weight: 500;
    box-shadow: 0 -2px 12px rgba(0,0,0,0.2);
    animation: slideUp 0.3s ease;
  `;
  banner.innerHTML = `
    <span>🔄 New update available!</span>
    <button onclick="window.location.reload()" style="
      background:#fff; color:#A3173A; border:none; border-radius:8px;
      padding:8px 18px; font-weight:700; font-size:0.85rem; cursor:pointer;
    ">Refresh Now</button>
  `;
  // Add slide-up animation
  if (!document.getElementById('swBannerStyle')) {
    const style = document.createElement('style');
    style.id = 'swBannerStyle';
    style.textContent = `@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }`;
    document.head.appendChild(style);
  }
  document.body.appendChild(banner);
}

/* ---- Register SW + listen for update messages ---- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .then((reg) => {
        // If a new SW is waiting (user had old tab open, came back), show banner
        if (reg.waiting) showUpdateBanner();
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner();
            }
          });
        });
      })
      .catch(() => {});

    // Listen for postMessage from SW after activate
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'SW_UPDATED') {
        showUpdateBanner();
      }
    });
  });
}
