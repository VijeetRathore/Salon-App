/* ============================================
   queue.js — WhatsApp send queue

   UPDATED: pendingMessages store hata diya.
   Ab bills store se hi padhta hai — jo bills mein
   whatsappStatus === 'pending' hain wo queue mein
   dikhenge. Ek bill = ek row, koi extra ID nahi.
   ============================================ */

renderShell('whatsapp-queue.html', 'WhatsApp Queue');

function switchTab(tab) {
  ['pending', 'sent'].forEach((t) => {
    document.getElementById(`tab-${t}`).style.display = t === tab ? 'block' : 'none';
    document.getElementById(`tabBtn-${t}`).className  = t === tab ? 'btn btn-secondary' : 'btn btn-ghost';
  });
}

let _isMaster = false;

async function loadQueue() {
  const user = window.CURRENT_USER || getCurrentUser();
  _isMaster  = user && user.role === 'owner';
  document.getElementById('masterBanner').style.display = _isMaster ? 'none' : 'block';

  // Bills store se padho — pendingMessages store ab nahi hai
  const allBills = await DB.getAll('bills');

  const pending = allBills
    .filter(b => b.whatsappStatus === 'pending' && b.whatsappMobile)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const sent = allBills
    .filter(b => b.whatsappStatus === 'sent')
    .sort((a, b) => new Date(b.whatsappSentAt || b.createdAt) - new Date(a.whatsappSentAt || a.createdAt));

  const pendingEl = document.getElementById('pendingList');
  pendingEl.innerHTML = pending.length
    ? pending.map(renderPendingRow).join('')
    : `<div class="empty-state"><div class="icon">📨</div>No messages waiting to be sent.</div>`;

  const sentEl = document.getElementById('sentList');
  sentEl.innerHTML = sent.length
    ? sent.map(renderSentRow).join('')
    : `<div class="empty-state text-soft">Nothing sent yet.</div>`;
}

function renderPendingRow(b) {
  const msg     = b.whatsappMsg || '';
  const preview = msg.length > 70 ? msg.slice(0, 70) + '…' : msg;
  const name    = b.customerName || b.customerId || 'Customer';

  const actionHtml = _isMaster
    ? `<a class="btn btn-primary" href="${buildWhatsAppLink(b.whatsappMobile, msg)}"
         target="_blank" onclick="markSent('${b.id}')" data-whatsapp-send>Send</a>`
    : `<span class="badge">Waiting for owner device</span>`;

  return `
    <div class="list-row" style="align-items:flex-start; flex-wrap:wrap; gap:8px;">
      <div style="flex:1; min-width:180px;">
        <span class="badge gold">bill</span>
        <div style="font-weight:600; margin-top:4px;">${name}</div>
        <div class="text-soft" style="font-size:0.82rem;">${preview}</div>
      </div>
      ${actionHtml}
    </div>`;
}

function renderSentRow(b) {
  const name = b.customerName || b.customerId || 'Customer';
  return `
    <div class="list-row">
      <div>
        <span class="badge success">bill</span>
        <span style="margin-left:8px;">${name}</span>
      </div>
      <span class="text-soft" style="font-size:0.8rem;">${fmtDateTime(b.whatsappSentAt || b.createdAt)}</span>
    </div>`;
}

async function markSent(billId) {
  const bill = await DB.get('bills', billId);
  if (bill && bill.whatsappStatus === 'sent') {
    alert('Yeh already bhej diya gaya hai.');
    loadQueue();
    return;
  }
  await DB.update('bills', billId, {
    whatsappStatus: 'sent',
    whatsappSentAt: new Date().toISOString(),
  });
  Sync.requestSync();
  setTimeout(loadQueue, 300);
}

// Auto-refresh
loadQueue();
setInterval(loadQueue, 5000);
window.addEventListener('ggDataUpdated', () => loadQueue());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadQueue();
});
