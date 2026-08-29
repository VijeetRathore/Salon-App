/* ============================================
   billing.js — Billing (Phase 1)
   Loyalty rule: ₹100 spent = 1 point, 1 point = ₹1 redemption value
   ============================================ */

renderShell('billing.html', 'New Bill');

let customers = [];
let services = [];
let products = [];
let staffList = [];
let lastSalonName = 'Get Gorgeous';
let lineItems = []; // { type: 'service'|'product', refId, name, qty, price, consumption? }

async function init() {
  customers = await DB.getAll('customers');
  services = await DB.getAll('services');
  products = await DB.getAll('products');
  staffList = await DB.getAll('staff');
  lastSalonName = await DB.getSetting('salonName', 'Get Gorgeous');

  // Customer dropdown replaced by phonebook search — no init needed
  document.getElementById('customerSearchInput').value = '';

  document.getElementById('billStaff').innerHTML =
    '<option value="">— Not assigned —</option>' +
    staffList.sort((a, b) => a.name.localeCompare(b.name))
      .map(s => `<option value="${s.id}">${s.name}</option>`).join('');

  document.getElementById('serviceSelect').innerHTML = services.length
    ? services.map(s => `<option value="${s.id}">${s.name} — ${fmtCurrency(s.price)}</option>`).join('')
    : '<option value="">No services set up yet — add in Inventory</option>';

  document.getElementById('productSelect').innerHTML = products.length
    ? products.map(p => `<option value="${p.id}">${p.name} — ${fmtCurrency(p.sellingCost)} (${p.currentStock ?? 0} left)</option>`).join('')
    : '<option value="">No products yet — add in Inventory</option>';

  document.getElementById('billCustomer').addEventListener('change', renderSummary);
  renderSummary();
}

function addServiceLine() {
  const id = document.getElementById('serviceSelect').value;
  const svc = services.find(s => s.id === id);
  if (!svc) return;
  lineItems.push({ type: 'service', refId: svc.id, name: svc.name, qty: 1, price: svc.price, consumption: svc.consumption || [] });
  renderItems();
}

function addProductLine() {
  const id = document.getElementById('productSelect').value;
  const qty = Number(document.getElementById('productQty').value) || 1;
  const prod = products.find(p => p.id === id);
  if (!prod) return;
  if (qty > (prod.currentStock || 0)) {
    if (!confirm(`Only ${prod.currentStock || 0} ${prod.unit || ''} in stock. Add anyway?`)) return;
  }
  lineItems.push({ type: 'product', refId: prod.id, name: prod.name, qty, price: prod.sellingCost });
  renderItems();
}

function removeLine(idx) {
  lineItems.splice(idx, 1);
  renderItems();
}

function renderItems() {
  const el = document.getElementById('billItems');
  if (!lineItems.length) {
    el.innerHTML = `<div class="empty-state text-soft">No items added yet.</div>`;
  } else {
    el.innerHTML = lineItems.map((item, idx) => `
      <div class="list-row">
        <span>
          <span class="badge ${item.type === 'service' ? '' : 'gold'}">${item.type}</span>
          &nbsp;${item.name} ${item.qty > 1 ? `× ${item.qty}` : ''}
        </span>
        <span class="flex gap-8">
          <strong>${fmtCurrency(item.price * item.qty)}</strong>
          <button class="btn btn-ghost" onclick="removeLine(${idx})">✕</button>
        </span>
      </div>
    `).join('');
  }
  renderSummary();
}

function renderSummary() {
  const subtotal = lineItems.reduce((s, i) => s + i.price * i.qty, 0);
  document.getElementById('sumSubtotal').textContent = fmtCurrency(subtotal);

  const custId = document.getElementById('billCustomer').value; // set by selectCustomer()
  const customer = customers.find(c => c.id === custId);
  const availablePoints = customer ? (customer.loyaltyPoints || 0) : 0;
  document.getElementById('pointsAvailable').textContent = `Customer has ${availablePoints} points (₹${availablePoints} value)`;

  const discount = Number(document.getElementById('discountInput').value) || 0;
  let redeem = Number(document.getElementById('redeemPoints').value) || 0;
  redeem = Math.min(redeem, availablePoints, subtotal);
  document.getElementById('redeemPoints').value = redeem;

  const total = Math.max(0, subtotal - discount - redeem);
  document.getElementById('sumTotal').textContent = fmtCurrency(total);

  const pointsEarned = Math.floor(total / 100);
  document.getElementById('pointsEarnedPreview').textContent = `+${pointsEarned} points will be earned`;
}

