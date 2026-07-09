// 🦞 共用邏輯：Firestore讀寫 + 205/1G0_1報表解析
// server.js（網頁伺服器）跟 gmail-sync.js（信箱掃描）都從這裡引用，避免兩邊各寫一份會兜不起來。
const fs = require('fs');
const https = require('https');
const path = require('path');
const { google } = require('googleapis');

let XLSX = null;
try { XLSX = require('xlsx'); } catch (e) { console.log('⚠️ xlsx 套件未安裝'); }

// 🦞 不寫死特定專案：FIREBASE_PROJECT 直接從金鑰檔的 project_id 欄位讀出來，
// 誰的金鑰就連誰的Firebase專案，各廠各自獨立、互不相通，不用額外設定步驟。
const KEY_FILE = path.join(__dirname, 'firebase-key.json');
let FIREBASE_PROJECT = process.env.FIREBASE_PROJECT || null;

let _cachedToken = null, _cachedTokenTime = 0;
async function getValidFirebaseToken() {
  if (_cachedToken && (Date.now() - _cachedTokenTime) < 50 * 60 * 1000) return _cachedToken;
  let raw;
  if (fs.existsSync(KEY_FILE)) raw = fs.readFileSync(KEY_FILE, 'utf8');
  else raw = process.env.FIREBASE_KEY_JSON;
  if (!raw) throw new Error('找不到 Firebase 金鑰：把金鑰檔存成同資料夾的 firebase-key.json');
  const key = JSON.parse(raw);
  if (!FIREBASE_PROJECT) {
    if (!key.project_id) throw new Error('金鑰檔裡沒有 project_id 欄位，金鑰檔可能不完整');
    FIREBASE_PROJECT = key.project_id;
    console.log(`🔑 使用 Firebase 專案：${FIREBASE_PROJECT}`);
  }
  const auth = new google.auth.GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/datastore'] });
  const r = await auth.getAccessToken();
  const tk = typeof r === 'string' ? r : (r.token || r);
  if (!tk) throw new Error('Firebase 金鑰無法取得 access token');
  _cachedToken = tk; _cachedTokenTime = Date.now();
  return tk;
}
function getProjectId(){ return FIREBASE_PROJECT; }

