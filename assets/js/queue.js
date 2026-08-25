/* ============================================
   queue.js — WhatsApp send queue
   Bills + marketing messages land here (from any
   staff phone) instead of opening WhatsApp directly
   on that phone. The ONE device with the official
   WhatsApp number installed works through this list.
   ============================================ */

renderShell('whatsapp-queue.html', 'WhatsApp Queue');

function switchTab(tab) {
  ['pending', 'sent'].forEach((t) => {
    document.getElementById(`tab-${t}`).style.display = t === tab ? 'block' : 'none';
    document.getElementById(`tabBtn-${t}`).className = t === tab ? 'btn btn-secondary' : 'btn btn-ghost';
  });
}

let _isMaster = false;

async function loadQueue() {
  _isMaster = await isMasterDevice();
  document.getElementById('masterBanner').style.display = _isMaster ? 'none' : 'block';

  const all = await DB.getAll('pendingMessages');
  const pending = all.filter(m => m.status === 'pending').sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const sent = all.filter(m => m.status === 'sent').sort((a, b) => new Date(b.sentAt || b.createdAt) - new Date(a.sentAt || a.createdAt));

  const pendingEl = document.getElementById('pendingList');
  pendingEl.innerHTML = pending.length ? pending.map(renderPendingRow).join('') :
    `<div class="empty-state"><div class="icon">📨</div>No messages waiting to be sent.</div>`;

  const sentEl = document.getElementById('sentList');
  sentEl.innerHTML = sent.length ? sent.map(renderSentRow).join('') :
    `<div class="empty-state text-soft">Nothing sent yet.</div>`;
}

function renderPendingRow(m) {
  const preview = m.message.length > 70 ? m.message.slice(0, 70) + '…' : m.message;
  const actionHtml = _isMaster
    ? `<a class="btn btn-primary" href="${buildWhatsAppLink(m.mobile, m.message)}" target="_blank" onclick="markSent('${m.id}')">Send</a>`
    : `<span class="badge">Waiting for master device</span>`;
  return `
    <div class="list-row" style="align-items:flex-start; flex-wrap:wrap; gap:8px;">
      <div style="flex:1; min-width:180px;">
        <span class="badge ${m.type === 'bill' ? 'gold' : ''}">${m.type}</span>
        <div style="font-weight:600; margin-top:4px;">${m.customerName}</div>
        <div class="text-soft" style="font-size:0.82rem;">${preview}</div>
      </div>
      ${actionHtml}
    </div>
  `;
}

function renderSentRow(m) {
  return `
    <div class="list-row">
      <div>
        <span class="badge success">${m.type}</span>
        <span style="margin-left:8px;">${m.customerName}</span>
      </div>
      <span class="text-soft" style="font-size:0.8rem;">${fmtDateTime(m.sentAt || m.createdAt)}</span>
    </div>
  `;
}

async function markSent(id) {
  const current = await DB.get('pendingMessages', id);
  if (current && current.status === 'sent') {
    alert('Yeh already bhej diya gaya hai (doosre master device se).');
    loadQueue();
    return;
  }
  await DB.update('pendingMessages', id, { status: 'sent', sentAt: new Date().toISOString() });
  Sync.requestSync();
  setTimeout(loadQueue, 300);
}

// ── Auto-refresh ──────────────────────────────────────────────
// 1. Interval: har 5 seconds (was 10s)
// 2. ggDataUpdated: pull complete hone pe turant refresh
// 3. visibilitychange: jab phone unlock ho ya tab switch ho
loadQueue();

setInterval(loadQueue, 5000);

window.addEventListener('ggDataUpdated', () => loadQueue());

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadQueue();
});
