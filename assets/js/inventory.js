/* ============================================
   inventory.js — Products | Purchase | Services

   Stock model:
   - currentStock  → base units (ml / g / pc)
   - packWeight    → base units per pack (e.g. 1000 for 1000ml bottle)
   - packUnit      → 'ml' | 'g' | 'pc' | ...
   - costPerUnit   → WAC per base unit  (₹/ml)
   - lastPurchaseRate → ₹/pack last time

   Deduction on service: c.qty (base units) deducted directly
   Deduction on product sale: item.qty × packWeight deducted
   ============================================ */

renderShell('inventory.html', 'Inventory');

let allProducts  = [];
let allServices  = [];

const UOM_LIST = ['ml','l','g','kg','pc','pcs','box','set','sachet','strip','packet'];

/* ---- Tab ---- */
function switchTab(tab) {
  ['products','purchase','services'].forEach(t => {
    document.getElementById(`tab-${t}`).style.display     = t === tab ? 'block' : 'none';
    document.getElementById(`tabBtn-${t}`).className      = t === tab ? 'btn btn-secondary' : 'btn btn-ghost';
  });
  if (tab === 'products') renderProducts();
  if (tab === 'purchase') { addPurchaseRow(); loadPurchases(); }
  if (tab === 'services') loadServices();
}

