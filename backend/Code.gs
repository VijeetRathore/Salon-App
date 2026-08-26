/* ============================================
   Code.gs — Get Gorgeous backend (Google Apps Script)

   CHANGES IN THIS VERSION:
   - pullSince: incremental pull (sirf naye records)
   - sendSyncPing: push ke baad baaki devices ko silent FCM ping
   - Bill notification: nayi bill pe master device ko push
   - FCM URL fix: data.url se correct page open hota hai

   SCRIPT PROPERTIES (Project Settings → Script Properties):
     FCM_PROJECT_ID   → Firebase project ID
     FCM_CLIENT_EMAIL → service account client_email
     FCM_PRIVATE_KEY  → service account private_key (with \n)
   ============================================ */

const SECRET_TOKEN    = 'getgorgeous_2026';
const DRIVE_FOLDER_ID = '1kk44K2jR1gMl8gFYfgejDkPCuzEnCvtI';

const SHEET_NAMES = [
  'customers', 'appointments', 'services', 'bills', 'products',
  'purchases', 'stockTransactions', 'expenses', 'staff', 'attendance', 'pendingMessages', 'deviceTokens',
];

// Ye stores ka FULL data incremental pull mein bhi bhejte hain
// (taaki client deletions detect kar sake — Sheet = source of truth)
const DELETE_SYNC_STORES = [
  'customers', 'appointments', 'services', 'bills', 'products',
  'purchases', 'stockTransactions', 'expenses', 'staff',
  'attendance', 'pendingMessages', 'deviceTokens',
];

/* ============================================
   ROUTING
   ============================================ */

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== SECRET_TOKEN) {
      return jsonResponse({ ok: false, error: 'Invalid token' });
    }
    if (body.action === 'pushRecords') {
      return jsonResponse(pushRecords(body.storeName, body.records));
    }
    if (body.action === 'uploadPhoto') {
      return jsonResponse(uploadPhoto(body.dataUrl, body.fileName));
    }
    return jsonResponse({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    const token = e.parameter.token;
    if (token !== SECRET_TOKEN) return jsonResponse({ ok: false, error: 'Invalid token' });

    if (e.parameter.action === 'pullAll') {
      return jsonResponse(pullAll());
    }

    if (e.parameter.action === 'pullSince') {
      const since = e.parameter.since || null;
      return jsonResponse(pullSince(since));
    }

    if (e.parameter.action === 'sendSyncPing') {
      try { notifyAllDevicesSilent(); } catch (err) { /* FCM not configured — ignore */ }
      return jsonResponse({ ok: true });
    }

    // --- DIAGNOSTIC: browser se call karo, FCM pipeline check karo ---
    if (e.parameter.action === 'testFCM') {
      return jsonResponse(testFCMDiagnostic());
    }

    return jsonResponse({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

/* ============================================
   PUSH: upsert rows into sheet tabs
   ============================================ */

function pushRecords(storeName, records) {
  if (!SHEET_NAMES.includes(storeName)) return { ok: false, error: 'Unknown store: ' + storeName };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(storeName);
  if (!sheet) sheet = ss.insertSheet(storeName);

  records.forEach((record) => {
    const flat = flattenRecord(record);
    const headers = getOrCreateHeaders(sheet, flat);
    const rowIndex = findRowById(sheet, flat.id);
    const rowValues = headers.map((h) => (flat[h] !== undefined ? flat[h] : ''));

    if (rowIndex > 0) {
      sheet.getRange(rowIndex, 1, 1, headers.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }
  });

  logSync(storeName, records.length);

  if (storeName === 'pendingMessages') {
    const newPending = records.filter((r) => r.status === 'pending');
    if (newPending.length) {
      try {
        notifyMasterDevices(
          newPending.length,
          'whatsapp',
          'New WhatsApp Message to Send',
          `${newPending.length} bill/offer message(s) waiting in the WhatsApp Queue`,
          './whatsapp-queue.html'
        );
      } catch (err) { }
    }
  }

  if (storeName === 'bills' && records.length > 0) {
    try {
      const totalAmount = records.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
      const title = records.length === 1 ? 'New Bill Created' : `${records.length} Bills Created`;
      const body  = `Total: ₹${totalAmount.toLocaleString('en-IN')}`;
      notifyMasterDevices(records.length, 'bill', title, body, './billing.html');
    } catch (err) { }
  }

  return { ok: true, synced: records.length };
}

function flattenRecord(record) {
  const flat = {};
  Object.keys(record).forEach((k) => {
    const v = record[k];
    flat[k] = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v;
  });
  return flat;
}

function getOrCreateHeaders(sheet, sampleFlatRecord) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    const headers = Object.keys(sampleFlatRecord);
    sheet.appendRow(headers);
    return headers;
  }
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

function findRowById(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  const idx = ids.indexOf(id);
  return idx === -1 ? -1 : idx + 2;
}

/* ============================================
   PULL: full (pehli baar / restore)
   ============================================ */

function pullAll() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = {};
  SHEET_NAMES.forEach((name) => {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) { result[name] = []; return; }
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    result[name] = values.slice(1).map((row) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
  });
  return { ok: true, data: result, pulledAt: new Date().toISOString() };
}

/* ============================================
   PULL: incremental (normal background sync)
   DELETE_SYNC_STORES ke liye hamesha full data —
   baaki ke liye sirf since ke baad wale records
   ============================================ */

function pullSince(sinceIso) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = {};
  const sinceTime = sinceIso ? new Date(sinceIso).getTime() : 0;

  SHEET_NAMES.forEach((name) => {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 2) { result[name] = []; return; }

    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const allRows = values.slice(1).map((row) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });

    const needFull = !sinceTime || DELETE_SYNC_STORES.includes(name);
    result[name] = needFull
      ? allRows
      : allRows.filter((obj) => {
          const rowTime = obj.updatedAt ? new Date(obj.updatedAt).getTime() : 0;
          return rowTime > sinceTime;
        });
  });

  return { ok: true, data: result, pulledAt: new Date().toISOString() };
}

