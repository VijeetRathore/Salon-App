/* ============================================
   Code.gs — Get Gorgeous backend (Google Apps Script)

   PIN SYSTEM UPDATE:
   - users tab: userId | name | pin | role | fcmTokens | isActive
   - verifyPin: 4-digit PIN se login
   - saveFcmToken / removeFcmToken: per-user token management
   - Notifications: deviceTokens table hataya, users table use hogi
   - getUsers / addUser / updateUser: Settings se user management

   SHEET_NAMES mein 'users' nahi hai — login direct GAS call hai,
   IDB sync ki zaroorat nahi. Baaki sab stores same hain.

   SCRIPT PROPERTIES:
     FCM_PROJECT_ID   → Firebase project ID
     FCM_CLIENT_EMAIL → service account client_email
     FCM_PRIVATE_KEY  → service account private_key (with \n)
   ============================================ */

const SECRET_TOKEN    = 'getgorgeous_2026';
const DRIVE_FOLDER_ID = '1kk44K2jR1gMl8gFYfgejDkPCuzEnCvtI';

// Data stores jo IDB mein sync hote hain
// 'users' yahan nahi — PIN data IDB mein nahi jaana chahiye
const SHEET_NAMES = [
  'customers', 'appointments', 'services', 'bills', 'products',
  'purchases', 'stockTransactions', 'expenses', 'staff', 'attendance',
];

const DELETE_SYNC_STORES = [
  'customers', 'appointments', 'services', 'bills', 'products',
  'purchases', 'stockTransactions', 'expenses', 'staff', 'attendance',
];

/* ============================================
   ROUTING
   ============================================ */

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== SECRET_TOKEN) return jsonResponse({ ok: false, error: 'Invalid token' });

    if (body.action === 'pushRecords') return jsonResponse(pushRecords(body.storeName, body.records));
    if (body.action === 'uploadPhoto')  return jsonResponse(uploadPhoto(body.dataUrl, body.fileName));
    if (body.action === 'addUser')      return jsonResponse(addUser(body.name, body.pin, body.role));
    if (body.action === 'updateUser')   return jsonResponse(updateUser(body.userId, body.isActive));

    return jsonResponse({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    const token = e.parameter.token;
    if (token !== SECRET_TOKEN) return jsonResponse({ ok: false, error: 'Invalid token' });

    const action = e.parameter.action;

    if (action === 'pullAll')   return jsonResponse(pullAll());
    if (action === 'pullSince') return jsonResponse(pullSince(e.parameter.since || null));

    if (action === 'sendSyncPing') {
      try { notifyAllDevicesSilent(); } catch (e) { }
      return jsonResponse({ ok: true });
    }

    // --- PIN Login ---
    if (action === 'verifyPin') return jsonResponse(verifyPin(e.parameter.pin));

    // --- FCM token management ---
    if (action === 'saveFcmToken')    return jsonResponse(saveFcmToken(e.parameter.userId, e.parameter.fcmToken));
    if (action === 'removeFcmToken')  return jsonResponse(removeFcmToken(e.parameter.userId, e.parameter.fcmToken));

    // --- User list (Settings page ke liye — PIN field nahi aata) ---
    if (action === 'getUsers')  return jsonResponse(getUsers());

    // --- Diagnostic ---
    if (action === 'testFCM')   return jsonResponse(testFCMDiagnostic());

    return jsonResponse({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

/* ============================================
   PIN SYSTEM — Users table
   Sheet tab: users
   Columns: userId | name | pin | role | fcmTokens | isActive
   ============================================ */

function verifyPin(pin) {
  if (!pin) return { ok: false, error: 'PIN nahi diya' };

  const sheet = _getUsersSheet();
  if (!sheet) return { ok: false, error: 'users tab nahi mili — Sheet mein users tab banao. Columns: userId, name, pin, role, fcmTokens, isActive' };

  const { values, headers } = _readSheet(sheet);
  const idx = { pin: headers.indexOf('pin'), active: headers.indexOf('isActive'), userId: headers.indexOf('userId'), name: headers.indexOf('name'), role: headers.indexOf('role') };

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row[idx.pin]).trim() !== String(pin).trim()) continue;

    const isActive = row[idx.active];
    if (isActive === false || String(isActive).toUpperCase() === 'FALSE') {
      return { ok: false, error: 'Account inactive hai — owner se contact karo.' };
    }

    return {
      ok: true,
      user: {
        userId: String(row[idx.userId] || ''),
        name:   String(row[idx.name]   || ''),
        role:   String(row[idx.role]   || 'staff').toLowerCase(),
      },
    };
  }
  return { ok: false, error: 'Wrong PIN' };
}

function getUsers() {
  const sheet = _getUsersSheet();
  if (!sheet) return { ok: true, users: [] };

  const { values, headers } = _readSheet(sheet);
  const idx = {
    userId: headers.indexOf('userId'),
    name:   headers.indexOf('name'),
    role:   headers.indexOf('role'),
    active: headers.indexOf('isActive'),
  };

  const users = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const userId = String(row[idx.userId] || '').trim();
    if (!userId) continue;
    users.push({
      userId:   userId,
      name:     String(row[idx.name]   || ''),
      role:     String(row[idx.role]   || 'staff').toLowerCase(),
      isActive: row[idx.active] !== false && String(row[idx.active]).toUpperCase() !== 'FALSE',
    });
  }
  return { ok: true, users };
}