function invToast(msg) {
  const t = Object.assign(document.createElement('div'), { textContent: msg });
  Object.assign(t.style, {
    position:'fixed', bottom:'80px', left:'50%', transform:'translateX(-50%)',
    background:'#1a1a1a', color:'#fff', padding:'10px 20px',
    borderRadius:'8px', fontSize:'0.9rem', zIndex:9999, whiteSpace:'nowrap'
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

/* ============================================
   PRODUCTS TAB
   ============================================ */

async function renderProducts() {
  allProducts = await DB.getAll('products');
  const el = document.getElementById('productList');

  if (!allProducts.length) {
    el.innerHTML = `<div style="padding:32px; text-align:center; color:var(--ink-soft);">
      📦 No products yet — click "+ New Product" to add one.</div>`;
    return;
  }

  el.innerHTML = allProducts
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(p => {
      const stock  = p.currentStock || 0;
      const packW  = Number(p.packWeight) || 1;
      const packU  = p.packUnit || 'pc';
      const packs  = (packW > 1)
        ? `${(stock / packW).toFixed(2)} packs (${stock} ${packU})`
        : `${stock} ${packU}`;
      const thresh = Number(p.lowStockThreshold) || 0;
      const isLow  = thresh > 0 && stock <= thresh;
      const cost   = p.costPerUnit ? `₹${Number(p.costPerUnit).toFixed(3)}/${packU}` : '—';

      return `
        <div class="list-row" style="align-items:flex-start; cursor:pointer;"
          onclick="openProductModal('${p.id}')">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:600;">
              ${p.name}
              ${isLow ? `<span style="color:#c0392b; font-size:0.78rem; margin-left:6px;">⚠ Low</span>` : ''}
            </div>
            <div class="text-soft" style="font-size:0.82rem;">
              Stock: <strong>${packs}</strong> &nbsp;·&nbsp; WAC: ${cost}
            </div>
          </div>
          <div style="text-align:right; flex-shrink:0;">
            <div style="font-weight:600;">₹${p.sellingCost || 0}</div>
            <div class="text-soft" style="font-size:0.75rem;">sell price</div>
          </div>
        </div>`;
    }).join('');
}

function openProductModal(id) {
  const isEdit = !!id;
  document.getElementById('prodDeleteBtn').style.display = isEdit ? 'block' : 'none';
  document.querySelector('#productModal h2').textContent = isEdit ? 'Edit Product' : 'New Product';

  // Clear
  ['prodId','prodName','prodPackWeight','prodSellPrice','prodLowStock'].forEach(x => {
    document.getElementById(x).value = '';
  });
  document.getElementById('prodPackUnit').value = 'ml';

  if (isEdit) {
    const p = allProducts.find(x => x.id === id);
    if (!p) return;
    document.getElementById('prodId').value         = p.id;
    document.getElementById('prodName').value       = p.name || '';
    document.getElementById('prodPackWeight').value = p.packWeight || '';
    document.getElementById('prodPackUnit').value   = p.packUnit || 'ml';
    document.getElementById('prodSellPrice').value  = p.sellingCost || '';
    document.getElementById('prodLowStock').value   = p.lowStockThreshold || '';
  }

  document.getElementById('productModal').showModal();
}

async function saveProduct() {
  const id          = document.getElementById('prodId').value;
  const name        = document.getElementById('prodName').value.trim();
  const packWeight  = Number(document.getElementById('prodPackWeight').value) || 1;
  const packUnit    = document.getElementById('prodPackUnit').value;
  const sellingCost = Number(document.getElementById('prodSellPrice').value) || 0;
  const lowStock    = Number(document.getElementById('prodLowStock').value) || 0;

  if (!name) return alert('Product name daalo.');
  if (packWeight < 1) return alert('Pack size 1 se kam nahi ho sakta.');

  if (id) {
    await DB.update('products', id, { name, packWeight, packUnit, sellingCost, lowStockThreshold: lowStock });
  } else {
    await DB.add('products', {
      name, packWeight, packUnit, sellingCost,
      lowStockThreshold: lowStock,
      currentStock: 0, costPerUnit: 0, lastPurchaseRate: 0,
    });
  }

  document.getElementById('productModal').close();
  Sync.requestSync();
  renderProducts();
  invToast(id ? '✅ Product updated' : '✅ Product added');
}

async function deleteProduct(id) {
  if (!id) return;
  if (!confirm('Is product ko delete karo? Ye undo nahi hoga.')) return;
  await DB.remove('products', id);
  document.getElementById('productModal').close();
  Sync.requestSync();
  renderProducts();
  invToast('Product deleted');
}

/* ============================================
   PURCHASE TAB
   ============================================ */

let billImageBase64 = null;
let billSkipped     = false;
let _purchaseInit   = false; // first row only once

function addPurchaseRow() {
  const container = document.getElementById('purchaseRows');
  const row       = document.createElement('div');
  row.className   = 'purchase-row';
  row.style.cssText = `background:var(--surface-sunken,#F7F1EE); border-radius:10px;
    padding:12px; margin-bottom:10px;`;

  const qtyOpts = Array.from({length:20},(_,i)=>
    `<option value="${i+1}">${i+1}</option>`).join('');
  const uomOpts = UOM_LIST.map(u =>
    `<option value="${u}">${u}</option>`).join('');

  row.innerHTML = `
    <!-- Product search -->
    <div style="position:relative; margin-bottom:10px;">
      <input type="text" class="pur-search-input"
        placeholder="Product name type karo..."
        autocomplete="off"
        oninput="onPurSearch(this)"
        style="width:100%; box-sizing:border-box;">
      <div class="pur-dropdown" style="display:none; position:absolute; left:0; right:0;
        background:#fff; border:1px solid var(--line,#EBE1DD); border-radius:8px;
        box-shadow:0 4px 12px rgba(0,0,0,0.1); z-index:200; max-height:200px; overflow-y:auto; margin-top:2px;"></div>
      <input type="hidden" class="pur-pid">
    </div>

    <!-- Pack size + Unit + Qty -->
    <div style="display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap;">
      <div style="flex:1.2; min-width:80px;">
        <div class="text-soft" style="font-size:0.72rem; margin-bottom:2px;">Pack Size</div>
        <input type="number" class="pur-pack-weight" min="1" placeholder="e.g. 1000"
          oninput="calcRowSub(this.closest('.purchase-row'))"
          style="width:100%; box-sizing:border-box;">
      </div>
      <div style="flex:1; min-width:70px;">
        <div class="text-soft" style="font-size:0.72rem; margin-bottom:2px;">Unit</div>
        <select class="pur-pack-unit" style="width:100%;">${uomOpts}</select>
      </div>
      <div style="flex:0.8; min-width:60px;">
        <div class="text-soft" style="font-size:0.72rem; margin-bottom:2px;">Qty</div>
        <select class="pur-qty" style="width:100%;"
          onchange="calcRowSub(this.closest('.purchase-row'))">${qtyOpts}</select>
      </div>
    </div>

    <!-- Rate + Subtotal + Remove -->
    <div style="display:flex; gap:8px; align-items:flex-end;">
      <div style="flex:1;">
        <div class="text-soft" style="font-size:0.72rem; margin-bottom:2px;">Rate/pack (₹)</div>
        <input type="number" class="pur-rate" min="0" placeholder="₹"
          oninput="calcRowSub(this.closest('.purchase-row'))"
          style="width:100%; box-sizing:border-box;">
      </div>
      <div style="flex:1;">
        <div class="text-soft" style="font-size:0.72rem; margin-bottom:2px;">Subtotal</div>
        <div class="pur-sub" style="padding:8px 10px; background:#fff;
          border:1px solid var(--line,#EBE1DD); border-radius:8px; font-weight:600; color:var(--ink);">₹0</div>
      </div>
      <button type="button" onclick="this.closest('.purchase-row').remove(); calcTotal();"
        style="background:none;border:none;color:var(--ink-soft);cursor:pointer;
               padding:0 4px;font-size:1.3rem;line-height:1;">✕</button>
    </div>`;

  container.appendChild(row);

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.classList.contains('pur-search-input')) {
      document.querySelectorAll('.pur-dropdown').forEach(d => d.style.display = 'none');
    }
  }, { once: false });
}

