/* ============================================
   attendance.js
   - Daily 11 AM notification (in-app scheduler)
   - Attendance popup (Present / Leave) with geolocation
   - Attendance page rendering (attendance.html)
   - Device ID used to identify which staff device
   ============================================ */

/* ---- Helpers ---- */

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function getStaffByDevice() {
  const all = await DB.getAll('staff');
  return all.find(s => s.deviceId === window.DEVICE_ID) || null;
}

async function getTodayRecord(deviceId) {
  const all = await DB.getByIndex('attendance', 'date', todayStr());
  return all.find(r => r.deviceId === (deviceId || window.DEVICE_ID)) || null;
}

/* ---- Geolocation ---- */

function fetchLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 0 }
    );
  });
}

/* ---- Popup UI ---- */

function removeAttPopup() {
  const el = document.getElementById('attOverlay');
  if (el) el.remove();
}

async function showAttendancePopup(opts = {}) {
  // opts.forceShow = true → skip "already marked" check (for manual open from page)
  if (!opts.forceShow) {
    const existing = await getTodayRecord();
    if (existing) return; // already marked today
  }

  removeAttPopup(); // remove if already open

  const overlay = document.createElement('div');
  overlay.id = 'attOverlay';
  overlay.className = 'att-overlay';
  overlay.innerHTML = `
    <div class="att-popup">
      <h2>Mark Attendance</h2>
      <div class="att-sub" id="attSubText">Fetching your location…</div>
      <div class="att-options">
        <button class="att-btn present" id="attBtnPresent" onclick="markAttendance('present')">
          <span class="att-btn-icon">✅</span>Present
        </button>
        <button class="att-btn leave" id="attBtnLeave" onclick="markAttendance('leave')">
          <span class="att-btn-icon">🏖️</span>Leave
        </button>
      </div>
      <div class="att-location" id="attLocationText"></div>
    </div>
  `;

  // Close on backdrop click
  overlay.addEventListener('click', (e) => { if (e.target === overlay) removeAttPopup(); });
  document.body.appendChild(overlay);

  // Start fetching location in background
  overlay._locationPromise = fetchLocation().then((loc) => {
    overlay._location = loc;
    const sub = document.getElementById('attSubText');
    const locText = document.getElementById('attLocationText');
    if (sub) sub.textContent = new Date().toLocaleDateString('en-IN', { weekday:'long', day:'2-digit', month:'short' });
    if (locText) {
      locText.textContent = loc
        ? `📍 Location captured (±${loc.accuracy}m)`
        : '📍 Location not available';
    }
  });
}

window.markAttendance = async function(status) {
  const overlay = document.getElementById('attOverlay');
  const btns = overlay ? overlay.querySelectorAll('.att-btn') : [];
  btns.forEach(b => { b.disabled = true; b.style.opacity = '0.6'; });

  // Wait for location if still fetching
  const loc = overlay && overlay._location !== undefined
    ? overlay._location
    : await fetchLocation();

  const staffMember = await getStaffByDevice();

  await DB.add('attendance', {
    deviceId: window.DEVICE_ID,
    staffId: staffMember ? staffMember.id : null,
    staffName: staffMember ? staffMember.name : `Device ${window.DEVICE_ID.slice(-4)}`,
    date: todayStr(),
    status,
    lat: loc ? loc.lat : null,
    lng: loc ? loc.lng : null,
    locationAccuracy: loc ? loc.accuracy : null,
    markedAt: new Date().toISOString(),
  });

  removeAttPopup();

  // Show confirmation toast
  showAttToast(status === 'present' ? '✅ Attendance marked: Present' : '🏖️ Leave recorded for today');

  // If we're on the attendance page, reload the list
  if (typeof renderAttendancePage === 'function') renderAttendancePage();
};

function showAttToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = `
    position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
    background:#222; color:#fff; padding:12px 22px; border-radius:12px;
    font-size:0.9rem; font-weight:500; z-index:9999; white-space:nowrap;
    animation: slideUp 0.3s ease;
  `;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

/* ---- 11 AM Daily Notification Scheduler ---- */

const ATT_CHECK_KEY = 'gg_attNotifDate';

async function checkAttendanceNotification() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  const now = new Date();
  const today = todayStr();
  const hour = now.getHours();

  // Only trigger between 11:00 and 11:59
  if (hour < 11 || hour >= 12) return;

  // Already notified today?
  const lastNotif = localStorage.getItem(ATT_CHECK_KEY);
  if (lastNotif === today) return;

  // Already marked today?
  const existing = await getTodayRecord();
  if (existing) {
    localStorage.setItem(ATT_CHECK_KEY, today);
    return;
  }

  // Show notification
  localStorage.setItem(ATT_CHECK_KEY, today);
  try {
    const n = new Notification('Get Gorgeous — Attendance', {
      body: 'Tap to mark your attendance for today',
      icon: './assets/icons/icon-192.png',
      tag: 'attendance-daily',
      requireInteraction: true,
      data: { url: './attendance.html' },
    });
    n.onclick = () => {
      window.focus();
      showAttendancePopup({ forceShow: true });
      n.close();
    };
  } catch (e) { /* silently fail */ }
}

// Check every 60 seconds (same pattern as reminders.js)
setInterval(checkAttendanceNotification, 60 * 1000);
checkAttendanceNotification(); // check immediately on load too

/* ---- Request notification permission ---- */
async function requestAttendancePermission() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') {
    await Notification.requestPermission();
  }
}
// Request permission on first load (piggybacks on reminders.js permission request)
requestAttendancePermission();

/* ---- Auto-show popup if 11 AM and not marked ---- */
(async () => {
  const now = new Date();
  const hour = now.getHours();
  if (hour >= 11 && hour < 14) {
    // Between 11 AM and 2 PM — show popup if not marked
    const existing = await getTodayRecord();
    if (!existing) {
      // Small delay so page finishes rendering first
      setTimeout(() => showAttendancePopup(), 800);
    }
  }
})();

/* Export for use on attendance.html page */
window.AttendanceModule = { showAttendancePopup, getTodayRecord, todayStr };
