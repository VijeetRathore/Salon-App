/* ============================================
   session.js — Login session + role-based access

   SESSION (localStorage 'gg_session'):
   { userId, name, role }

   ROLES:
   - owner : sab kuch
   - staff : billing, customers, appointments,
             inventory, staff, attendance,
             whatsapp (view only — send hidden)
   ============================================ */

const SESSION_KEY   = 'gg_session';
const FCM_TOKEN_KEY = 'gg_fcmToken';

const MODULE_ACCESS = {
  billing:      ['owner', 'staff'],
  customers:    ['owner', 'staff'],
  appointments: ['owner', 'staff'],
  inventory:    ['owner', 'staff'],
  staff:        ['owner', 'staff'],
  attendance:   ['owner', 'staff'],
  whatsapp:     ['owner', 'staff'],
  dashboard:    ['owner'],
  reports:      ['owner'],
  expenses:     ['owner'],
  marketing:    ['owner'],
  settings:     ['owner'],
};

/* ---------- Session read ---------- */

function getCurrentUser() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/* ---------- Guards ---------- */

function requireLogin() {
  const user = getCurrentUser();
  if (!user) { window.location.replace('./login.html'); return null; }
  window.CURRENT_USER = user;
  return user;
}

function enforceAccess(module) {
  const user = getCurrentUser();
  if (!user) { window.location.replace('./login.html'); return; }
  const allowed = MODULE_ACCESS[module] || ['owner'];
  if (!allowed.includes(user.role)) window.location.replace('./home.html');
}

/* ---------- Role UI ---------- */

function applyRoleUI() {
  const user = getCurrentUser();
  if (!user) return;
  if (user.role !== 'owner') {
    document.querySelectorAll('[data-owner-only]').forEach(el => el.style.display = 'none');
    document.querySelectorAll('[data-whatsapp-send]').forEach(el => el.style.display = 'none');
  }
  const nameEl = document.getElementById('loggedInUserName');
  if (nameEl) nameEl.textContent = user.name;
}

/* ---------- Login ---------- */

async function loginWithPin(pin) {
  const res  = await fetch(`${GAS_URL}?action=verifyPin&token=${encodeURIComponent(GAS_TOKEN)}&pin=${encodeURIComponent(pin)}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Invalid PIN');
  localStorage.setItem(SESSION_KEY, JSON.stringify(json.user));
  window.CURRENT_USER = json.user;

  // Login ke baad push notification silently enable karo (sabhi users ke liye)
  // enablePushSilently push-notify.js mein define hai — home.html pe available hoga
  setTimeout(() => {
    if (typeof enablePushSilently === 'function') enablePushSilently(json.user);
  }, 1500);

  return json.user;
}

/* ---------- Logout ---------- */

async function logout() {
  const user  = getCurrentUser();
  const token = localStorage.getItem(FCM_TOKEN_KEY);
  if (user && token) {
    try {
      await fetch(`${GAS_URL}?action=removeFcmToken&token=${encodeURIComponent(GAS_TOKEN)}&userId=${encodeURIComponent(user.userId)}&fcmToken=${encodeURIComponent(token)}`);
    } catch (e) { /* logout anyway */ }
    localStorage.removeItem(FCM_TOKEN_KEY);
  }
  localStorage.removeItem(SESSION_KEY);
  window.location.replace('./login.html');
}

window.Session      = { getCurrentUser, requireLogin, enforceAccess, applyRoleUI, loginWithPin, logout };
window.CURRENT_USER = getCurrentUser();
