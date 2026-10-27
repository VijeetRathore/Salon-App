/* ============================================
   marketing.js — Marketing Module

   Flow:
   1. Customers select karo (checkbox)
   2. Message ke "blocks" select karo (review link, insta link, loyalty, birthday...)
   3. "Add to WhatsApp Queue" → har customer ke liye uska APNA message banta hai
      (uske apne data se) aur pendingMessages mein ek-ek record ban jata hai.
   4. Neeche Marketing Queue (Pending / Sent) se ek-ek karke Send karo.

   Message queue karte waqt hi ban jata hai (snapshot) — jo preview mein dekha wahi jayega.
   ============================================ */

renderShell('marketing.html', 'Marketing');

// Birthday / Anniversary: date aane mein itne din ya kam bache hon (aaj = 0) tabhi block lagega
const WISH_DAYS_BEFORE = 2;
// Appointment reminder: aaj se itne din ke andar ki appointment
const REMINDER_DAYS_AHEAD = 2;

let customers = [];
let appointments = [];
let salonName = 'Get Gorgeous';
let links = { review: '', instagram: '', facebook: '', maps: '' };

const selected = new Set();           // selected customer ids
const activeBlocks = new Set();       // selected block keys
let customText = '';
let _queueing = false;

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------- Date helpers ---------- */

function startOfToday() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d;
}

// "YYYY-MM-DD" ki agli occurrence (saal ignore) aaj se kitne din door hai. Date na ho/galat ho → null
function daysUntilAnnual(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  const today = startOfToday();
  let next = new Date(today.getFullYear(), Number(m[2]) - 1, Number(m[3]));
  if (next < today) next = new Date(today.getFullYear() + 1, Number(m[2]) - 1, Number(m[3]));
  return Math.round((next - today) / 86400000);
}

function nextAppointmentFor(customerId) {
  const now = new Date();
  const limit = new Date(startOfToday().getTime() + (REMINDER_DAYS_AHEAD + 1) * 86400000);
  return appointments
    .filter(a => a.customerId === customerId && a.scheduledAt
      && a.status !== 'Cancelled' && a.status !== 'Completed')
    .map(a => ({ a, at: new Date(a.scheduledAt) }))
    .filter(x => !isNaN(x.at) && x.at >= now && x.at < limit)
    .sort((x, y) => x.at - y.at)[0] || null;
}

/* ---------- Blocks ----------
   run(customer) → text, ya null (is customer ke liye block lagega hi nahi)
   conditional: true  → customer ke data par depend karta hai (skip count summary mein dikhta hai)
   needsLink: key    → settings ka link khaali ho to queue se pehle rok do */

const BLOCKS = [
  { group: 'Sabke liye same' },
  { key: 'thankyou', label: 'Thank you for visiting',
    run: () => `Thank you for visiting ${salonName}! We hope you loved your service. See you again soon 💇` },
  { key: 'review', label: 'Google Review link', needsLink: 'review',
    run: () => `We'd love your feedback! Please share a quick Google review:\n${links.review}` },
  { key: 'instagram', label: 'Instagram link', needsLink: 'instagram',
    run: () => `Follow us on Instagram for offers and updates:\n${links.instagram}` },
  { key: 'facebook', label: 'Facebook link', needsLink: 'facebook',
    run: () => `Like us on Facebook:\n${links.facebook}` },
  { key: 'maps', label: 'Location (Google Maps) link', needsLink: 'maps',
    run: () => `Find us here:\n${links.maps}` },
  { key: 'custom', label: 'Custom line (apni likhi hui)',
    run: (c) => customText.trim() ? customText.trim().replace(/\{name\}/gi, c.name || '') : null },

  { group: 'Customer ke data se (har customer ka alag)' },
  { key: 'loyalty', label: 'Loyalty points', conditional: true, condText: 'points 0 hain',
    run: (c) => (Number(c.loyaltyPoints) > 0)
      ? `You have ${c.loyaltyPoints} loyalty points with ${salonName} (worth ₹${c.loyaltyPoints}). Redeem them on your next visit!`
      : null },
  { key: 'birthday', label: `Birthday wish (${WISH_DAYS_BEFORE} din ke andar birthday ho)`, conditional: true, condText: 'birthday paas mein nahi / date nahi',
    run: (c) => { const d = daysUntilAnnual(c.dob); return (d !== null && d <= WISH_DAYS_BEFORE)
      ? `Happy Birthday ${c.name}! 🎉 Wishing you a beautiful year ahead — from all of us at ${salonName}.` : null; } },
  { key: 'anniversary', label: `Anniversary wish (${WISH_DAYS_BEFORE} din ke andar anniversary ho)`, conditional: true, condText: 'anniversary paas mein nahi / date nahi',
    run: (c) => { const d = daysUntilAnnual(c.anniversary); return (d !== null && d <= WISH_DAYS_BEFORE)
      ? `Happy Anniversary ${c.name}! 🎉 Wishing you both happiness always — from ${salonName}.` : null; } },
  { key: 'reminder', label: `Appointment reminder (agle ${REMINDER_DAYS_AHEAD} din ki appointment ho)`, conditional: true, condText: 'agle din mein appointment nahi',
    run: (c) => {
      const x = nextAppointmentFor(c.id); if (!x) return null;
      const day = x.at.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
      const time = x.at.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
      return `Reminder: you have an appointment at ${salonName} on ${day} at ${time}. See you soon!`;
    } },
];