function addUser(name, pin, role) {
  if (!name || !pin || !role) return { ok: false, error: 'name, pin, role zaroori hain' };
  if (String(pin).length !== 4) return { ok: false, error: 'PIN 4 digits ka hona chahiye' };

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let sheet   = ss.getSheetByName('users');

  if (!sheet) {
    sheet = ss.insertSheet('users');
    sheet.appendRow(['userId', 'name', 'pin', 'role', 'fcmTokens', 'isActive']);
  }

  const userId = 'usr-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  sheet.appendRow([userId, name, String(pin), role, '[]', true]);
  return { ok: true, userId };
}

function updateUser(userId, isActive) {
  const sheet = _getUsersSheet();
  if (!sheet) return { ok: false, error: 'users sheet nahi mili' };

  const { values, headers } = _readSheet(sheet);
  const userIdIdx = headers.indexOf('userId');
  const activeIdx = headers.indexOf('isActive');

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][userIdIdx]).trim() !== String(userId).trim()) continue;
    sheet.getRange(i + 1, activeIdx + 1).setValue(isActive);
    return { ok: true };
  }
  return { ok: false, error: 'User nahi mila' };
}

/* ============================================
   FCM TOKEN MANAGEMENT
   ============================================ */

function saveFcmToken(userId, fcmToken) {
  if (!userId || !fcmToken) return { ok: false, error: 'userId aur fcmToken zaroori hain' };

  const sheet = _getUsersSheet();
  if (!sheet) return { ok: false, error: 'users sheet nahi mili' };

  const { values, headers } = _readSheet(sheet);
  const userIdIdx   = headers.indexOf('userId');
  const fcmTokenIdx = headers.indexOf('fcmTokens');

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][userIdIdx]).trim() !== String(userId).trim()) continue;

    let tokens = [];
    try { tokens = JSON.parse(values[i][fcmTokenIdx] || '[]'); } catch { tokens = []; }
    if (!Array.isArray(tokens)) tokens = [];
    if (!tokens.includes(fcmToken)) tokens.push(fcmToken);

    sheet.getRange(i + 1, fcmTokenIdx + 1).setValue(JSON.stringify(tokens));
    return { ok: true };
  }
  return { ok: false, error: 'User nahi mila userId: ' + userId };
}