function onPurSearch(input) {
  const q        = input.value.trim();
  const row      = input.closest('.purchase-row');
  const dropdown = row.querySelector('.pur-dropdown');

  if (!q) { dropdown.style.display = 'none'; return; }

  const ql      = q.toLowerCase();
  const matches = allProducts
    .filter(p => (p.name || '').toLowerCase().includes(ql))
    .slice(0, 7);

  const addOpt = `
    <div onclick="quickAddFromPurchase('${q.replace(/'/g,"\\'").replace(/"/g,"&quot;")}', this)"
      style="padding:10px 14px; cursor:pointer; color:var(--accent,#A6314F);
             font-size:0.88rem; border-top:1px solid var(--line,#EBE1DD);">
      ➕ Add "<strong>${q}</strong>" as new product
    </div>`;

  dropdown.innerHTML = matches.map(p => {
    const stock   = p.currentStock || 0;
    const packW   = Number(p.packWeight) || 1;
    const packU   = p.packUnit || 'pc';
    const display = packW > 1
      ? `${(stock/packW).toFixed(1)} packs (${stock}${packU})`
      : `${stock} ${packU}`;
    return `
      <div onclick="selectPurProduct(this.closest('.purchase-row'),
        '${p.id}','${p.name.replace(/'/g,"\\'")}',${packW},'${packU}')"
        style="padding:10px 14px; cursor:pointer; border-bottom:1px solid var(--line,#EBE1DD);">
        <div style="font-weight:600;">${p.name}</div>
        <div class="text-soft" style="font-size:0.78rem;">Stock: ${display}</div>
      </div>`;
  }).join('') + addOpt;

  dropdown.style.display = 'block';
}

function selectPurProduct(row, id, name, packWeight, packUnit) {
  row.querySelector('.pur-search-input').value = name;
  row.querySelector('.pur-pid').value           = id;
  row.querySelector('.pur-pack-weight').value   = packWeight;
  row.querySelector('.pur-pack-unit').value     = packUnit;
  row.querySelector('.pur-dropdown').style.display = 'none';
}

let _pendingPurRow = null;