const blockByKey = (k) => BLOCKS.find(b => b.key === k);

/* ---------- Message builder (ek customer ke liye) ---------- */

function buildMessageFor(customer) {
  const parts = [];
  const skipped = [];
  BLOCKS.filter(b => b.key && activeBlocks.has(b.key)).forEach(b => {
    const text = b.run(customer);
    if (text) parts.push(text); else skipped.push(b.key);
  });
  if (!parts.length) return { text: null, skipped };
  const text = `Hi ${customer.name || 'there'}! 👋\n\n` + parts.join('\n\n') + `\n\n— ${salonName}`;
  return { text, skipped };
}

// Sab selected customers ke liye: kitne queue honge, kitne skip, kis block ne kitno ko skip kiya
function buildAll() {
  const chosen = customers.filter(c => selected.has(c.id) && c.mobile);
  const items = [], noMessage = [], blockSkips = {};
  chosen.forEach(c => {
    const r = buildMessageFor(c);
    r.skipped.forEach(k => { blockSkips[k] = (blockSkips[k] || 0) + 1; });
    if (r.text) items.push({ customer: c, text: r.text }); else noMessage.push(c);
  });
  const missingLinks = BLOCKS.filter(b => b.needsLink && activeBlocks.has(b.key) && !links[b.needsLink]).map(b => b.label);
  return { items, noMessage, blockSkips, missingLinks, chosenCount: chosen.length };
}

/* ---------- UI: customers ---------- */