function removeFcmToken(userId, fcmToken) {
  if (!userId || !fcmToken) return { ok: true }; // silent ok

  const sheet = _getUsersSheet();
  if (!sheet) return { ok: true };

  const { values, headers } = _readSheet(sheet);
  const userIdIdx   = headers.indexOf('userId');
  const fcmTokenIdx = headers.indexOf('fcmTokens');

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][userIdIdx]).trim() !== String(userId).trim()) continue;

    let tokens = [];
    try { tokens = JSON.parse(values[i][fcmTokenIdx] || '[]'); } catch { tokens = []; }
    tokens = tokens.filter(t => t !== fcmToken);
    sheet.getRange(i + 1, fcmTokenIdx + 1).setValue(JSON.stringify(tokens));
    return { ok: true };
  }
  return { ok: true };
}

/* ============================================
   PUSH (upsert rows)
   ============================================ */

function pushRecords(storeName, records) {
  if (!SHEET_NAMES.includes(storeName)) return { ok: false, error: 'Unknown store: ' + storeName };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(storeName);
  if (!sheet) sheet = ss.insertSheet(storeName);

  records.forEach((record) => {
    const flat     = flattenRecord(record);
    const headers  = getOrCreateHeaders(sheet, flat);
    const rowIndex = findRowById(sheet, flat.id);
    const rowValues = headers.map((h) => (flat[h] !== undefined ? flat[h] : ''));

    if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([rowValues]);
    else              sheet.appendRow(rowValues);
  });

  logSync(storeName, records.length);

  // Bills push: ek hi notification — WhatsApp queue URL ke saath
  if (storeName === 'bills' && records.length > 0) {
    try {
      const total  = records.reduce((s, r) => s + (Number(r.total) || 0), 0);
      const hasWA  = records.some(r => r.whatsappStatus === 'pending');
      const title  = records.length === 1
        ? `New Bill — ₹${total.toLocaleString('en-IN')}`
        : `${records.length} Bills — ₹${total.toLocaleString('en-IN')}`;
      const body   = hasWA
        ? 'WhatsApp message ready — queue mein bhejo'
        : `Payment received`;
      // Click se WhatsApp queue khule (agar WA pending hai) warna billing
      const url    = hasWA ? './whatsapp-queue.html' : './billing.html';
      notifyOwners('bill', title, body, url);
    } catch (e) { }
  }

  return { ok: true, synced: records.length };
}

function flattenRecord(record) {
  const flat = {};
  Object.keys(record).forEach(k => {
    const v = record[k];
    flat[k] = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v;
  });
  return flat;
}

function getOrCreateHeaders(sheet, sampleFlatRecord) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    // Naya sheet — record ke saare keys header banao
    const headers = Object.keys(sampleFlatRecord);
    sheet.appendRow(headers);
    return headers;
  }
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  // Record mein naye keys hain jo headers mein nahi — add karo
  const newKeys = Object.keys(sampleFlatRecord).filter(k => !existing.includes(k));
  if (newKeys.length > 0) {
    const extended = [...existing, ...newKeys];
    sheet.getRange(1, 1, 1, extended.length).setValues([extended]);
    return extended;
  }
  return existing;
}

function findRowById(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  const idx = ids.indexOf(id);
  return idx === -1 ? -1 : idx + 2;
}

/* ============================================
   PULL
   ============================================ */

function pullAll() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const result = {};
  SHEET_NAMES.forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) { result[name] = []; return; }
    const values  = sheet.getDataRange().getValues();
    const headers = values[0];
    result[name]  = values.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
  });
  return { ok: true, data: result, pulledAt: new Date().toISOString() };
}

function pullSince(sinceIso) {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const result    = {};
  const sinceTime = sinceIso ? new Date(sinceIso).getTime() : 0;

  SHEET_NAMES.forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) { result[name] = []; return; }

    const values  = sheet.getDataRange().getValues();
    const headers = values[0];
    const allRows = values.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });

    const needFull = !sinceTime || DELETE_SYNC_STORES.includes(name);
    result[name] = needFull
      ? allRows
      : allRows.filter(obj => new Date(obj.updatedAt || 0).getTime() > sinceTime);
  });

  return { ok: true, data: result, pulledAt: new Date().toISOString() };
}

/* ============================================
   PHOTOS
   ============================================ */

