/* ============================================
   inventory.js — Purchases & Services
   (Products & Stock tab removed — managed separately)

   Changes:
   - Tab: only Purchase Entry + Services
   - Purchase rows: Qty is now UOM dropdown
   - Bill upload: mandatory with "Bill Not Available" escape
   ============================================ */

renderShell('inventory.html', 'Inventory');

let allProducts = [];
let allServices = [];
let allPurchases = [];

const UOM_LIST = ['ml', 'l', 'g', 'kg', 'pc', 'box', 'set', 'sachet', 'strip', 'packet'];

/* ---- Tab switching (only purchase + services) ---- */

function switchTab(tab) {
  ['purchase', 'services'].forEach((t) => {
    document.getElementById(`tab-${t}`).style.display = t === tab ? 'block' : 'none';
    const btn = document.getElementById(`tabBtn-${t}`);
    btn.className = t === tab ? 'btn btn-secondary' : 'btn btn-ghost';
  });
  if (tab === 'purchase') populatePurchaseProductSelect();
}

/* ---- Bill Upload ---- */

let billImageBase64 = null;  // stored as base64 when user picks image
let billSkipped = false;     // true when user clicks "Bill Not Available"

function handleBillUpload(input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    billImageBase64 = e.target.result; // base64 data URL
    billSkipped = false;

    // Show thumbnail preview
    document.getElementById('billThumbImg').src = billImageBase64;
    document.getElementById('billPreviewThumb').style.display = 'block';
    document.getElementById('billUploadPrompt').style.display = 'none';
    document.getElementById('billStatusText').textContent = '✅ Bill photo attached';
    document.getElementById('billStatusText').style.color = 'var(--success)';
    document.getElementById('billUploadArea').style.borderColor = 'var(--success)';
  };
  reader.readAsDataURL(file);
}

// Called when user clicks "Bill Not Available" in the dialog
window.proceedWithoutBill = function() {
  billSkipped = true;
  billImageBase64 = null;
  document.getElementById('billMissingDialog').close();
  document.getElementById('billStatusText').textContent = '⚠️ Proceeding without bill';
  document.getElementById('billStatusText').style.color = 'var(--warn)';
  document.getElementById('billUploadArea').style.borderColor = 'var(--warn)';
  // Actually save the purchase now
  savePurchaseRecord();
};

function resetBillUpload() {
  billImageBase64 = null;
  billSkipped = false;
  document.getElementById('purBillInput').value = '';
  document.getElementById('billPreviewThumb').style.display = 'none';
  document.getElementById('billUploadPrompt').style.display = 'block';
  document.getElementById('billStatusText').textContent = '';
  document.getElementById('billUploadArea').style.borderColor = 'var(--line)';
}

/* ---- Purchase Rows ---- */

function uomSelect(selectedUom = '') {
  return `<select class="purRowUom" style="max-width:90px;">
    ${UOM_LIST.map(u => `<option value="${u}" ${u === selectedUom ? 'selected' : ''}>${u}</option>`).join('')}
  </select>`;
}

function purchaseProductOptions() {
  return allProducts.map(p =>
    `<option value="${p.id}">${p.name} (${p.currentStock ?? 0} ${p.unit || ''} in stock)</option>`
  ).join('');
}

function addPurchaseRow() {
  const row = document.createElement('div');
  row.className = 'flex gap-8 mb-16 purchase-row';
  row.style.flexWrap = 'wrap';
  row.innerHTML = `
    <select class="purRowProduct" style="flex:1.4; min-width:140px;">${purchaseProductOptions()}</select>
    <input  class="purRowQty" type="number" min="0" step="any" placeholder="Qty" style="max-width:80px;">
    ${uomSelect()}
    <input  class="purRowAmount" type="number" min="0" placeholder="₹ Amount" style="max-width:100px;">
    <button type="button" class="btn btn-ghost" onclick="this.parentElement.remove()">✕</button>
  `;
  document.getElementById('purchaseRows').appendChild(row);
}

