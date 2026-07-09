// 🦞 掃描這台電腦負責人（廠長）自己的 Gmail，抓205/1G0_1報表附件，解析後寫進共用的 Firestore。
// 第一次執行會跳出瀏覽器要求登入Google帳號授權（廠長登入自己的Gmail），之後就記住不用再登入。
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { authenticate } = require('./gmail-auth.js');
const { getValidFirebaseToken, saveToFirebase, detectReportType, parse205Buffer, parse1G0_1Buffer } = require('./lib.js');

const SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2小時，跟主專案 scheduledScanCron 同頻率
const GMAIL_QUERY = 'subject:(業績 OR 日報 OR KPI OR 報表 OR 1G0 OR 銷售獎金 OR 零件) newer_than:7d';

function decodeAttachmentData(raw) {
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function syncOnce() {
  console.log(`\n📧 [${new Date().toLocaleString('zh-TW')}] 開始掃描 Gmail...`);
  let auth;
  try {
    auth = await authenticate(true); // 第一次執行會開瀏覽器要求登入自己的Google帳號
  } catch (e) {
    console.log('❌ Gmail 授權失敗:', e.message);
    return { scanned: 0, written: 0, error: e.message };
  }
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({ userId: 'me', q: GMAIL_QUERY, maxResults: 30 });
  const messages = res.data.messages || [];
  console.log(`📧 找到 ${messages.length} 封符合條件的信`);

  const token = await getValidFirebaseToken();
  let written = 0;

  for (const msg of messages) {
    const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
    const atts = [];
    (function findAtt(part) {
      if (part.filename && part.body && part.body.attachmentId) {
        if (part.filename.match(/\.(xlsx|xls)$/i)) atts.push({ filename: part.filename, attachmentId: part.body.attachmentId });
      }
      if (part.parts) part.parts.forEach(findAtt);
    })(full.data.payload);

    for (const a of atts) {
      try {
        const attData = await gmail.users.messages.attachments.get({ userId: 'me', messageId: msg.id, id: a.attachmentId });
        const buf = decodeAttachmentData(attData.data.data);
        const type = detectReportType(buf);  // 讀檔案內容判斷，不信檔名（見規則：檔名常有錯字/誤判)
        let docs = [];
        if (type === '205') docs = parse205Buffer(buf, a.filename);
        else if (type === '1G0') docs = parse1G0_1Buffer(buf, a.filename);
        if (!docs.length) { console.log(`  ⏭️  ${a.filename}（非205/1G0報表或解析不到資料，略過）`); continue; }
        for (const d of docs) {
          const ok = await saveToFirebase(token, d);
          if (ok) written++;
        }
        console.log(`  ✅ ${a.filename} → ${docs.length} 筆`);
      } catch (e) {
        console.log(`  ❌ ${a.filename} 處理失敗: ${e.message}`);
      }
    }
  }
  console.log(`📧 掃描完成，共寫入 ${written} 筆資料\n`);
  return { scanned: messages.length, written };
}

function startGmailSyncLoop() {
  syncOnce().catch(e => console.log('❌ 初次掃描失敗:', e.message));
  setInterval(() => { syncOnce().catch(e => console.log('❌ 掃描失敗:', e.message)); }, SYNC_INTERVAL_MS);
  console.log(`📧 已排程：每2小時自動掃描一次信箱`);
}

module.exports = { syncOnce, startGmailSyncLoop };

if (require.main === module) {
  syncOnce().then(r => { console.log('完成:', r); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
}