function readFirebasePage(token, collection, pageToken) {
  return new Promise((resolve, reject) => {
    let p = `/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}?pageSize=300`;
    if (pageToken) p += `&pageToken=${encodeURIComponent(pageToken)}`;
    const opts = { hostname: 'firestore.googleapis.com', path: p, method: 'GET', headers: { 'Authorization': `Bearer ${token}` } };
    const req = https.request(opts, (res) => {
      res.setEncoding('utf8'); let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

async function readFirebase(collection) {
  const token = await getValidFirebaseToken();
  let allDocs = [], pageToken;
  do {
    const j = await readFirebasePage(token, collection, pageToken);
    allDocs = allDocs.concat(j.documents || []);
    pageToken = j.nextPageToken;
  } while (pageToken);
  return allDocs.map(d => {
    const obj = { _id: d.name.split('/').pop() };
    for (const [k, v] of Object.entries(d.fields || {})) {
      if (v.integerValue !== undefined) obj[k] = Number(v.integerValue);
      else if (v.doubleValue !== undefined) obj[k] = Number(v.doubleValue);
      else if (v.stringValue !== undefined) obj[k] = v.stringValue;
      else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
      else obj[k] = null;
    }
    return obj;
  });
}

function saveToFirebase(token, data) {
  const collection = data._collection || 'technicians';
  const { id, _collection, ...fields } = data;
  const body = { fields: {} };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'number') body.fields[k] = Number.isInteger(v) ? { integerValue: v } : { doubleValue: v };
    else if (v !== null && v !== undefined) body.fields[k] = { stringValue: String(v) };
  }
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve) => {
    const opts = {
      hostname: 'firestore.googleapis.com',
      path: `/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${collection}/${encodeURIComponent(id)}?updateMask.fieldPaths=${Object.keys(fields).join('&updateMask.fieldPaths=')}`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Content-Length': Buffer.byteLength(bodyStr) }
    };
    const req = https.request(opts, (res) => {
      let resp = ''; res.on('data', d => resp += d);
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.write(bodyStr); req.end();
  });
}

// ===== 205/1G0_1 報表解析（跟主專案 gmail-fetch.js 同一套邏輯，複製過來維持獨立） =====
const _num = v => { if (v == null || v === '') return 0; const n = parseFloat(String(v).replace(/[^\d.-]/g, '')); return isNaN(n) ? 0 : Math.round(n); };

function detectReportType(buf) {
  if (!XLSX) return null;
  try {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const title = (rows[0] && rows[0][0] || '').toString();
    if (title.includes('1G0')) return '1G0';
    if (title.includes('205')) return '205';
  } catch (e) {}
  return null;
}

function parse205Buffer(buf, filename) {
  if (!XLSX) return [];
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer' }); } catch (e) { return []; }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  let location = '';
  const locRaw = (rows[2] && rows[2][2] || '').toString();
  if (locRaw.includes('永康')) location = '永康';
  else if (locRaw.includes('歸仁')) location = '歸仁';
  if (!location) {
    if (/永康/.test(filename)) location = '永康';
    else if (/歸仁/.test(filename)) location = '歸仁';
  }
  if (!location) return [];

  let period_start = '', period_end = '';
  const periodRaw = (rows[5] && rows[5][2] || '').toString();
  const pm = periodRaw.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
  if (pm) { period_start = pm[1]; period_end = pm[2]; }
  if (!period_end) return [];

  const empTypeRaw = (rows[8] && rows[8][2] || '').toString();
  const role = empTypeRaw.includes('服務專員') ? '接待' : empTypeRaw.includes('承修技師') ? '技師' : '';
  if (!role) return [];

  const sepIdx = rows.findIndex(r => r[0] === '======');
  if (sepIdx < 0) return [];
  const header = rows[sepIdx + 2] || [];
  const isAggregated = header.includes('工單數') && header.includes('車輛數');
  const isDetail = header.includes('工單號碼') && header.includes('入帳日期');
  if (!isAggregated && !isDetail) return [];

  const subHeader = rows[sepIdx + 1] || [];
  const moneyIdx = [];
  header.forEach((h, i) => { if (h === '金額') moneyIdx.push(i); });
  const catLabels = [];
  subHeader.forEach(s => { const t = (s || '').toString().trim(); if (t) catLabels.push(t); });
  const catIdx = {};
  catLabels.forEach((lab, k) => { if (moneyIdx[k] !== undefined) catIdx[lab] = moneyIdx[k]; });

  const out = [];
  if (isAggregated) {
    const idx = {
      dept: header.indexOf('部門'), emp: header.indexOf('員工'),
      orders: header.indexOf('工單數'), cars: header.indexOf('車輛數'), hr: header.indexOf('Hr'),
      untaxed: header.indexOf('未稅金額'), total: header.indexOf('總金額'),
    };
    for (let i = sepIdx + 3; i < rows.length; i++) {
      const r = rows[i] || [];
      const emp = (r[idx.emp] || '').toString().trim();
      if (!emp) continue;
      out.push({
        location, role, period_start, period_end,
        dept: (r[idx.dept] || '').toString(),
        employee: emp,
        order_count: _num(r[idx.orders]),
        car_count: _num(r[idx.cars]),
        hours: parseFloat(r[idx.hr]) || 0,
        labor_amt: _num(r[catIdx['工資']]),
        parts_amt: _num(r[catIdx['零件']]),
        outsourced_amt: _num(r[catIdx['外修']]),
        untaxed_amt: _num(r[idx.untaxed]),
        total_amt: _num(r[idx.total]),
        source_format: 'aggregated',
        id: `${location}_${role}_${emp}_${period_end}`,
        _collection: 'technician_performance'
      });
    }
  } else {
    const idx = {
      dept: header.indexOf('部門'), emp: header.indexOf('員工'),
      orderNo: header.indexOf('工單號碼'), plate: header.indexOf('牌照號碼'), hr: header.indexOf('Hr'),
      untaxed: header.indexOf('未稅金額'), total: header.indexOf('總金額'),
    };
    const agg = new Map();
    for (let i = sepIdx + 3; i < rows.length; i++) {
      const r = rows[i] || [];
      const emp = (r[idx.emp] || '').toString().trim();
      if (!emp) continue;
      if (!agg.has(emp)) agg.set(emp, { dept: (r[idx.dept] || '').toString(), orders: new Set(), cars: new Set(), hours: 0, labor: 0, parts: 0, outsourced: 0, untaxed: 0, total: 0 });
      const a = agg.get(emp);
      const orderNo = (r[idx.orderNo] || '').toString();
      if (orderNo) a.orders.add(orderNo);
      const plate = (r[idx.plate] || '').toString();
      if (plate) a.cars.add(plate);
      a.hours += parseFloat(r[idx.hr]) || 0;
      a.labor += _num(r[catIdx['工資']]);
      a.parts += _num(r[catIdx['零件']]);
      a.outsourced += _num(r[catIdx['外修']]);
      a.untaxed += _num(r[idx.untaxed]);
      a.total += _num(r[idx.total]);
    }
    for (const [emp, a] of agg) {
      out.push({
        location, role, period_start, period_end,
        dept: a.dept, employee: emp,
        order_count: a.orders.size,
        car_count: a.cars.size,
        hours: Math.round(a.hours * 10) / 10,
        labor_amt: a.labor,
        parts_amt: a.parts,
        outsourced_amt: a.outsourced,
        untaxed_amt: a.untaxed,
        total_amt: a.total,
        source_format: 'detail_aggregated',
        id: `${location}_${role}_${emp}_${period_end}`,
        _collection: 'technician_performance'
      });
    }
  }
  return out;
}

function parse1G0_1Buffer(buf, filename) {
  if (!XLSX) return [];
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer' }); } catch (e) { return []; }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  let location = '';
  const locRaw = (rows[2] && rows[2][2] || '').toString();
  if (locRaw.includes('永康')) location = '永康';
  else if (locRaw.includes('歸仁')) location = '歸仁';
  if (!location) {
    if (/永康/.test(filename)) location = '永康';
    else if (/歸仁/.test(filename)) location = '歸仁';
  }
  if (!location) return [];

  const empTypeRaw = (rows[4] && rows[4][2] || '').toString();
  if (!empTypeRaw.includes('承修技師')) return [];

  let period_end = '';
  const periodRaw = (rows[3] && rows[3][2] || '').toString();
  const pm = periodRaw.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
  if (pm) period_end = pm[2];
  if (!period_end) return [];

  const sepIdx = rows.findIndex(r => r[0] === '======');
  if (sepIdx < 0) return [];
  const header = rows[sepIdx + 2] || [];
  const idx = {
    tech: header.indexOf('承修技師'), cat: header.indexOf('類別'),
    partNo: header.indexOf('項目'), desc: header.indexOf('說明'),
    qty: header.indexOf('數量'), amt: header.indexOf('金額'),
  };
  if (idx.tech < 0 || idx.amt < 0) return [];

  const agg = new Map();
  for (let i = sepIdx + 3; i < rows.length; i++) {
    const r = rows[i] || [];
    const techRaw = (r[idx.tech] || '').toString().trim();
    if (!techRaw) continue;
    const m = techRaw.match(/^(.+?)\((\w+)\)$/);
    const tech = m ? m[1].trim() : techRaw;
    const techCode = m ? m[2] : '';
    if (!agg.has(tech)) agg.set(tech, { tire_units: 0, tire_amt: 0, battery_units: 0, battery_amt: 0, chemical_units: 0, chemical_amt: 0, labor_amt: 0, parts_total_amt: 0, items: new Map(), employee_code: techCode });
    const a = agg.get(tech);
    const cat = (r[idx.cat] || '').toString();
    const qty = _num(r[idx.qty]);
    const amt = _num(r[idx.amt]);
    if (cat === '工資') { a.labor_amt += amt; continue; }
    if (cat !== '零件') continue;
    const partNo = (r[idx.partNo] || '').toString().trim();
    const desc = (r[idx.desc] || '').toString();

    const itemKey = partNo + '|' + desc;
    if (!a.items.has(itemKey)) a.items.set(itemKey, { partNo, desc, qty: 0, amt: 0 });
    const item = a.items.get(itemKey);
    item.qty += qty; item.amt += amt;
    a.parts_total_amt += amt;

    let pcat = '';
    if (desc.includes('輪胎')) pcat = 'tire';
    else if (desc.includes('電瓶')) pcat = 'battery';
    else if (partNo.startsWith('08C')) pcat = 'chemical';
    else continue;
    if (pcat === 'tire') { a.tire_units += qty; a.tire_amt += amt; }
    else if (pcat === 'battery') { a.battery_units += qty; a.battery_amt += amt; }
    else { a.chemical_units += qty; a.chemical_amt += amt; }
  }

  const out = [];
  for (const [tech, a] of agg) {
    const items = [...a.items.values()].sort((x, y) => y.amt - x.amt);
    const { items: _drop, ...rest } = a;
    out.push({
      location, employee: tech, period_end,
      ...rest,
      items_json: JSON.stringify(items),
      id: `${location}_技師_${tech}_${period_end}_parts`,
      _collection: 'technician_parts_summary'
    });
  }
  return out;
}

// 🦞 種子邏輯：把 roster.json 裡「這一廠」的人員名單寫進 technicians，
// 本機版透過 seed-technicians.js 手動跑；雲端版由 server.js 開機時自動偵測空集合觸發，兩邊共用同一份邏輯。
function buildSeedDocs(location) {
  const rosterPath = path.join(__dirname, 'roster.json');
  if (!fs.existsSync(rosterPath)) return null;
  const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8')).filter(r => r.location.includes(location));
  const staffDocs = roster.map(r => {
    const code = r.code || '';
    const id = code || `TEMP_${r.name}`;
    return {
      id, name: r.name, location, dept: r.dept.join('/'), role: r.role.join('/'), title: r.title || '',
      level: 'staff', password: code || id, needs_code: code ? 0 : 1, active: 1,
      _collection: 'technicians'
    };
  });
  const managerDoc = {
    id: 'manager', name: `(待補)${location}廠長`, location, dept: '', role: '廠長', title: '廠長',
    level: 'manager', password: 'manager', needs_code: 0, active: 0,
    _collection: 'technicians'
  };
  return [...staffDocs, managerDoc];
}

async function seedTechniciansIfEmpty(location) {
  if (!location) return { skipped: true, reason: 'no LOCATION set' };
  const existing = await readFirebase('technicians');
  if (existing.length > 0) return { skipped: true, reason: 'technicians already has data', count: existing.length };
  const docs = buildSeedDocs(location);
  if (!docs) return { skipped: true, reason: 'roster.json not found' };
  const token = await getValidFirebaseToken();
  let ok = 0;
  for (const d of docs) { if (await saveToFirebase(token, d)) ok++; }
  return { skipped: false, written: ok, total: docs.length };
}

module.exports = { getValidFirebaseToken, readFirebase, saveToFirebase, detectReportType, parse205Buffer, parse1G0_1Buffer, getProjectId, buildSeedDocs, seedTechniciansIfEmpty };