async function saveBill() {
  const custId = document.getElementById('billCustomer').value; // set by selectCustomer()
  if (!custId) return alert('Please select a customer.');
  if (!lineItems.length) return alert('Add at least one service or product to the bill.');

  const subtotal = lineItems.reduce((s, i) => s + i.price * i.qty, 0);
  const discount = Number(document.getElementById('discountInput').value) || 0;
  const redeem = Number(document.getElementById('redeemPoints').value) || 0;
  const total = Math.max(0, subtotal - discount - redeem);
  const pointsEarned = Math.floor(total / 100);
  const paymentMode = document.getElementById('paymentMode').value;
  const staffId = document.getElementById('billStaff').value;
  const staffMember = staffList.find(s => s.id === staffId);

  const bill = await DB.add('bills', {
    customerId: custId,
    staffId: staffId || null,
    staffName: staffMember ? staffMember.name : null,
    items: lineItems.map(i => ({ type: i.type, refId: i.refId, name: i.name, qty: i.qty, price: i.price })),
    subtotal, discount, pointsRedeemed: redeem, total, paymentMode, pointsEarned,
  });

  // Deduct stock: direct product sales
  for (const item of lineItems.filter(i => i.type === 'product')) {
    const prod = products.find(p => p.id === item.refId);
    const newStock = (prod.currentStock || 0) - item.qty;
    await DB.update('products', item.refId, { currentStock: newStock });
    await DB.add('stockTransactions', { productId: item.refId, type: 'consumption', qty: item.qty, refBillId: bill.id, note: 'Product sale' });
  }

  // Deduct stock: service product consumption
  for (const item of lineItems.filter(i => i.type === 'service')) {
    for (const c of item.consumption || []) {
      const prod = products.find(p => p.id === c.productId);
      if (!prod) continue;
      const usedQty = c.qty * item.qty;
      const newStock = (prod.currentStock || 0) - usedQty;
      await DB.update('products', c.productId, { currentStock: newStock });
      await DB.add('stockTransactions', { productId: c.productId, type: 'consumption', qty: usedQty, refBillId: bill.id, note: `Used in ${item.name}` });
    }
  }

  const customer = customers.find(c => c.id === custId);
  const newPoints = Math.max(0, (customer.loyaltyPoints || 0) - redeem + pointsEarned);
  await DB.update('customers', custId, { loyaltyPoints: newPoints });

  Sync.requestSync();
  await showBillConfirmation(bill, customer, newPoints);
}

async function showBillConfirmation(bill, customer, newPointsBalance) {
  document.getElementById('confirmSummary').innerHTML =
    `${customer.name} — <strong>${fmtCurrency(bill.total)}</strong> (${bill.paymentMode})<br>+${bill.pointsEarned} loyalty points earned`;

  const itemLines = bill.items.map(i => `• ${i.name}${i.qty > 1 ? ' x' + i.qty : ''} — ${fmtCurrency(i.price * i.qty)}`).join('\n');
  let message = `Hi ${customer.name}, thank you for visiting ${lastSalonName}! 💇\n\n${itemLines}\n`;
  if (bill.discount) message += `Discount: -${fmtCurrency(bill.discount)}\n`;
  if (bill.pointsRedeemed) message += `Points Redeemed: -${bill.pointsRedeemed}\n`;
  message += `Total Paid: ${fmtCurrency(bill.total)} (${bill.paymentMode})\n`;
  message += `Loyalty Points Earned: +${bill.pointsEarned} (Balance: ${newPointsBalance})\n\nSee you again soon!`;

  const waNote = document.getElementById('confirmWhatsappNote');
  if (customer.mobile) {
    // pendingMessages alag store nahi — bill mein hi WhatsApp fields add karo
    await DB.update('bills', bill.id, {
      whatsappMsg:    message,
      whatsappStatus: 'pending',
      whatsappMobile: customer.mobile,
    });
    Sync.requestSync();
    waNote.textContent = '📨 Bill message queued — will be sent from the salon\'s official WhatsApp shortly.';
    waNote.style.display = 'block';
  } else {
    waNote.style.display = 'none';
  }

  document.getElementById('billConfirmModal').showModal();
}

const quickServiceModal = document.getElementById('quickServiceModal');
const quickProductModal = document.getElementById('quickProductModal');

