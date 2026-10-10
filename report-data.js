// 🦞 報表頁資料引擎：週卡／月卡／年卡 + 對比分析 + 優缺項 + 改善施策
// 口徑鐵律（跟週報卡、海小龍一致，改動前先看這段）：
//   1. technician_performance 是「當月1號～結算日」的累計快照 → 每月取最後一份，**絕不加總**。
//   2. 只用「技師視角」當全廠業績（技師 view 總額＝接待 view 總額，兩者相加會變兩倍）。
//   3. 台數排除噴漆組（同一台車鈑金→噴漆會重複計）。
//   4. 週業績＝兩個快照相減（本週末快照 − 上週末快照），不是把每天加起來。
//   5. 月底推估用「營業日」外推（週日公休），不可乘日曆天。
//   6. 進行中的月份標「進行中」，不跟完整月份比高低。
const { readFirebase } = require('./lib.js');

const REST_DOW = 0;                       // 週日公休
const isPaint = d => (d || '').includes('噴漆');
const grpOf = d => (d || '').includes('修護') ? 'eng'
  : ((d || '').includes('鈑金') || isPaint(d)) ? 'bp' : 'other';

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function bizDays(ym, untilDay) {
  const [y, m] = ym.split('-').map(Number);
  const last = untilDay || new Date(y, m, 0).getDate();
  let n = 0;
  for (let d = 1; d <= last; d++) if (new Date(y, m - 1, d).getDay() !== REST_DOW) n++;
  return n;
}
const shiftYM = (ym, k) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + k, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
};

// 某廠某月的所有快照日（由小到大）
function snapDays(perf, loc, ym) {
  return [...new Set(perf.filter(p => p.location === loc && p.role === '技師'
    && (p.period_end || '').startsWith(ym)).map(p => p.period_end))].sort();
}
// 指定結算日那一份快照的彙總
function snapSum(perf, loc, day) {
  const rows = perf.filter(p => p.location === loc && p.role === '技師' && p.period_end === day);
  const s = { day, amt: 0, labor: 0, parts: 0, cars: 0, orders: 0, eng: 0, bp: 0, engCars: 0, bpCars: 0, people: rows.length };
  rows.forEach(r => {
    const amt = r.untaxed_amt || 0, car = r.car_count || 0, g = grpOf(r.dept);
    s.amt += amt; s.labor += r.labor_amt || 0; s.parts += r.parts_amt || 0; s.orders += r.order_count || 0;
    if (g === 'eng' || g === 'bp') s[g] += amt;
    if (!isPaint(r.dept)) {
      s.cars += car;
      if (g === 'eng') s.engCars += car;
      if (g === 'bp') s.bpCars += car;
    }
  });
  return s;
}
function partsSum(parts, loc, ym, collection) {
  const rows = parts.filter(p => p.location === loc && (p.period_end || '').startsWith(ym));
  if (!rows.length) return null;
  const byEmp = new Map();
  rows.forEach(r => { const c = byEmp.get(r.employee); if (!c || r.period_end > c.period_end) byEmp.set(r.employee, r); });
  const t = { tire: 0, battery: 0, chemical: 0, people: [] };
  [...byEmp.values()].forEach(r => {
    t.tire += r.tire_units || 0; t.battery += r.battery_units || 0; t.chemical += r.chemical_units || 0;
    t.people.push({ name: r.employee, tire: r.tire_units || 0, battery: r.battery_units || 0, chemical: r.chemical_units || 0 });
  });
  t.people.sort((a, b) => b.tire - a.tire || b.chemical - a.chemical);
  t._collection = collection;
  return t;
}