function uploadPhoto(dataUrl, fileName) {
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const parts  = dataUrl.split(',');
  const mime   = parts[0].match(/data:(.*);base64/)[1];
  const bytes  = Utilities.base64Decode(parts[1]);
  const blob   = Utilities.newBlob(bytes, mime, fileName);
  const file   = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { ok: true, url: file.getUrl(), id: file.getId() };
}

/* ============================================
   SYNC LOG
   ============================================ */

function logSync(storeName, count) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Sync_Log');
  if (!sheet) {
    sheet = ss.insertSheet('Sync_Log');
    sheet.appendRow(['timestamp', 'store', 'recordCount']);
  }
  sheet.appendRow([new Date().toISOString(), storeName, count]);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================
   FCM NOTIFICATIONS
   ============================================ */

// Owner role wale sabhi users ko visible notification bhejo
function notifyOwners(type, title, body, targetUrl) {
  const sheet = _getUsersSheet();
  if (!sheet) return;

  const { values, headers } = _readSheet(sheet);
  const idx = {
    role:   headers.indexOf('role'),
    active: headers.indexOf('isActive'),
    tokens: headers.indexOf('fcmTokens'),
  };
  if (idx.tokens === -1) return;

  let accessToken = null;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const isActive = row[idx.active];
    if (isActive === false || String(isActive).toUpperCase() === 'FALSE') continue;
    if (String(row[idx.role] || '').toLowerCase() !== 'owner') continue;

    let tokens = [];
    try { tokens = JSON.parse(row[idx.tokens] || '[]'); } catch { tokens = []; }

    for (const token of tokens) {
      if (!token) continue;
      if (!accessToken) accessToken = getFCMAccessToken();
      try { sendFCMMessage(accessToken, token, title, body, type, targetUrl); } catch (e) { }
    }
  }
}

// Sabhi active users ke sabhi devices ko silent sync ping bhejo
function notifyAllDevicesSilent() {
  const sheet = _getUsersSheet();
  if (!sheet) return;

  const { values, headers } = _readSheet(sheet);
  const idx = {
    active: headers.indexOf('isActive'),
    tokens: headers.indexOf('fcmTokens'),
  };
  if (idx.tokens === -1) return;

  let accessToken = null;
  for (let i = 1; i < values.length; i++) {
    const isActive = values[i][idx.active];
    if (isActive === false || String(isActive).toUpperCase() === 'FALSE') continue;

    let tokens = [];
    try { tokens = JSON.parse(values[i][idx.tokens] || '[]'); } catch { tokens = []; }

    for (const token of tokens) {
      if (!token) continue;
      if (!accessToken) {
        try { accessToken = getFCMAccessToken(); } catch (e) { return; }
      }
      try { sendFCMMessage(accessToken, token, null, null, 'sync', null); } catch (e) { }
    }
  }
}

/* ---- FCM helpers ---- */

function sendFCMMessage(accessToken, fcmToken, title, body, type, targetUrl) {
  const projectId = PropertiesService.getScriptProperties().getProperty('FCM_PROJECT_ID');
  const payload   = {
    token: fcmToken,
    data:  { type: type || 'general', url: targetUrl || './home.html' },
  };
  if (title && body) {
    payload.notification = { title, body };
    payload.webpush = { notification: { icon: '/assets/icons/icon-192.png' } };
  }
  UrlFetchApp.fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify({ message: payload }),
    muteHttpExceptions: true,
  });
}

function getFCMAccessToken() {
  const props       = PropertiesService.getScriptProperties();
  const clientEmail = props.getProperty('FCM_CLIENT_EMAIL');
  const privateKey  = props.getProperty('FCM_PRIVATE_KEY').replace(/\\n/g, '\n');
  const header      = { alg: 'RS256', typ: 'JWT' };
  const now         = Math.floor(Date.now() / 1000);
  const claimSet    = {
    iss: clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now,
  };
  const b64 = obj => Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  const toSign    = b64(header) + '.' + b64(claimSet);
  const signature = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(toSign, privateKey)).replace(/=+$/, '');
  const jwt       = toSign + '.' + signature;

  const res  = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', contentType: 'application/x-www-form-urlencoded',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
    muteHttpExceptions: true,
  });
  const json = JSON.parse(res.getContentText());
  if (!json.access_token) throw new Error('FCM auth failed: ' + res.getContentText());
  return json.access_token;
}