document.getElementById('quickServiceForm').addEventListener('submit', async () => {
  const name = document.getElementById('qSvcName').value.trim();
  const price = Number(document.getElementById('qSvcPrice').value) || 0;
  if (!name || !price) return;

  const newService = await DB.add('services', { name, price, durationMin: 0, consumption: [] });
  services.push(newService);
  document.getElementById('serviceSelect').innerHTML = services.map(s => `<option value="${s.id}">${s.name} — ${fmtCurrency(s.price)}</option>`).join('');
  document.getElementById('serviceSelect').value = newService.id;

  document.getElementById('quickServiceForm').reset();
  quickServiceModal.close();
  Sync.requestSync();
});

document.getElementById('quickProductForm').addEventListener('submit', async () => {
  const name = document.getElementById('qProdName').value.trim();
  const sellingCost = Number(document.getElementById('qProdSellingCost').value) || 0;
  const currentStock = Number(document.getElementById('qProdStock').value) || 0;
  const unit = document.getElementById('qProdUnit').value.trim();
  if (!name || !sellingCost) return;

  const newProduct = await DB.add('products', { name, sellingCost, currentStock, unit, purchaseCost: 0, lowStockThreshold: 5 });
  products.push(newProduct);
  document.getElementById('productSelect').innerHTML = products.map(p => `<option value="${p.id}">${p.name} — ${fmtCurrency(p.sellingCost)} (${p.currentStock ?? 0} left)</option>`).join('');
  document.getElementById('productSelect').value = newProduct.id;

  document.getElementById('quickProductForm').reset();
  quickProductModal.close();
  Sync.requestSync();
});

/* ---- Bill Done: notify master + redirect ---- */
async function onBillDone() {
  // Trigger push notification to master device (if FCM configured)
  try {
    const { gasUrl, gasToken, configured } = await Sync.getSyncConfig();
    if (configured) {
      // Fire-and-forget — notify via GAS backend
      fetch(gasUrl, {
        method: 'POST',
        body: JSON.stringify({
          token: gasToken,
          action: 'notifyMaster',
          title: 'New Bill Created',
          body: `Bill for ${document.getElementById('confirmSummary').textContent.split('—')[0].trim()} saved`,
        }),
      }).catch(() => {}); // silent fail
    }
  } catch (_) {}

  // Redirect to home — NOT dashboard (dashboard has pin-guard)
  window.location.href = 'home.html';
}

init();

/* ============================================
   PHONEBOOK-STYLE CUSTOMER SEARCH
   ============================================ */

let _selectedCustomerId = null;

function onCustomerSearch(q) {
  q = q.trim();
  const dropdown = document.getElementById('customerDropdown');

  if (!q) { dropdown.style.display = 'none'; return; }

  const isNum  = /^\d+$/.test(q);
  const ql     = q.toLowerCase();

  // Score function — phone book style
  const scored = customers
    .filter(c => {
      const mob  = String(c.mobile || '');
      const name = (c.name || '').toLowerCase();
      return isNum ? mob.includes(q) : name.includes(ql) || mob.includes(q);
    })
    .map(c => {
      const mob  = String(c.mobile || '');
      const name = (c.name || '').toLowerCase();
      let score  = 0;
      if (isNum) {
        const pos = mob.indexOf(q);
        score = pos === 0 ? 100 + q.length * 5 : Math.max(0, 80 - pos) + q.length * 5;
      } else {
        score = name.startsWith(ql) ? 100 : 50;
      }
      return { ...c, _score: score };
    })
    .sort((a, b) => b._score - a._score)
    .slice(0, 8); // max 8 results

  const addRow = `
    <div onclick="openAddCustomerFromBilling('${q}')"
      style="padding:12px 14px; cursor:pointer; border-top:1px solid var(--line,#EBE1DD);
      color:var(--accent,#A6314F); font-size:0.88rem; display:flex; gap:8px; align-items:center;">
      ➕ Add <strong>"${q}"</strong> as new customer
    </div>`;

  if (!scored.length) {
    dropdown.innerHTML = addRow;
  } else {
    dropdown.innerHTML = scored.map(c => `
      <div onclick="selectCustomer('${c.id}')"
        style="padding:12px 14px; cursor:pointer; border-bottom:1px solid var(--line,#EBE1DD);">
        <div style="font-weight:600;">${highlight(c.name, isNum ? '' : ql)}</div>
        <div class="text-soft" style="font-size:0.82rem;">
          ${highlight(c.mobile, isNum ? q : '')}
          ${c.loyaltyPoints ? ` · ${c.loyaltyPoints} pts` : ''}
        </div>
      </div>
    `).join('') + addRow;
  }

  dropdown.style.display = 'block';
}