// 延長保固販售（接待）：只看本月與上月同期，海哥 2026-10-09 指示「去年同期拿掉」
function warrantyOf(ew, loc, ym, untilDay) {
  const rows = ew.filter(r => r.location === loc && (r.period_start || '').startsWith(ym));
  if (!rows.length) return null;
  const cand = untilDay ? rows.filter(r => Number((r.period_end || '').slice(8, 10)) <= untilDay) : rows;
  const use = (cand.length ? cand : rows);
  const lastEnd = use.map(r => r.period_end).sort().pop();
  const snap = use.filter(r => r.period_end === lastEnd);
  return {
    period: snap[0].period_start + '～' + lastEnd,
    units: snap.reduce((a, r) => a + (r.warranty_units || 0), 0),
    amt: snap.reduce((a, r) => a + (r.warranty_amt || 0), 0),
    people: snap.map(r => ({ name: r.employee, units: r.warranty_units || 0, amt: r.warranty_amt || 0 }))
      .sort((a, b) => b.units - a.units),
  };
}

// 月卡：某廠某月
function monthCard(perf, parts, recp, targets, ew, loc, ym, today) {
  const days = snapDays(perf, loc, ym);
  if (!days.length) return null;
  const last = days[days.length - 1];
  const s = snapSum(perf, loc, last);
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const elapsedCal = Number(last.slice(8, 10));
  const 進行中 = ym === today.slice(0, 7);
  const totalWork = bizDays(ym);
  const elapsedWork = bizDays(ym, elapsedCal);
  const remainWork = Math.max(0, totalWork - elapsedWork);
  const perWorkDay = elapsedWork ? Math.round(s.amt / elapsedWork) : 0;
  const projected = 進行中 ? Math.round(s.amt + perWorkDay * remainWork) : s.amt;

  const t = targets.find(x => x._id === `${loc}_${ym}`) || {};
  const tgt = { amt: t.target_amt || 0, eng: t.target_amt_eng || 0, bp: t.target_amt_bp || 0,
                cars: t.target_cars || 0, carsEng: t.target_cars_eng || 0, carsBp: t.target_cars_bp || 0 };

  // 同期比：上月同一天、去年同一天（都取「≤那天」最近的快照，口徑才一致）
  const sameAt = (ym2) => {
    const d2 = snapDays(perf, loc, ym2).filter(d => Number(d.slice(8, 10)) <= elapsedCal);
    const pick = 進行中 ? (d2.length ? d2[d2.length - 1] : null)
                        : (snapDays(perf, loc, ym2).pop() || null);   // 已結束的月份比整月
    return pick ? snapSum(perf, loc, pick) : null;
  };
  return {
    ym, 進行中, lastDay: last, 快照數: days.length,
    daysInMonth, elapsedCal, totalWork, elapsedWork, remainWork, perWorkDay, projected,
    ...s, target: tgt,
    lastMonth: sameAt(shiftYM(ym, -1)),
    lastYear: sameAt(shiftYM(ym, -12)),
    warranty: warrantyOf(ew, loc, ym, elapsedCal),
    warrantyLastMonth: warrantyOf(ew, loc, shiftYM(ym, -1), elapsedCal),
    parts: partsSum(parts, loc, ym, 'tech'),
    recpParts: partsSum(recp, loc, ym, 'recp'),
  };
}

// 週卡：把當月的快照切成「週」（每週一為界），用兩份快照相減
function weekCards(perf, loc, ym) {
  const days = snapDays(perf, loc, ym);
  if (!days.length) return [];
  const [y, m] = ym.split('-').map(Number);
  const weekOf = d => {
    const dt = new Date(y, m - 1, Number(d.slice(8, 10)));
    const dow = (dt.getDay() + 6) % 7;                       // 週一=0
    const monday = new Date(dt); monday.setDate(dt.getDate() - dow);
    return monday.getMonth() + 1 + '/' + monday.getDate();
  };
  const lastOfWeek = new Map();
  days.forEach(d => lastOfWeek.set(weekOf(d), d));           // 每週取該週最後一份快照
  const out = [];
  let prev = null;
  for (const [wk, d] of lastOfWeek) {
    const cur = snapSum(perf, loc, d);
    out.push({
      週: wk + ' 當週', 截至: d,
      業績: cur.amt - (prev ? prev.amt : 0),
      台數: cur.cars - (prev ? prev.cars : 0),
      引電: cur.eng - (prev ? prev.eng : 0),
      鈑噴: cur.bp - (prev ? prev.bp : 0),
      累計: cur.amt,
    });
    prev = cur;
  }
  return out;
}