function sortedCustomers() {
  return customers.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function visibleCustomers() {
  const q = (document.getElementById('mktSearch').value || '').trim().toLowerCase();
  return sortedCustomers().filter(c =>
    !q || String(c.name || '').toLowerCase().includes(q) || String(c.mobile || '').includes(q));
}

function renderCustomerList() {
  const list = visibleCustomers();
  document.getElementById('mktCustomerList').innerHTML = list.length
    ? list.map(c => `
      <label class="mkt-row ${c.mobile ? '' : 'disabled'}">
        <input type="checkbox" ${selected.has(c.id) ? 'checked' : ''} ${c.mobile ? '' : 'disabled'}
          onchange="toggleCustomer('${esc(c.id)}', this.checked)">
        <span>${esc(c.name || '(naam nahi)')} <span class="text-soft">${c.mobile ? esc(c.mobile) : '— mobile nahi'}</span></span>
      </label>`).join('')
    : '<div class="empty-state text-soft">Koi customer nahi mila.</div>';
}

function toggleCustomer(id, checked) {
  if (checked) selected.add(id); else selected.delete(id);
  refreshCompose();
}

function selectAllVisible() {
  visibleCustomers().filter(c => c.mobile).forEach(c => selected.add(c.id));
  renderCustomerList(); refreshCompose();
}

function clearSelection() {
  selected.clear(); renderCustomerList(); refreshCompose();
}

/* ---------- UI: blocks ---------- */

function renderBlocks() {
  document.getElementById('mktBlocks').innerHTML = BLOCKS.map(b => b.group
    ? `<div class="mkt-group">${esc(b.group)}</div>`
    : `<label class="mkt-row"><input type="checkbox" ${activeBlocks.has(b.key) ? 'checked' : ''}
         onchange="toggleBlock('${b.key}', this.checked)"><span>${esc(b.label)}</span></label>`).join('');
}

function toggleBlock(key, checked) {
  if (checked) activeBlocks.add(key); else activeBlocks.delete(key);
  document.getElementById('mktCustomWrap').style.display = activeBlocks.has('custom') ? 'block' : 'none';
  refreshCompose();
}

function onCustomInput() {
  customText = document.getElementById('mktCustomText').value;
  refreshCompose();
}

/* ---------- UI: preview + summary ---------- */

function refreshCompose() {
  const chosen = customers.filter(c => selected.has(c.id) && c.mobile);
  document.getElementById('mktSelCount').textContent = `(${chosen.length} selected)`;
  document.getElementById('mktQueuedNote').style.display = 'none';

  // preview customer dropdown (selection yaad rakho)
  const sel = document.getElementById('mktPreviewCustomer');
  const prev = sel.value;
  sel.innerHTML = chosen.length
    ? chosen.map(c => `<option value="${esc(c.id)}">${esc(c.name || '(naam nahi)')}</option>`).join('')
    : '<option value="">— pehle customer select karo —</option>';
  if (chosen.some(c => c.id === prev)) sel.value = prev;

  renderPreview();
  renderSummary();
}

function renderPreview() {
  const id = document.getElementById('mktPreviewCustomer').value;
  const c = customers.find(x => x.id === id);
  const box = document.getElementById('mktPreview');
  if (!c) { box.textContent = 'Customer select karo.'; return; }
  if (!activeBlocks.size) { box.textContent = 'Upar se kam se kam ek cheez select karo.'; return; }
  const r = buildMessageFor(c);
  box.textContent = r.text || '(Is customer ko koi block nahi lagega — queue nahi hoga)';
}

function renderSummary() {
  const a = buildAll();
  const lines = [];
  if (a.missingLinks.length) lines.push(`⚠️ Settings mein link khaali hai: ${a.missingLinks.join(', ')}`);
  Object.keys(a.blockSkips).forEach(k => {
    const b = blockByKey(k);
    if (b && b.conditional) lines.push(`• ${b.label.split(' (')[0]}: ${a.blockSkips[k]} customer ko nahi lagega (${b.condText})`);
  });
  if (a.noMessage.length) lines.push(`• ${a.noMessage.length} customer ka koi block nahi bana — queue nahi honge`);
  lines.unshift(a.chosenCount ? `${a.items.length} message queue honge.` : 'Koi customer select nahi.');
  document.getElementById('mktSummary').textContent = lines.join('\n');
}

/* ---------- Queue karna ---------- */

async function queueMarketingMessages() {
  if (_queueing) return;
  if (!selected.size) return alert('Pehle customers select karo.');
  if (!activeBlocks.size) return alert('Message mein kya bhejna hai, wo select karo.');

  const a = buildAll();
  if (a.missingLinks.length) return alert('Settings mein ye link khaali hai: ' + a.missingLinks.join(', ') + '\nPehle link save karo.');
  if (!a.items.length) return alert('Kisi bhi customer ke liye message nahi bana.');

  _queueing = true;
  const btn = document.getElementById('mktSendBtn');
  btn.disabled = true;
  try {
    const batchId = DB.uuid();
    for (const it of a.items) {
      await DB.add('pendingMessages', {
        batchId, type: 'marketing', status: 'pending',
        customerId: it.customer.id, customerName: it.customer.name || '', mobile: it.customer.mobile,
        message: it.text, blocks: Array.from(activeBlocks),
      });
    }
    Sync.requestSync();
    selected.clear();
    renderCustomerList(); refreshCompose();
    const note = document.getElementById('mktQueuedNote');
    note.textContent = `✅ ${a.items.length} message queue mein add ho gaye. Neeche Marketing Queue se bhejo.`;
    note.style.display = 'block';
    switchMktTab('pending');
    await loadMktQueue();
  } finally {
    _queueing = false;
    btn.disabled = false;
  }
}

/* ---------- Marketing Queue (Pending / Sent) ---------- */

function switchMktTab(tab) {
  try { sessionStorage.setItem('mktQueueTab', tab); } catch (_) {}
  ['pending', 'sent'].forEach(t => {
    document.getElementById(`mktTab-${t}`).style.display = t === tab ? 'block' : 'none';
    document.getElementById(`mktTabBtn-${t}`).className = t === tab ? 'btn btn-secondary' : 'btn btn-ghost';
  });
}

async function loadMktQueue() {
  const all = (await DB.getAll('pendingMessages')).filter(m => m.type === 'marketing');
  const pending = all.filter(m => m.status === 'pending')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const sent = all.filter(m => m.status === 'sent')
    .sort((a, b) => new Date(b.sentAt || b.createdAt) - new Date(a.sentAt || a.createdAt)).slice(0, 100);

  document.getElementById('mktTabBtn-pending').textContent = `Pending (${pending.length})`;

  document.getElementById('mktPendingList').innerHTML = pending.length
    ? pending.map(m => {
        const preview = String(m.message || '').replace(/\s+/g, ' ');
        return `
        <div class="list-row" style="align-items:flex-start; flex-wrap:wrap; gap:8px;">
          <div style="flex:1; min-width:170px;">
            <div style="font-weight:600;">${esc(m.customerName || 'Customer')}</div>
            <div class="text-soft" style="font-size:0.82rem;">${esc(preview.length > 80 ? preview.slice(0, 80) + '…' : preview)}</div>
          </div>
          <div class="flex gap-8">
            <a class="btn btn-primary" href="${buildWhatsAppLink(m.mobile, m.message || '')}" target="_blank"
               onclick="markMktSent('${esc(m.id)}')">Send</a>
            <button class="btn btn-ghost" onclick="removeMktMessage('${esc(m.id)}')">✕</button>
          </div>
        </div>`;
      }).join('')
    : '<div class="empty-state"><div class="icon">📨</div>Koi message pending nahi.</div>';

  document.getElementById('mktSentList').innerHTML = sent.length
    ? sent.map(m => `
        <div class="list-row">
          <div><span class="badge success">sent</span>
            <span style="margin-left:8px; font-weight:600;">${esc(m.customerName || 'Customer')}</span></div>
          <span class="text-soft" style="font-size:0.8rem;">${esc(fmtDateTime(m.sentAt || m.createdAt))}</span>
        </div>`).join('')
    : '<div class="empty-state text-soft">Abhi tak kuch bheja nahi.</div>';
}

async function markMktSent(id) {
  const m = await DB.get('pendingMessages', id);
  if (!m || m.status !== 'pending') return;      // double-tap / already sent
  await DB.update('pendingMessages', id, { status: 'sent', sentAt: new Date().toISOString() });
  Sync.requestSync();
  setTimeout(loadMktQueue, 300);
}

// Delete nahi — 'cancelled' status. (Delete karte to pull wapas Sheet se laa deta.)
async function removeMktMessage(id) {
  if (!confirm('Is message ko queue se hata dein?')) return;
  await DB.update('pendingMessages', id, { status: 'cancelled' });
  Sync.requestSync();
  loadMktQueue();
}

/* ---------- Init ---------- */

async function loadData() {
  customers = await DB.getAll('customers');
  appointments = await DB.getAll('appointments');
  salonName = await DB.getSetting('salonName', 'Get Gorgeous');
  links.review = await DB.getSetting('reviewLink', '');
  links.instagram = await DB.getSetting('instagramLink', '');
  links.facebook = await DB.getSetting('facebookLink', '');
  links.maps = await DB.getSetting('mapsLink', '');
}

async function init() {
  await loadData();
  renderBlocks();
  renderCustomerList();
  refreshCompose();
  await loadSocialLinks();

  let tab = 'pending';
  try { tab = sessionStorage.getItem('mktQueueTab') || 'pending'; } catch (_) {}
  switchMktTab(tab);
  await loadMktQueue();

  setInterval(loadMktQueue, 5000);
  window.addEventListener('ggDataUpdated', async () => { await loadData(); renderCustomerList(); refreshCompose(); loadMktQueue(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadMktQueue(); });
}

/* ---------- Social links ---------- */

async function loadSocialLinks() {
  document.getElementById('setReview').value = await DB.getSetting('reviewLink', '');
  document.getElementById('setInstagram').value = await DB.getSetting('instagramLink', '');
  document.getElementById('setFacebook').value = await DB.getSetting('facebookLink', '');
  document.getElementById('setMaps').value = await DB.getSetting('mapsLink', '');
  refreshQuickButtons();
}

async function saveSocialLinks() {
  await DB.setSetting('reviewLink', document.getElementById('setReview').value.trim());
  await DB.setSetting('instagramLink', document.getElementById('setInstagram').value.trim());
  await DB.setSetting('facebookLink', document.getElementById('setFacebook').value.trim());
  await DB.setSetting('mapsLink', document.getElementById('setMaps').value.trim());
  await loadData();      // memory ke links bhi update karo (blocks naya link use karein)
  refreshCompose();
  refreshQuickButtons();
  alert('Links saved.');
}

async function refreshQuickButtons() {
  document.getElementById('btnReview').href = await DB.getSetting('reviewLink', '#') || '#';
  document.getElementById('btnInsta').href = await DB.getSetting('instagramLink', '#') || '#';
  document.getElementById('btnFb').href = await DB.getSetting('facebookLink', '#') || '#';
  document.getElementById('btnMaps').href = await DB.getSetting('mapsLink', '#') || '#';
}

init();