function quickAddFromPurchase(name, el) {
  _pendingPurRow = el.closest('.purchase-row');
  document.getElementById('prodId').value         = '';
  document.getElementById('prodName').value       = name;
  document.getElementById('prodPackWeight').value = '';
  document.getElementById('prodPackUnit').value   = 'ml';
  document.getElementById('prodSellPrice').value  = '';
  document.getElementById('prodLowStock').value   = '';
  document.getElementById('prodDeleteBtn').style.display = 'none';
  document.querySelector('#productModal h2').textContent = 'New Product';
  document.getElementById('productModal').showModal();
}

// Override saveProduct to handle quick-add from purchase
const _origSaveProduct = saveProduct;
saveProduct = async function() {
  await _origSaveProduct();
  // If opened from purchase row, auto-select the new product
  if (_pendingPurRow) {
    const latest = (await DB.getAll('products'))
      .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    if (latest) {
      selectPurProduct(_pendingPurRow, latest.id, latest.name,
        latest.packWeight, latest.packUnit);
    }
    _pendingPurRow = null;
  }
};

function calcRowSub(row) {
  const qty  = Number(row.querySelector('.pur-qty').value) || 0;
  const rate = Number(row.querySelector('.pur-rate').value) || 0;
  row.querySelector('.pur-sub').textContent = `₹${(qty * rate).toLocaleString('en-IN')}`;
  calcTotal();
}

function calcTotal() {
  const total = Array.from(document.querySelectorAll('.purchase-row'))
    .reduce((sum, row) => {
      return sum + (Number(row.querySelector('.pur-qty').value) || 0)
                 * (Number(row.querySelector('.pur-rate').value) || 0);
    }, 0);
  document.getElementById('purTotalDisplay').textContent =
    `Total: ₹${total.toLocaleString('en-IN')}`;
}

/* ---- Bill upload ---- */
function handleBillUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    billImageBase64 = e.target.result;
    document.getElementById('billThumbImg').src = billImageBase64;
    document.getElementById('billPreviewThumb').style.display = 'block';
    document.getElementById('billUploadPrompt').style.display  = 'none';
    document.getElementById('billStatusText').textContent = '✅ Bill photo ready';
  };
  reader.readAsDataURL(file);
}

function proceedWithoutBill() {
  billSkipped = true;
  document.getElementById('billMissingDialog').close();
  savePurchaseData();
}

function resetBillUpload() {
  billImageBase64 = null;
  billSkipped     = false;
  document.getElementById('billPreviewThumb').style.display = 'none';
  document.getElementById('billUploadPrompt').style.display  = 'block';
  document.getElementById('billStatusText').textContent = '';
  document.getElementById('purBillInput').value = '';
}

async function recordPurchase() {
  if (!billImageBase64 && !billSkipped) {
    document.getElementById('billMissingDialog').showModal();
    return;
  }
  await savePurchaseData();
}