function populatePurchaseProductSelect() {
  if (!document.getElementById('purchaseRows').children.length) addPurchaseRow();
  // Refresh existing selects with latest products
  document.querySelectorAll('#purchaseRows .purRowProduct').forEach(sel => {
    const prev = sel.value;
    sel.innerHTML = purchaseProductOptions();
    if (prev) sel.value = prev;
  });
}

/* ---- Save Purchase ---- */

async function recordPurchase() {
  const rows = Array.from(document.querySelectorAll('#purchaseRows .purchase-row'));
  const items = rows.map(row => ({
    productId: row.querySelector('.purRowProduct').value,
    qty: Number(row.querySelector('.purRowQty').value) || 0,
    uom: row.querySelector('.purRowUom').value,
    amount: Number(row.querySelector('.purRowAmount').value) || 0,
  })).filter(i => i.productId && i.qty > 0);

  if (!items.length) {
    alert('Add at least one product with a quantity.');
    return;
  }

  // Bill check
  if (!billImageBase64 && !billSkipped) {
    document.getElementById('billMissingDialog').showModal();
    return; // wait for user choice in dialog
  }

  savePurchaseRecord();
}

async function savePurchaseRecord() {
  const rows = Array.from(document.querySelectorAll('#purchaseRows .purchase-row'));
  const items = rows.map(row => ({
    productId: row.querySelector('.purRowProduct').value,
    qty: Number(row.querySelector('.purRowQty').value) || 0,
    uom: row.querySelector('.purRowUom').value,
    amount: Number(row.querySelector('.purRowAmount').value) || 0,
  })).filter(i => i.productId && i.qty > 0);

  // Update stock for each item
  for (const item of items) {
    const product = await DB.get('products', item.productId);
    if (!product) continue;
    const newStock = (product.currentStock || 0) + item.qty;
    await DB.update('products', item.productId, { currentStock: newStock });
    await DB.add('stockTransactions', {
      productId: item.productId,
      type: 'purchase',
      qty: item.qty,
      uom: item.uom,
      note: 'Purchase entry',
    });
  }

  await DB.add('purchases', {
    supplier: document.getElementById('purSupplier').value.trim(),
    invoiceNo: document.getElementById('purInvoice').value.trim(),
    items,
    totalAmount: items.reduce((s, i) => s + i.amount, 0),
    billImage: billImageBase64 || null,
    billSkipped: billSkipped || false,
  });

  // Reset form
  document.getElementById('purSupplier').value = '';
  document.getElementById('purInvoice').value = '';
  document.getElementById('purchaseRows').innerHTML = '';
  addPurchaseRow();
  resetBillUpload();

  await loadProducts();
  await loadPurchases();
  Sync.requestSync();

  showInvToast('✅ Purchase saved & stock updated');
}

function showInvToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = `
    position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
    background:#222; color:#fff; padding:12px 22px; border-radius:12px;
    font-size:0.9rem; font-weight:500; z-index:9999; white-space:nowrap;
  `;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

/* ---- Purchases List ---- */

async function loadProducts() {
  allProducts = await DB.getAll('products');
}

async function loadPurchases() {
  allPurchases = await DB.getAll('purchases');
  const el = document.getElementById('purchaseList');
  if (!allPurchases.length) {
    el.innerHTML = `<div class="empty-state"><div class="icon">📦</div>No purchases recorded yet.</div>`;
    return;
  }
  el.innerHTML = allPurchases
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20)
    .map(pu => {
      const itemsText = (pu.items || []).map(i => {
        const prod = allProducts.find(p => p.id === i.productId);
        return `${prod ? prod.name : 'Unknown'} × ${i.qty} ${i.uom || ''}`;
      }).join(', ');
      const billBadge = pu.billImage
        ? `<span class="badge success" style="margin-left:6px;">📷 Bill</span>`
        : pu.billSkipped
          ? `<span class="badge warn" style="margin-left:6px;">No Bill</span>`
          : '';
      return `
        <div class="list-row" style="align-items:flex-start; padding:14px 18px;">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:600;">${pu.supplier || 'Purchase'} ${pu.invoiceNo ? '· ' + pu.invoiceNo : ''}${billBadge}</div>
            <div class="text-soft" style="font-size:0.85rem;">${itemsText}</div>
          </div>
          <strong style="white-space:nowrap;">${fmtCurrency(pu.totalAmount)}</strong>
        </div>`;
    }).join('');
}

