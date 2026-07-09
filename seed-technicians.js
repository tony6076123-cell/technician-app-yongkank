// 🦞 一次性種子腳本（本機用）：把 roster.json 裡「自己這個廠」的人員名單，寫進自己的 Firestore。
// 用法：node seed-technicians.js 永康   （或 node seed-technicians.js 歸仁）
// 雲端部署（Render等）不用手動跑這支，server.js 開機時會自動偵測空集合觸發同一套邏輯。
const { getValidFirebaseToken, saveToFirebase, getProjectId, buildSeedDocs } = require('./lib.js');

const location = process.argv[2];
if (location !== '永康' && location !== '歸仁') {
  console.log('用法：node seed-technicians.js 永康   （或 歸仁）');
  process.exit(1);
}

async function main() {
  const token = await getValidFirebaseToken();
  console.log(`目前連接的 Firebase 專案：${getProjectId()}`);
  const docs = buildSeedDocs(location);
  if (!docs) { console.log('❌ 找不到 roster.json'); process.exit(1); }
  console.log(`準備寫入 ${docs.length} 筆`);
  let ok = 0, fail = 0;
  for (const d of docs) {
    const success = await saveToFirebase(token, d);
    console.log(`${success ? '✅' : '❌'} ${d.id} ${d.name}`);
    if (success) ok++; else fail++;
  }
  console.log(`\n完成：成功 ${ok}，失敗 ${fail}`);
}

main().catch(e => { console.error('❌ 種子腳本失敗:', e.message); process.exit(1); });