async function savePurchaseData() {
  const rows = Array.from(document.querySelectorAll('#purchaseRows .purchase-row'));
  const items = rows.map(row => ({
    productId:   row.querySelector('.pur-pid').value,
    productName: row.querySelector('.pur-search-input').value.trim(),
    packWeight:  Number(row.querySelector('.pur-pack-weight').value) || 1,
    packUnit:    row.querySelector('.pur-pack-unit').value,
    qty:         Number(row.querySelector('.pur-qty').value) || 1,
    ratePerPack: Number(row.querySelector('.pur-rate').value) || 0,
    subtotal:    (Number(row.querySelector('.pur-qty').value)||1)
               * (Number(row.querySelector('.pur-rate').value)||0),
  })).filter(i => i.productId && i.productName);

  if (!items.length) return alert('Kam se kam ek product add karo.');

  // WAC update per product
  for (const item of items) {
    const prod = await DB.get('products', item.productId);
    if (!prod) continue;

    const newQtyUnits     = item.qty * item.packWeight;          // e.g. 2×1000=2000ml
    const newCostPerUnit  = item.ratePerPack / item.packWeight;  // e.g. 500÷1000=0.5₹/ml
    const oldStock        = Number(prod.currentStock) || 0;
    const oldCost         = Number(prod.costPerUnit)  || 0;

    // Weighted Average Cost
    const wac = (oldStock > 0 && oldCost > 0)
      ? ((oldStock * oldCost) + (newQtyUnits * newCostPerUnit)) / (oldStock + newQtyUnits)
      : newCostPerUnit;

    await DB.update('products', item.productId, {
      currentStock:     oldStock + newQtyUnits,
      costPerUnit:      wac,
      lastPurchaseRate: item.ratePerPack,
      packWeight:       item.packWeight,
      packUnit:         item.packUnit,
    });

    await DB.add('stockTransactions', {
      productId:    item.productId,
      productName:  item.productName,
      type:         'purchase',
      qtyInUnits:   newQtyUnits,
      packs:        item.qty,
      packWeight:   item.packWeight,
      packUnit:     item.packUnit,
      ratePerPack:  item.ratePerPack,
      wacAfter:     wac,
      note: `Purchase ${item.qty}×${item.packWeight}${item.packUnit} @₹${item.ratePerPack}/pack`,
    });
  }

  const invoiceDate = document.getElementById('purDate').value
    || new Date().toISOString().slice(0,10);

  await DB.add('purchases', {
    supplier:     document.getElementById('purSupplier').value.trim(),
    invoiceNo:    document.getElementById('purInvoice').value.trim(),
    invoiceDate,
    items,
    totalAmount:  items.reduce((s,i) => s + i.subtotal, 0),
    billImage:    billImageBase64 || null,
    billSkipped:  !billImageBase64,
  });

  // Reset form
  document.getElementById('purSupplier').value = '';
  document.getElementById('purInvoice').value  = '';
  document.getElementById('purDate').value     = '';
  document.getElementById('purchaseRows').innerHTML = '';
  addPurchaseRow();
  resetBillUpload();

  allProducts = await DB.getAll('products');
  Sync.requestSync();
  await loadPurchases();
  invToast('✅ Purchase saved — stock & WAC updated');
}

async function loadPurchases() {
  const purchases = await DB.getAll('purchases');
  const el = document.getElementById('purchaseList');
  if (!purchases.length) {
    el.innerHTML = `<div style="padding:24px; text-align:center; color:var(--ink-soft);">
      No purchases yet.</div>`;
    return;
  }

  purchases
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 30)
    .forEach(pur => {
      const dateStr = pur.invoiceDate || pur.createdAt?.slice(0,10) || '';
      const row = document.createElement('div');
      row.className = 'list-row';
      row.style.alignItems = 'flex-start';
      row.innerHTML = `
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600;">${pur.supplier || 'No supplier'}</div>
          <div class="text-soft" style="font-size:0.8rem;">
            Invoice: ${pur.invoiceNo || '—'} &nbsp;·&nbsp; Date: ${dateStr}
          </div>
          <div style="font-size:0.82rem; margin-top:4px;">
            ${(pur.items||[]).map(i =>
              `${i.productName} (${i.qty}×${i.packWeight}${i.packUnit} @₹${i.ratePerPack})`
            ).join(', ')}
          </div>
        </div>
        <div style="flex-shrink:0; text-align:right;">
          <div style="font-weight:700;">₹${(pur.totalAmount||0).toLocaleString('en-IN')}</div>
          <div class="text-soft" style="font-size:0.75rem;">${pur.billSkipped ? '⚠ No bill' : '📷 Bill'}</div>
        </div>`;
      el.appendChild(row);
    });
}

/* ============================================
   SERVICES TAB
   ============================================ */

