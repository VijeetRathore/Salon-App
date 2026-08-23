/* ============================================
   pin-guard.js — section-level PIN lock
   Include ONLY on dashboard.html, reports.html,
   settings.html (after db.js). Everything else
   in the app stays open for staff to use freely.
   Unlock persists for the browser tab session
   (sessionStorage) — closing the tab/app re-locks it.
   ============================================ */

/* PIN unlock persists 2 hours in localStorage (works across tabs + desktop) */
const PIN_UNLOCK_KEY = 'gg_pinUnlockedUntil';
const PIN_UNLOCK_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours

function isPinUnlocked() {
  const until = localStorage.getItem(PIN_UNLOCK_KEY);
  if (!until) return false;
  return Date.now() < Number(until);
}

function setPinUnlocked() {
  localStorage.setItem(PIN_UNLOCK_KEY, String(Date.now() + PIN_UNLOCK_DURATION_MS));
}

(async function pinGuard() {
  if (isPinUnlocked()) return;

  const existingPin = await DB.getSetting('pinHash', null);

  const overlay = document.createElement('div');
  overlay.id = 'pinGuardOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--surface-sunken,#F7F1EE);display:flex;align-items:center;justify-content:center;font-family:var(--font-body,-apple-system,sans-serif);';
  overlay.innerHTML = `
    <div class="card" style="width:min(340px,90vw);text-align:center;">
      <div style="width:64px;height:64px;border-radius:50%;background:var(--accent,#A6314F);color:#fff;display:flex;align-items:center;justify-content:center;font-family:var(--font-display,serif);font-weight:700;font-size:1.5rem;margin:0 auto 16px;">GG</div>
      <h2 style="margin:0 0 16px;font-family:var(--font-display,serif);">${existingPin ? 'Enter PIN to continue' : 'Set a PIN for this section'}</h2>
      <div class="field">
        <input type="password" id="pinGuardInput" inputmode="numeric" maxlength="6" placeholder="••••" style="text-align:center;letter-spacing:0.5em;font-size:1.4rem;width:100%;min-height:48px;padding:10px 14px;border:1.5px solid var(--line,#EBE1DD);border-radius:8px;">
      </div>
      <button class="btn btn-primary" id="pinGuardSubmit" style="width:100%;">Unlock</button>
      <a href="home.html" class="btn btn-ghost" style="width:100%;margin-top:8px;text-decoration:none;display:inline-flex;">← Back</a>
      <div id="pinGuardError" style="color:var(--danger,#A6314F);margin-top:12px;display:none;font-size:0.85rem;">Wrong PIN, try again.</div>
    </div>
  `;
  document.documentElement.appendChild(overlay);

  async function simpleHash(str) {
    const enc = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function attempt() {
    const val = document.getElementById('pinGuardInput').value.trim();
    if (val.length < 4) return;
    const hash = await simpleHash(val);

    if (!existingPin) {
      await DB.setSetting('pinHash', hash);
      setPinUnlocked();
      overlay.remove();
      return;
    }
    if (hash === existingPin) {
      setPinUnlocked();
      overlay.remove();
    } else {
      document.getElementById('pinGuardError').style.display = 'block';
      document.getElementById('pinGuardInput').value = '';
      document.getElementById('pinGuardInput').focus();
    }
  }

  document.getElementById('pinGuardSubmit').addEventListener('click', attempt);
  document.getElementById('pinGuardInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
  document.getElementById('pinGuardInput').focus();
})();
