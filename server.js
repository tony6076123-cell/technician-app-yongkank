// 🦞 技師業績 App - 獨立部署版
// 只做技師業績查詢 + 自己信箱的報表自動掃描，不含龍蝦管家、LINE推播等既有海小龍其他功能。
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { getValidFirebaseToken, readFirebase, saveToFirebase, seedTechniciansIfEmpty } = require('./lib.js');

const PORT = process.env.PORT || 3000;
const LOCATION = process.env.LOCATION || null; // 雲端部署設定：永康 或 歸仁，開機時空集合會自動建名單

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // 🦞 不要讓瀏覽器快取頁面/資料：否則我改好程式後，員工手機還是看到舊版（曾害輪胎顯示成加總的舊算法）。
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // 🦞 App 入口主選單（測試版）：三大功能一頁選
  if (u.pathname === '/') {
    try {
      const html = fs.readFileSync(path.join(__dirname, '首頁.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) { res.writeHead(404); res.end('找不到頁面'); }
    return;
  }

  if (u.pathname === '/tech') {
    try {
      const html = fs.readFileSync(path.join(__dirname, '技師業績.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) { res.writeHead(404); res.end('找不到頁面'); }
    return;
  }

  // 🦞 月度檢討（每人本期 vs 上月同期 vs 去年同期＋不足項目與改善施策）
  if (u.pathname === '/review') {
    try {
      const html = fs.readFileSync(path.join(__dirname, '月度檢討.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) { res.writeHead(404); res.end('找不到頁面'); }
    return;
  }

  // 🦞 老闆版全員總覽儀表板（全員排行榜一頁看完，不用逐人點選）
  if (u.pathname === '/board') {
    try {
      const html = fs.readFileSync(path.join(__dirname, '業績總覽.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) { res.writeHead(404); res.end('找不到頁面'); }
    return;
  }

  // 🦞 2026-10-09 新增：報表頁（週卡／月卡／年卡＋對比分析＋優缺項＋改善施策）
  if (u.pathname === '/report') {
    try {
      const html = fs.readFileSync(path.join(__dirname, '報表.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) { res.writeHead(404); res.end('找不到頁面'); }
    return;
  }
  if (u.pathname === '/api/report-data') {
    try {
      const loc = u.query.loc === '歸仁' ? '歸仁' : '永康';
      const data = await require('./report-data.js').buildReport(loc);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (u.pathname === '/api/tech-login' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { code } = JSON.parse(body || '{}');  // 🦞 測試期先不驗密碼，只認工號
        const list = await readFirebase('technicians');
        const user = list.find(t => t._id === code);
        if (!user || !user.active) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '工號錯誤，或帳號尚未啟用' }));
          return;
        }
        const { password: _pw, ...safe } = user;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, user: safe }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (u.pathname === '/api/my-performance') {
    try {
      const code = u.query.code;
      const list = await readFirebase('technicians');
      const user = list.find(t => t._id === code);
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '工號錯誤，請重新登入' }));
        return;
      }
      // 🦞 2026-10-10 加兩個 collection：接待的零件明細與延長保固件數，讓接待也有跟技師一樣的下鑽。
      //    🔴 recpParts 跟 parts 是同一批工單的兩種視角，**前端絕不可相加**（相加＝輪胎算兩次）。
      const [perf, parts, recpParts, warranty, targets] = await Promise.all([
        readFirebase('technician_performance'),
        readFirebase('technician_parts_summary'),
        readFirebase('receptionist_parts_summary').catch(() => []),
        readFirebase('warranty_sales').catch(() => []),
        readFirebase('monthly_targets'),
      ]);
      const isManager = user.level === 'manager';
      const myPerf = isManager ? perf : perf.filter(p => p.employee === user.name);
      const myParts = isManager ? parts : parts.filter(p => p.employee === user.name);
      const myRecpParts = isManager ? recpParts : recpParts.filter(p => p.employee === user.name);
      const myWarranty = isManager ? warranty : warranty.filter(p => p.employee === user.name);
      // 🦞 回傳全部月目標，讓前端依「顯示月份」自己挑（月初當月還沒資料時前端會退回最近有資料的月份；
      //    若這裡先用當月過濾，會把該顯示月份的目標濾掉，導致達成率顯示未設定）
      const myTargets = isManager
        ? targets
        : targets.filter(t => t._id.startsWith(`${user.location}_`));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, level: user.level, user: { name: user.name, location: user.location, dept: user.dept, role: user.role }, performance: myPerf, parts: myParts, recpParts: myRecpParts, warranty: myWarranty, targets: myTargets }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (u.pathname === '/api/set-target' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { code, location, month, target_amt } = JSON.parse(body || '{}');
        const list = await readFirebase('technicians');
        const user = list.find(t => t._id === code);
        if (!user || user.level !== 'manager') {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '只有管理層能設定目標' }));
          return;
        }
        const token = await getValidFirebaseToken();
        const ok = await saveToFirebase(token, {
          id: `${location}_${month}`, location, month, target_amt: Number(target_amt) || 0,
          set_by: user.name, set_at: new Date().toISOString(), _collection: 'monthly_targets'
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 手動/排程觸發一次信箱掃描（每天早上9點由 GitHub Actions 呼叫）
  if (u.pathname === '/api/sync-now' && req.method === 'POST') {
    try {
      const result = await require('./gmail-sync.js').syncOnce();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, async () => {
  console.log(`🔧 技師業績 App 啟動：http://localhost:${PORT}`);
  // 🦞 雲端部署（設了 LOCATION 環境變數）：開機時如果 technicians 是空的，自動建立名單，
  //    廠長不用手動跑 seed-technicians.js（雲端平台沒有終端機可以打指令）
  if (LOCATION) {
    try {
      const r = await seedTechniciansIfEmpty(LOCATION);
      console.log(r.skipped ? `👥 名單建立略過：${r.reason}` : `👥 已自動建立 ${r.written}/${r.total} 筆人員名單`);
    } catch (e) {
      console.log(`❌ 自動建立名單失敗: ${e.message}`);
    }
  }
  // 🦞 2026-08-09重新啟用內建定時同步：每2小時自己抓一次信箱（開機也先補抓一次），
  //    配合keepalive讓伺服器白天不睡，就不必只靠GitHub排程（會延遲/塞車、常漏抓）。
  //    早上寄的報表最慢2小時內會自己進來，不用再手動觸發。/api/sync-now 仍可隨時手動補抓。
  try {
    require('./gmail-sync.js').startGmailSyncLoop();
    console.log('📧 信箱掃描：內建每2小時自動掃 + 開機補抓（不再只靠GitHub 09:00）');
  } catch (e) {
    console.log(`❌ 啟動內建同步迴圈失敗: ${e.message}`);
  }
});