function highlight(text, q) {
  if (!q || !text) return text || '';
  const idx = (text + '').toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return text.slice(0, idx)
    + `<mark style="background:#fff3cd; border-radius:2px; padding:0 1px;">${text.slice(idx, idx + q.length)}</mark>`
    + text.slice(idx + q.length);
}

function selectCustomer(id) {
  const c = customers.find(x => x.id === id);
  if (!c) return;

  _selectedCustomerId = id;
  document.getElementById('billCustomer').value = id;

  // Search input hide, pill dikhao
  document.getElementById('customerSearchInput').style.display = 'none';
  document.getElementById('customerDropdown').style.display   = 'none';

  const pill = document.getElementById('selectedCustomerPill');
  pill.style.display = 'flex';
  document.getElementById('selectedCustomerName').textContent   = c.name;
  document.getElementById('selectedCustomerMobile').textContent = c.mobile;

  // Points update
  const pts = c.loyaltyPoints || 0;
  document.getElementById('pointsAvailable').textContent =
    `Customer has ${pts} points (₹${pts} value)`;
  document.getElementById('redeemPoints').max = pts;
  renderSummary();
}

function clearCustomerSelection() {
  _selectedCustomerId = null;
  document.getElementById('billCustomer').value = '';
  document.getElementById('selectedCustomerPill').style.display  = 'none';
  document.getElementById('customerSearchInput').style.display   = '';
  document.getElementById('customerSearchInput').value           = '';
  document.getElementById('customerDropdown').style.display      = 'none';
  document.getElementById('pointsAvailable').textContent = 'Customer has 0 points (₹0 value)';
  document.getElementById('redeemPoints').value = 0;
  document.getElementById('redeemPoints').max   = 0;
  renderSummary();
}

// "Add customer" from billing — customer tab mein le jao, wapas billing pe aao
function openAddCustomerFromBilling(prefill) {
  document.getElementById('customerDropdown').style.display = 'none';

  // Prefill name ya number based on input
  const isNum = /^\d+$/.test(prefill);

  // Quick inline modal — full customers.html pe nahi jaate
  const existingModal = document.getElementById('quickAddCustomerModal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('dialog');
  modal.id = 'quickAddCustomerModal';
  modal.style.cssText = 'border:none; border-radius:16px; padding:0; width:min(380px,94vw);';
  modal.innerHTML = `
    <div class="card" style="border:none; box-shadow:none;">
      <h3 style="margin:0 0 16px;">New Customer</h3>
      <div class="field">
        <label>Name *</label>
        <input id="qcName" type="text" value="${isNum ? '' : prefill}" placeholder="Full name">
      </div>
      <div class="field">
        <label>Mobile *</label>
        <input id="qcMobile" type="tel" inputmode="numeric" maxlength="10"
          value="${isNum ? prefill : ''}" placeholder="10-digit mobile">
      </div>
      <div style="display:flex; gap:10px; margin-top:16px;">
        <button class="btn btn-secondary" style="flex:1;"
          onclick="document.getElementById('quickAddCustomerModal').close()">Cancel</button>
        <button class="btn btn-primary" style="flex:1;" onclick="saveQuickCustomer()">Add & Select</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.showModal();
  setTimeout(() => document.getElementById(isNum ? 'qcName' : 'qcMobile').focus(), 100);
}

async function saveQuickCustomer() {
  const name   = document.getElementById('qcName').value.trim();
  const mobile = document.getElementById('qcMobile').value.trim();

  if (!name)                      return alert('Name daalo.');
  if (!/^\d{10}$/.test(mobile))   return alert('10 digit mobile number daalo.');
  if (customers.find(c => c.mobile === mobile)) return alert('Ye number pehle se registered hai.');

  const newC = await DB.add('customers', { name, mobile, loyaltyPoints: 0 });
  customers.push(newC);
  Sync.requestSync();

  document.getElementById('quickAddCustomerModal').close();
  document.getElementById('customerSearchInput').value = name;
  selectCustomer(newC.id);
}

// Dropdown click bahar → band karo
document.addEventListener('click', (e) => {
  const input    = document.getElementById('customerSearchInput');
  const dropdown = document.getElementById('customerDropdown');
  if (input && dropdown && !input.contains(e.target) && !dropdown.contains(e.target)) {
    dropdown.style.display = 'none';
  }
});
