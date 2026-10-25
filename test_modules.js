// 模組邊界的守門測試：確認「程式已經真的不在 index.html 裡」，
// 而且抽出去的模組仍然提供 app.js 需要的东西。
//
// 這支測試的目的不是驗行為（行為由 test_vad.js / test_subtitle.js 等負責），
// 而是防止有人把邏輯偷偷寫回 index.html —— 那就等於回到單檔 200 KB 的老路。
//
// 跑法：node test_modules.js   （離開碼 1 表示失敗）

'use strict';

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, 'src', 'app.js'), 'utf8');

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

// ── 1. index.html 只該有版面與兩個小 inline script ────────────────────────
const inlineScripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const inlineBytes = inlineScripts.reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0);
check('index.html 沒有內嵌主程式', !/const T = \{/.test(HTML) && !/function commit\(s\)/.test(HTML));
check('index.html 只剩小段 inline script（GA 與 SW 註冊）', inlineScripts.length === 2 && inlineBytes < 4000,
  `${inlineScripts.length} 段、${inlineBytes} bytes`);
check('主程式以 module 方式載入', /<script type="module" src="src\/app\.js"><\/script>/.test(HTML));
check('index.html 只剩版面（沒有 200 KB 等級的內容）', HTML.length < 40000, `${HTML.length} bytes`);

// ── 2. app.js 只 import，不再自己重新定義已抽出的東西 ──────────────────────
check('app.js 匯入 i18n／util／vad',
  /import \{ T \} from '\.\/i18n\.js';/.test(APP) &&
  /from '\.\/util\.js';/.test(APP) &&
  /import \{ vadPush, vadFlush \} from '\.\/vad\.js';/.test(APP));
for (const name of ['function resample(', 'function stamp(', 'function vadPush(', 'const T = {']) {
  check(`app.js 沒有重複定義 ${name}`, !APP.includes(name));
}

// ── 3. 模組真的可以載入、而且匯出東西 ────────────────────────────────────
const util = require('./src/util.js');
const vad = require('./src/vad.js');
const i18n = require('./src/i18n.js');
check('src/util.js 匯出純函式',
  ['stamp', 'concat', 'resample', 'makeAudioBuffer', 'isLatinDominated'].every(k => typeof util[k] === 'function'),
  Object.keys(util).join(','));
check('src/vad.js 匯出 vadPush／vadFlush',
  typeof vad.vadPush === 'function' && typeof vad.vadFlush === 'function', Object.keys(vad).join(','));
check('src/i18n.js 有中英兩份文案', !!(i18n.T && i18n.T.zh && i18n.T.en),
  i18n.T ? Object.keys(i18n.T).join(',') : 'no T');
check('中英文案鍵數一致', Object.keys(i18n.T.zh).length === Object.keys(i18n.T.en).length,
  `${Object.keys(i18n.T.zh).length} vs ${Object.keys(i18n.T.en).length}`);

// ── 4. 服務工作者要把模組放進外殼（離線開啟才不會白畫面）──────────────────
const SW = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
for (const file of ['./src/app.js', './src/i18n.js', './src/util.js', './src/vad.js', './src/persist.js']) {
  check(`sw.js 外殼包含 ${file}`, SW.includes(`'${file}'`));
}

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exitCode = failed ? 1 : 0;
