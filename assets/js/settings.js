/* ============================================
   settings.js — Settings page (PIN system)
   ============================================ */

renderShell('settings.html', 'Settings');

async function init() {
  const user = window.CURRENT_USER || getCurrentUser();

  // Logged-in user ka naam dikhao
  document.getElementById('currentUserName').textContent = user ? user.name : '—';
  document.getElementById('currentUserRole').textContent = user ? user.role : '—';

  // Push status
  await refreshPushStatus();

  // Owner-only sections
  if (user && user.role === 'owner') {
    await loadUserList();
  }
}

/* ---------- User Management (owner only) ---------- */

async function loadUserList() {
  const el = document.getElementById('userList');
  if (!el) return;
  el.innerHTML = '<div class="text-soft" style="font-size:0.85rem;">Loading…</div>';

  try {
    const res  = await fetch(`${GAS_URL}?action=getUsers&token=${encodeURIComponent(GAS_TOKEN)}`);
    const json = await res.json();
    if (!json.ok) { el.innerHTML = `<div class="text-soft">${json.error}</div>`; return; }

    const users = json.users || [];
    if (!users.length) {
      el.innerHTML = '<div class="text-soft" style="font-size:0.85rem;">Koi user nahi mila — GAS Sheet mein users tab banao.</div>';
      return;
    }

    el.innerHTML = users.map(u => `
      <div class="list-row" style="flex-wrap:wrap; gap:8px; align-items:center;">
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600;">${u.name} ${u.userId === (window.CURRENT_USER || {}).userId ? '<span class="badge">you</span>' : ''}</div>
          <div class="text-soft" style="font-size:0.75rem;">${u.role} · ${u.isActive ? '✅ Active' : '❌ Inactive'}</div>
        </div>
        <button class="btn ${u.isActive ? 'btn-secondary' : 'btn-primary'}"
          onclick="toggleUserActive('${u.userId}', ${!u.isActive})">
          ${u.isActive ? 'Deactivate' : 'Activate'}
        </button>
      </div>
    `).join('');
  } catch (err) {
    el.innerHTML = `<div class="text-soft">Load fail: ${err.message}</div>`;
  }
}

async function toggleUserActive(userId, makeActive) {
  try {
    const res  = await fetch(GAS_URL, {
      method: 'POST',
      body: JSON.stringify({ token: GAS_TOKEN, action: 'updateUser', userId, isActive: makeActive }),
    });
    const json = await res.json();
    if (json.ok) await loadUserList();
    else alert('Error: ' + json.error);
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

async function addUser() {
  const name = document.getElementById('newUserName').value.trim();
  const pin  = document.getElementById('newUserPin').value.trim();
  const role = document.getElementById('newUserRole').value;

  if (!name) { alert('Name daalo.'); return; }
  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) { alert('4 digit PIN daalo.'); return; }

  try {
    const res  = await fetch(GAS_URL, {
      method: 'POST',
      body: JSON.stringify({ token: GAS_TOKEN, action: 'addUser', name, pin, role }),
    });
    const json = await res.json();
    if (json.ok) {
      document.getElementById('newUserName').value = '';
      document.getElementById('newUserPin').value  = '';
      alert(`${name} add ho gaye!`);
      await loadUserList();
    } else {
      alert('Error: ' + json.error);
    }
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

/* ---------- Push Notifications ---------- */

async function refreshPushStatus() {
  const el = document.getElementById('pushStatus');
  if (!el) return;
  if (typeof Notification === 'undefined') { el.textContent = 'Not supported'; return; }
  if (Notification.permission === 'denied') { el.textContent = 'Blocked — browser settings se allow karo'; return; }
  const token = localStorage.getItem('gg_fcmToken');
  el.textContent = (Notification.permission === 'granted' && token) ? 'Enabled ✅' : 'Not enabled yet';
}

/* ---------- Data Export (owner only) ---------- */

const EXPORT_STORES = [
  'customers', 'appointments', 'services', 'bills', 'products',
  'purchases', 'stockTransactions', 'expenses', 'staff', 'attendance',
];

async function exportBackup() {
  const data = {};
  for (const store of EXPORT_STORES) {
    data[store] = await DB.getAll(store);
  }
  data._exportedAt = new Date().toISOString();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `get-gorgeous-backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- Logout ---------- */

async function doLogout() {
  if (!confirm('Logout karna chahte ho?')) return;
  await Session.logout();
}

init();