/* ---- Services ---- */

async function loadServices() {
  allServices = await DB.getAll('services');
  const el = document.getElementById('serviceList');
  if (!allServices.length) {
    el.innerHTML = `<div class="empty-state"><div class="icon">✂</div>No services yet. Add your first one.</div>`;
    return;
  }
  el.innerHTML = allServices
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(s => `
      <div class="list-row" style="padding:14px 18px; cursor:pointer;" onclick="openServiceModal('${s.id}')">
        <div>
          <div style="font-weight:600;">${s.name}</div>
          <div class="text-soft" style="font-size:0.85rem;">${s.durationMin || 0} min · ${(s.consumption || []).length} products used</div>
        </div>
        <strong>${fmtCurrency(s.price)}</strong>
      </div>`).join('');
}

function addConsumptionRow(productId = '', qty = '') {
  const row = document.createElement('div');
  row.className = 'flex gap-8 mb-16';
  row.innerHTML = `
    <select class="consProduct">${allProducts.map(p =>
      `<option value="${p.id}" data-unit="${p.unit || ''}" ${p.id === productId ? 'selected' : ''}>${p.name}</option>`
    ).join('')}</select>
    <input class="consQty" type="number" min="0" step="any" placeholder="Qty used" value="${qty}" style="max-width:100px;">
    <span class="consUnit text-soft" style="min-width:36px; align-self:center; font-size:0.85rem;"></span>
    <button type="button" class="btn btn-ghost" onclick="this.parentElement.remove()">✕</button>
  `;
  const select = row.querySelector('.consProduct');
  const unitLabel = row.querySelector('.consUnit');
  const updateUnit = () => { unitLabel.textContent = select.selectedOptions[0]?.dataset.unit || ''; };
  select.addEventListener('change', updateUnit);
  updateUnit();
  document.getElementById('svcConsumptionRows').appendChild(row);
}

function openServiceModal(id) {
  const form = document.getElementById('serviceForm');
  form.reset();
  document.getElementById('svcId').value = '';
  document.getElementById('svcConsumptionRows').innerHTML = '';
  document.querySelector('#serviceModal h2').textContent = 'New Service';
  if (id) {
    const s = allServices.find(x => x.id === id);
    if (s) {
      document.getElementById('svcId').value = s.id;
      document.getElementById('svcName').value = s.name || '';
      document.getElementById('svcPrice').value = s.price || '';
      document.getElementById('svcDuration').value = s.durationMin || '';
      (s.consumption || []).forEach(c => addConsumptionRow(c.productId, c.qty));
      document.querySelector('#serviceModal h2').textContent = 'Edit Service';
    }
  }
  document.getElementById('serviceModal').showModal();
}

document.getElementById('serviceForm').addEventListener('submit', async () => {
  const id = document.getElementById('svcId').value;
  const consumption = Array.from(document.querySelectorAll('#svcConsumptionRows > div')).map(row => ({
    productId: row.querySelector('.consProduct').value,
    qty: Number(row.querySelector('.consQty').value) || 0,
  })).filter(c => c.productId && c.qty > 0);

  const data = {
    name: document.getElementById('svcName').value.trim(),
    price: Number(document.getElementById('svcPrice').value) || 0,
    durationMin: Number(document.getElementById('svcDuration').value) || 0,
    consumption,
  };
  if (id) {
    await DB.update('services', id, data);
  } else {
    await DB.add('services', data);
  }
  document.getElementById('serviceModal').close();
  await loadServices();
  Sync.requestSync();
});

/* ---- Init ---- */
(async function init() {
  await loadProducts();
  await loadServices();
  await loadPurchases();
  populatePurchaseProductSelect();
})();