/* ============================================
   PHOTOS → Drive
   ============================================ */

function uploadPhoto(dataUrl, fileName) {
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const parts = dataUrl.split(',');
  const mime = parts[0].match(/data:(.*);base64/)[1];
  const bytes = Utilities.base64Decode(parts[1]);
  const blob = Utilities.newBlob(bytes, mime, fileName);
  const file = folder.createFile(blob);
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
   PUSH NOTIFICATIONS (Firebase Cloud Messaging)
   ============================================ */

function notifyMasterDevices(count, type, title, body, targetUrl) {
  const sheet = getDeviceTokenSheet();
  if (!sheet) return;

  const { values, headers } = getSheetData(sheet);
  const tokenIdx  = headers.indexOf('fcmToken');
  const masterIdx = headers.indexOf('isMaster');
  if (tokenIdx === -1 || masterIdx === -1) return;

  let accessToken = null;
  for (let i = 1; i < values.length; i++) {
    const row      = values[i];
    const isMaster = row[masterIdx] === true || row[masterIdx] === 'TRUE';
    const token    = String(row[tokenIdx] || '').trim();
    if (!isMaster || !token) continue;

    if (!accessToken) accessToken = getFCMAccessToken();
    try {
      sendFCMMessage(accessToken, token, title, body, type, targetUrl);
    } catch (err) { }
  }
}

function notifyAllDevicesSilent() {
  const sheet = getDeviceTokenSheet();
  if (!sheet) return;

  const { values, headers } = getSheetData(sheet);
  const tokenIdx = headers.indexOf('fcmToken');
  if (tokenIdx === -1) return;

  let accessToken = null;
  for (let i = 1; i < values.length; i++) {
    const token = String(values[i][tokenIdx] || '').trim();
    if (!token) continue;
    if (!accessToken) {
      try { accessToken = getFCMAccessToken(); } catch (err) { return; }
    }
    try {
      sendFCMMessage(accessToken, token, null, null, 'sync', null);
    } catch (err) { }
  }
}

function getDeviceTokenSheet() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('deviceTokens');
  if (!sheet || sheet.getLastRow() < 2) return null;
  return sheet;
}

function getSheetData(sheet) {
  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  return { values, headers };
}

function sendFCMMessage(accessToken, fcmToken, title, body, type, targetUrl) {
  const projectId = PropertiesService.getScriptProperties().getProperty('FCM_PROJECT_ID');

  const messagePayload = {
    token: fcmToken,
    data: {
      type: type      || 'general',
      url:  targetUrl || './home.html',
    },
  };

  if (title && body) {
    messagePayload.notification = { title, body };
    messagePayload.webpush = {
      notification: { icon: '/assets/icons/icon-192.png' },
    };
  }

  UrlFetchApp.fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method:      'post',
    contentType: 'application/json',
    headers:     { Authorization: 'Bearer ' + accessToken },
    payload:     JSON.stringify({ message: messagePayload }),
    muteHttpExceptions: true,
  });
}

/* ============================================
   DIAGNOSTIC — FCM pipeline test
   Browser se call karo:
   GAS_URL?action=testFCM&token=getgorgeous_2026
   ============================================ */
