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

  document.getElementById('billCustomer').innerHTML =
    '<option value="">— Select customer —</option>' +
    customers.sort((a, b) => a.name.localeCompare(b.name))
      .map(c => `<option value="${c.id}">${c.name} (${c.mobile})</option>`).join('');

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

  const custId = document.getElementById('billCustomer').value;
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
  const custId = document.getElementById('billCustomer').value;
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