async function loadServices() {
  allProducts = await DB.getAll('products');
  allServices = await DB.getAll('services');
  const el = document.getElementById('serviceList');
  el.innerHTML = '';

  if (!allServices.length) {
    el.innerHTML = `<div style="padding:24px; text-align:center; color:var(--ink-soft);">
      No services yet.</div>`;
    return;
  }

  allServices
    .sort((a,b) => (a.name||'').localeCompare(b.name||''))
    .forEach(s => {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.style.cssText = 'align-items:flex-start; cursor:pointer;';
      row.onclick = () => openServiceModal(s);

      const cons = (s.consumption||[]).map(c => {
        const p = allProducts.find(x => x.id === c.productId);
        return p ? `${p.name}: ${c.qty}${p.packUnit||''}` : '';
      }).filter(Boolean).join(', ');

      row.innerHTML = `
        <div style="flex:1;">
          <div style="font-weight:600;">${s.name}</div>
          ${s.duration ? `<div class="text-soft" style="font-size:0.8rem;">${s.duration} min</div>` : ''}
          ${cons ? `<div style="font-size:0.8rem; color:var(--ink-soft); margin-top:2px;">
            Uses: ${cons}</div>` : ''}
        </div>
        <div style="text-align:right; flex-shrink:0;">
          <div style="font-weight:700;">₹${s.price||0}</div>
        </div>`;
      el.appendChild(row);
    });
}

function openServiceModal(s) {
  document.getElementById('svcId').value       = s ? s.id : '';
  document.getElementById('svcName').value     = s ? s.name : '';
  document.getElementById('svcPrice').value    = s ? s.price : '';
  document.getElementById('svcDuration').value = s ? (s.duration||'') : '';
  document.getElementById('svcConsumptionRows').innerHTML = '';

  if (s && s.consumption) {
    s.consumption.forEach(c => addConsumptionRow(c.productId, c.qty));
  }
  document.getElementById('serviceModal').showModal();
}

function addConsumptionRow(productId = '', qty = '') {
  const row  = document.createElement('div');
  row.style.cssText = 'display:flex; gap:8px; margin-bottom:8px; align-items:center;';

  const opts = allProducts.map(p =>
    `<option value="${p.id}" data-unit="${p.packUnit||'pc'}"
      ${p.id === productId ? 'selected' : ''}>${p.name}</option>`
  ).join('');

  // Get unit of pre-selected product
  const selProd = allProducts.find(p => p.id === productId);
  const unit    = selProd ? (selProd.packUnit || 'pc') : '';

  row.innerHTML = `
    <select class="cons-product" style="flex:2;" onchange="updateConsUnit(this)">
      <option value="">— Select product —</option>${opts}
    </select>
    <input class="cons-qty" type="number" min="0" step="any" value="${qty}"
      placeholder="Qty" style="flex:1;">
    <span class="cons-unit text-soft" style="min-width:28px; font-size:0.85rem;">${unit}</span>
    <button type="button" onclick="this.closest('div').remove()"
      style="background:none;border:none;cursor:pointer;color:var(--ink-soft);font-size:1.1rem;">✕</button>`;

  document.getElementById('svcConsumptionRows').appendChild(row);
}

function updateConsUnit(select) {
  const opt  = select.options[select.selectedIndex];
  const unit = opt ? (opt.dataset.unit || '') : '';
  select.closest('div').querySelector('.cons-unit').textContent = unit;
}

document.getElementById('serviceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id       = document.getElementById('svcId').value;
  const name     = document.getElementById('svcName').value.trim();
  const price    = Number(document.getElementById('svcPrice').value);
  const duration = Number(document.getElementById('svcDuration').value) || 0;

  const consumption = Array.from(document.querySelectorAll('#svcConsumptionRows > div'))
    .map(row => ({
      productId: row.querySelector('.cons-product').value,
      qty:       Number(row.querySelector('.cons-qty').value) || 0,
    }))
    .filter(c => c.productId && c.qty > 0);

  const data = { name, price, duration, consumption };

  if (id) await DB.update('services', id, data);
  else    await DB.add('services', data);

  document.getElementById('serviceModal').close();
  Sync.requestSync();
  loadServices();
  invToast(id ? '✅ Service updated' : '✅ Service added');
});

/* ============================================
   INIT
   ============================================ */

async function init() {
  allProducts = await DB.getAll('products');
  renderProducts(); // open on Products tab
  // Set today as default invoice date
  document.getElementById('purDate').value = new Date().toISOString().slice(0,10);
}

init();