// 年卡：App 上線後逐月
function yearCard(perf, targets, loc, year, today) {
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, '0')}`;
    const days = snapDays(perf, loc, ym);
    if (!days.length) continue;
    const s = snapSum(perf, loc, days[days.length - 1]);
    const t = targets.find(x => x._id === `${loc}_${ym}`) || {};
    const lyDays = snapDays(perf, loc, shiftYM(ym, -12));
    const ly = lyDays.length ? snapSum(perf, loc, lyDays[lyDays.length - 1]) : null;
    months.push({ ym, 月: m + '月', 進行中: ym === today.slice(0, 7),
      業績: s.amt, 台數: s.cars, 引電: s.eng, 鈑噴: s.bp,
      目標: t.target_amt || 0, 去年: ly ? ly.amt : null, 截至: days[days.length - 1] });
  }
  const done = months.filter(x => !x.進行中);
  return {
    year, months,
    累計: done.reduce((a, x) => a + x.業績, 0),
    目標累計: done.reduce((a, x) => a + x.目標, 0),
    台數累計: done.reduce((a, x) => a + x.台數, 0),
    去年累計: done.every(x => x.去年 !== null) ? done.reduce((a, x) => a + x.去年, 0) : null,
    完整: months.length === 12 && !months.some(x => x.進行中),
    缺月: [...Array(12).keys()].map(i => i + 1).filter(m => !months.find(x => x.ym.endsWith('-' + String(m).padStart(2, '0')))),
  };
}

// 優缺項＋改善施策：全部規則式推算，數字講得出來源，不編現場的事
function analyse(mc) {
  const 優 = [], 缺 = [], 施策 = [];
  if (!mc) return { 優, 缺, 施策 };
  const pctOf = (a, b) => b ? a / b * 100 : null;
  const timePct = mc.totalWork ? mc.elapsedWork / mc.totalWork * 100 : 100;
  const ach = pctOf(mc.amt, mc.target.amt);
  const chg = (a, b) => (b ? (a / b - 1) * 100 : null);

  if (ach !== null) {
    if (mc.進行中) {
      const projAch = pctOf(mc.projected, mc.target.amt);
      (projAch >= 100 ? 優 : 缺).push(
        `全廠月底推估 ${(projAch).toFixed(0)}%（目前 ${ach.toFixed(0)}%／時間進度 ${timePct.toFixed(0)}%）`);
      if (projAch < 100) {
        const gap = mc.target.amt - mc.amt;
        施策.push(`剩 ${mc.remainWork} 個營業日要補 ${Math.round(gap / 10000)} 萬，每天要做到 ${Math.round(gap / Math.max(1, mc.remainWork) / 10000)} 萬（目前日均 ${Math.round(mc.perWorkDay / 10000)} 萬）`);
      }
    } else {
      (ach >= 100 ? 優 : 缺).push(`全廠達成 ${ach.toFixed(0)}%（${Math.round(mc.amt / 10000)}／${Math.round(mc.target.amt / 10000)} 萬）`);
    }
  }
  for (const [k, name, tk, ck] of [['eng', '引電', 'eng', 'engCars'], ['bp', '鈑噴', 'bp', 'bpCars']]) {
    if (!mc.target[tk]) continue;
    const p = pctOf(mc[k], mc.target[tk]);
    if (p >= timePct - 1) {
      // 差 1 個百分點以內算「追平」，不要把持平講成超前（海哥看了會以為贏很多）
      優.push(p >= timePct + 1
        ? `${name}組進度 ${p.toFixed(0)}%，超前時間進度 ${timePct.toFixed(0)}%`
        : `${name}組進度 ${p.toFixed(0)}%，跟時間進度 ${timePct.toFixed(0)}% 同步`);
    } else {
      缺.push(`${name}組進度 ${p.toFixed(0)}%，落後時間進度 ${timePct.toFixed(0)}%`);
      // 台數 vs 單車產值：分辨「車沒進來」還是「單價做不起來」
      const lm = mc.lastMonth;
      if (lm && lm[ck]) {
        const carChg = chg(mc[ck], lm[ck]);
        const pcCur = mc[ck] ? mc[k] / mc[ck] : 0, pcLm = lm[ck] ? lm[k] / lm[ck] : 0;
        const pcChg = pcLm ? (pcCur / pcLm - 1) * 100 : null;
        if (carChg !== null && pcChg !== null) {
          施策.push(carChg < pcChg
            ? `${name}：進廠台數比上月同期 ${carChg.toFixed(0)}%、單車產值 ${pcChg >= 0 ? '+' : ''}${pcChg.toFixed(0)}% → 問題在車沒進來，先查預約與在廠台數`
            : `${name}：進廠台數 ${carChg >= 0 ? '+' : ''}${carChg.toFixed(0)}%、單車產值 ${pcChg.toFixed(0)}% → 台數有進來但單車做不起來，查估價與加項提案`);
        }
      }
    }
  }
  if (mc.lastYear) {
    const c = chg(mc.amt, mc.lastYear.amt);
    (c >= 0 ? 優 : 缺).push(`比去年同期 ${c >= 0 ? '+' : ''}${c.toFixed(1)}%（去年 ${Math.round(mc.lastYear.amt / 10000)} 萬）`);
  }
  if (mc.parts && mc.recpParts) {
    const z = mc.recpParts.people.filter(p => p.tire === 0).map(p => p.name);
    if (z.length) 施策.push(`接待輪胎掛零：${z.join('、')} → 請廠主管關心，一對一了解卡在哪`);
  }
  return { 優, 缺, 施策 };
}

// 🦞 四個 collection 全量讀一次要 15~20 秒（手機等太久、Render 免費方案更慢）→ 記憶體快取 10 分鐘。
//    報表每天只更新一次（早上信件進來），10 分鐘快取不會讓海哥看到過期數字。
let _cache = null, _cacheAt = 0;
const CACHE_MS = 10 * 60 * 1000;
async function loadAll() {
  if (_cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
  const [perf, parts, recp, targets, ew] = await Promise.all([
    readFirebase('technician_performance'),
    readFirebase('technician_parts_summary'),
    readFirebase('receptionist_parts_summary').catch(() => []),
    readFirebase('monthly_targets'),
    readFirebase('warranty_sales').catch(() => []),
  ]);
  _cache = { perf, parts, recp, targets, ew };
  _cacheAt = Date.now();
  return _cache;
}

async function buildReport(loc) {
  const today = todayStr();
  const { perf, parts, recp, targets, ew } = await loadAll();
  const curYM = today.slice(0, 7);
  const allYM = [...new Set(perf.filter(p => p.location === loc).map(p => (p.period_end || '').slice(0, 7)))]
    .filter(Boolean).sort();
  const thisYear = curYM.slice(0, 4);
  const monthsThisYear = allYM.filter(m => m.startsWith(thisYear));
  const cards = {};
  monthsThisYear.forEach(ym => { cards[ym] = monthCard(perf, parts, recp, targets, ew, loc, ym, today); });
  const cur = cards[curYM] || cards[monthsThisYear[monthsThisYear.length - 1]];
  return {
    loc, today, 本月: curYM, 可選月份: monthsThisYear,
    月卡: cards,
    週卡: weekCards(perf, loc, cur ? cur.ym : curYM),
    年卡: yearCard(perf, targets, loc, Number(thisYear), today),
    分析: analyse(cur),
  };
}

module.exports = { buildReport };