function testFCMDiagnostic() {
  const result = {
    step1_scriptProperties: {},
    step2_deviceTokens: [],
    step3_accessToken: null,
    step4_fcmSend: [],
    errors: [],
  };

  // Step 1: Script Properties check
  try {
    const props = PropertiesService.getScriptProperties();
    const projectId   = props.getProperty('FCM_PROJECT_ID');
    const clientEmail = props.getProperty('FCM_CLIENT_EMAIL');
    const privateKey  = props.getProperty('FCM_PRIVATE_KEY');
    result.step1_scriptProperties = {
      FCM_PROJECT_ID:   projectId   ? '✅ set (' + projectId + ')' : '❌ MISSING',
      FCM_CLIENT_EMAIL: clientEmail ? '✅ set'                     : '❌ MISSING',
      FCM_PRIVATE_KEY:  privateKey  ? '✅ set'                     : '❌ MISSING',
    };
    if (!projectId || !clientEmail || !privateKey) {
      result.errors.push('Script Properties set nahi hain — GAS → Project Settings → Script Properties mein daalo');
    }
  } catch (err) {
    result.errors.push('Script Properties read error: ' + err);
  }

  // Step 2: deviceTokens sheet check
  try {
    const sheet = getDeviceTokenSheet();
    if (!sheet) {
      result.step2_deviceTokens = '❌ deviceTokens sheet empty ya exist nahi karti';
      result.errors.push('Koi device token nahi mila — Settings mein jaake Enable Push Notifications dabaao');
    } else {
      const { values, headers } = getSheetData(sheet);
      const tokenIdx  = headers.indexOf('fcmToken');
      const masterIdx = headers.indexOf('isMaster');
      const deviceIdx = headers.indexOf('deviceId');
      for (let i = 1; i < values.length; i++) {
        const row = values[i];
        result.step2_deviceTokens.push({
          deviceId: deviceIdx >= 0 ? String(row[deviceIdx] || '').substring(0, 12) + '...' : '?',
          isMaster: masterIdx >= 0 ? row[masterIdx] : '?',
          hasToken: tokenIdx >= 0 && String(row[tokenIdx] || '').length > 10,
          tokenPreview: tokenIdx >= 0 ? String(row[tokenIdx] || '').substring(0, 20) + '...' : '❌',
        });
      }
      if (result.step2_deviceTokens.length === 0) {
        result.errors.push('deviceTokens sheet mein koi row nahi — push enable karo');
      }
    }
  } catch (err) {
    result.errors.push('deviceTokens check error: ' + err);
  }

  // Step 3: Access token fetch
  try {
    result.step3_accessToken = getFCMAccessToken() ? '✅ access token mila' : '❌ null token';
  } catch (err) {
    result.step3_accessToken = '❌ FAILED: ' + String(err);
    result.errors.push('FCM Auth fail — service account credentials check karo: ' + String(err));
  }

  // Step 4: Test notification bhejo (sirf agar token mila)
  if (result.step3_accessToken && result.step3_accessToken.startsWith('✅')) {
    try {
      const sheet = getDeviceTokenSheet();
      if (sheet) {
        const { values, headers } = getSheetData(sheet);
        const tokenIdx = headers.indexOf('fcmToken');
        let accessToken = null;
        try { accessToken = getFCMAccessToken(); } catch (e) { }
        for (let i = 1; i < values.length; i++) {
          const token = String(values[i][tokenIdx] || '').trim();
          if (!token || !accessToken) continue;
          try {
            sendFCMMessage(accessToken, token, '🧪 Test Notification', 'FCM kaam kar raha hai!', 'bill', './home.html');
            result.step4_fcmSend.push('✅ sent to token: ' + token.substring(0, 20) + '...');
          } catch (err) {
            result.step4_fcmSend.push('❌ failed: ' + String(err));
            result.errors.push('FCM send fail: ' + String(err));
          }
        }
      }
    } catch (err) {
      result.step4_fcmSend.push('❌ error: ' + String(err));
    }
  } else {
    result.step4_fcmSend = ['⏭️ skipped — Step 3 fail tha'];
  }

  result.summary = result.errors.length === 0
    ? '✅ Sab theek lag raha hai — notification device pe check karo'
    : '❌ ' + result.errors.length + ' problem(s) mili: ' + result.errors.join(' | ');

  return result;
}

function getFCMAccessToken() {
  const props       = PropertiesService.getScriptProperties();
  const clientEmail = props.getProperty('FCM_CLIENT_EMAIL');
  const privateKey  = props.getProperty('FCM_PRIVATE_KEY').replace(/\\n/g, '\n');

  const header   = { alg: 'RS256', typ: 'JWT' };
  const now      = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss:   clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  };

  const base64url = (obj) => Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  const toSign    = base64url(header) + '.' + base64url(claimSet);
  const sigBytes  = Utilities.computeRsaSha256Signature(toSign, privateKey);
  const signature = Utilities.base64EncodeWebSafe(sigBytes).replace(/=+$/, '');
  const jwt       = toSign + '.' + signature;

  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method:      'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    },
    muteHttpExceptions: true,
  });

  const json = JSON.parse(response.getContentText());
  if (!json.access_token) throw new Error('FCM auth failed: ' + response.getContentText());
  return json.access_token;
}
