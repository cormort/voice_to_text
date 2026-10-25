// 逐字稿保存（src/persist.js）與接線的測試。
//
// 為什麼要這支：在會場裡「逐字稿不見了」是最糟的失敗，而且它很安靜 ——
//   * 以前每按一次「開始」，begin() 就把前面的段落整個清掉（中場休息後上半場消失）
//   * 逐字稿只在記憶體裡，重新整理或分頁被手機回收就全沒了
//   * 螢幕一關，麥克風可能被停掉，畫面卻還寫著「辨識中」
// 前兩項驗行為（純函式）與接線，第三項只能驗接線（wake lock 要真瀏覽器）。
//
// 跑法：node test_persist.js   （離開碼 1 表示失敗）
'use strict';

const { TRANSCRIPT_KEY, serializeTranscript, restoreTranscript } = require('./src/persist.js');
const APP = require('./test_src.js')();

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

// ── 1. 序列化 → 還原是來回一致的（含譯文）───────────────────────────────
const start = new Date('2026-10-25T09:00:00Z');
const segments = [
  { time: new Date('2026-10-25T09:00:01Z'), text: '--- Recording Start / 錄音開始 ---' },
  { time: new Date('2026-10-25T09:00:05Z'), text: 'The quick brown fox', zh: '敏捷的棕色狐狸' },
  { time: new Date('2026-10-25T09:00:09Z'), text: '第二句' },
];
const back = restoreTranscript(serializeTranscript(start, segments));
check('還原出相同段數', back && back.segments.length === 3, back ? String(back.segments.length) : 'null');
check('時間還原成 Date 且數值相同',
  back && back.segments.every((s, i) => s.time instanceof Date && s.time.getTime() === segments[i].time.getTime()));
check('原文與譯文都保留', back && back.segments[1].text === 'The quick brown fox' && back.segments[1].zh === '敏捷的棕色狐狸');
check('沒有譯文的段落不會多出 zh', back && !('zh' in back.segments[2]));
check('開始時間保留（輸出檔名靠它）', back && back.start.getTime() === start.getTime());
check('沒有開始時間時退回第一段的時間',
  restoreTranscript(serializeTranscript(null, segments)).start.getTime() === segments[0].time.getTime());

// ── 2. 壞資料一律回 null（App 必須照常啟動）─────────────────────────────
for (const [label, raw] of [
  ['空值', null], ['非 JSON', '{oops'], ['舊版本', JSON.stringify({ v: 0, segments: [] })],
  ['segments 不是陣列', JSON.stringify({ v: 1, segments: 'x' })],
  ['全是無效段落', JSON.stringify({ v: 1, segments: [{ t: 'nope', text: 'a' }, { t: '2026-10-25T09:00:00Z', text: '' }]})],
]) {
  check(`壞資料（${label}）回 null`, restoreTranscript(raw) === null);
}
const mixed = restoreTranscript(JSON.stringify({ v: 1, start: null, segments: [
  { t: 'bad', text: 'x' }, { t: '2026-10-25T09:00:00Z', text: 'ok' }, null,
]}));
check('只丟掉壞的段落、留下好的', mixed && mixed.segments.length === 1 && mixed.segments[0].text === 'ok');

// ── 3. 接線：begin 不再清空、寫入時機、還原、wake lock ───────────────────
const begin = (APP.match(/function begin\(\) \{[\s\S]*?\n  \}/) || [''])[0];
const beginCode = begin.replace(/\/\/.*$/gm, '');   // 註解裡會提到舊寫法，只看程式碼
check('begin() 不再清掉既有段落', begin && !/state\.segments\s*=/.test(beginCode), begin ? '' : 'begin() not found');
check('begin() 只在第一次設定開始時間', /if \(!state\.start\) state\.start = new Date\(\);/.test(begin));
check('commit 之後會排寫入', /queueTranslation\(segment\);\s*\n\s*persistTranscript\(\);/.test(APP));
check('譯文回來也會寫入', /segment\.zh = zh;\s*\n\s*persistTranscript\(\);/.test(APP));
check('切到背景／離開頁面時立刻寫', /visibilityState === 'hidden'\) persistTranscript\(true\)/.test(APP) &&
  /addEventListener\('pagehide', \(\) => persistTranscript\(true\)\)/.test(APP));
check('開頁時還原', /const restoredCount = restoreSavedTranscript\(\);/.test(APP));
check('清空前要確認', /confirm\(t\(\)\.confirmClear\)/.test(APP));
check('儲存鍵與設定分開（清設定不會清逐字稿）', TRANSCRIPT_KEY !== 'stt-pref');
check('錄音中要求 wake lock', /navigator\.wakeLock\.request\('screen'\)/.test(APP) && /void syncWakeLock\(\);/.test(APP));

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exitCode = failed ? 1 : 0;