/* ---- Internal sheet helpers ---- */

function _getUsersSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('users');
  return (sheet && sheet.getLastRow() >= 2) ? sheet : null;
}

function _readSheet(sheet) {
  const values  = sheet.getDataRange().getValues();
  return { values, headers: values[0] };
}

/* ============================================
   DIAGNOSTIC
   GAS_URL?action=testFCM&token=getgorgeous_2026
   ============================================ */

function testFCMDiagnostic() {
  const result = { steps: {}, errors: [] };

  // Step 1: Script Properties
  try {
    const props = PropertiesService.getScriptProperties();
    const pid   = props.getProperty('FCM_PROJECT_ID');
    const email = props.getProperty('FCM_CLIENT_EMAIL');
    const key   = props.getProperty('FCM_PRIVATE_KEY');
    result.steps.scriptProperties = {
      FCM_PROJECT_ID:   pid   ? '✅ ' + pid   : '❌ MISSING',
      FCM_CLIENT_EMAIL: email ? '✅ set'       : '❌ MISSING',
      FCM_PRIVATE_KEY:  key   ? '✅ set'       : '❌ MISSING',
    };
    if (!pid || !email || !key) result.errors.push('Script Properties missing');
  } catch (e) { result.errors.push('Props error: ' + e); }

  // Step 2: Users table
  try {
    const sheet = _getUsersSheet();
    if (!sheet) {
      result.steps.usersTable = '❌ users tab missing ya empty — Sheet mein banao';
      result.errors.push('users tab nahi mili');
    } else {
      const { values, headers } = _readSheet(sheet);
      const tokIdx = headers.indexOf('fcmTokens');
      const roleIdx = headers.indexOf('role');
      result.steps.usersTable = values.slice(1).map((row, i) => ({
        row: i + 2,
        role: row[roleIdx] || '?',
        tokens: (() => {
          try { return JSON.parse(row[tokIdx] || '[]').length + ' token(s)'; }
          catch { return '0 token(s)'; }
        })(),
      }));
    }
  } catch (e) { result.errors.push('Users check error: ' + e); }

  // Step 3: FCM auth
  try {
    getFCMAccessToken();
    result.steps.fcmAuth = '✅ Access token mila';
  } catch (e) {
    result.steps.fcmAuth = '❌ FAILED: ' + e;
    result.errors.push('FCM auth fail: ' + e);
  }

  // Step 4: Send test notification to all owner tokens
  result.steps.testSend = [];
  if (!result.errors.some(e => e.includes('FCM auth'))) {
    try {
      const sheet = _getUsersSheet();
      if (sheet) {
        let token = null;
        try { token = getFCMAccessToken(); } catch (e) { }
        const { values, headers } = _readSheet(sheet);
        const tokIdx  = headers.indexOf('fcmTokens');
        const roleIdx = headers.indexOf('role');
        for (let i = 1; i < values.length; i++) {
          if (String(values[i][roleIdx] || '').toLowerCase() !== 'owner') continue;
          let tokens = [];
          try { tokens = JSON.parse(values[i][tokIdx] || '[]'); } catch { }
          for (const t of tokens) {
            try {
              sendFCMMessage(token, t, '🧪 Test', 'FCM kaam kar raha hai!', 'bill', './home.html');
              result.steps.testSend.push('✅ sent: ' + t.slice(0, 20) + '…');
            } catch (e) {
              result.steps.testSend.push('❌ fail: ' + e);
            }
          }
        }
        if (!result.steps.testSend.length) result.steps.testSend.push('⚠️ Koi owner token nahi mila — login karo aur push enable karo');
      }
    } catch (e) { result.steps.testSend.push('❌ ' + e); }
  }

  result.summary = result.errors.length
    ? '❌ ' + result.errors.join(' | ')
    : '✅ Sab theek — phone pe notification check karo';

  return result;
}
