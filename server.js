// 🦞 技師業績 App - 獨立部署版
// 只做技師業績查詢 + 自己信箱的報表自動掃描，不含龍蝦管家、LINE推播等既有海小龍其他功能。
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { getValidFirebaseToken, readFirebase, saveToFirebase, seedTechniciansIfEmpty } = require('./lib.js');
const { startGmailSyncLoop } = require('./gmail-sync.js');

const PORT = process.env.PORT || 3000;
const LOCATION = process.env.LOCATION || null; // 雲端部署設定：永康 或 歸仁，開機時空集合會自動建名單

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
      const [perf, parts, targets] = await Promise.all([
        readFirebase('technician_performance'), readFirebase('technician_parts_summary'), readFirebase('monthly_targets')
      ]);
      const isManager = user.level === 'manager';
      const myPerf = isManager ? perf : perf.filter(p => p.employee === user.name);
      const myParts = isManager ? parts : parts.filter(p => p.employee === user.name);
      const curMonth = new Date().toISOString().slice(0, 7);
      const myTargets = isManager
        ? targets.filter(t => t._id.endsWith('_' + curMonth))
        : targets.filter(t => t._id === `${user.location}_${curMonth}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, level: user.level, user: { name: user.name, location: user.location, dept: user.dept, role: user.role }, performance: myPerf, parts: myParts, targets: myTargets }));
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

  // 手動觸發一次信箱掃描（測試用，正常情況每2小時會自動跑）
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
  // 🦞 啟動時先掃一次，之後每2小時自動掃一次自己的Gmail
  startGmailSyncLoop();
});
