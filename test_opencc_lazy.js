// OpenCC（簡→繁）按需載入的守門測試。
//
// 為什麼要這支：opencc-js 的 cn2t.js 實測 1.04 MB（br 505 KB），是整個 App 本體
// gzip（44.6 KB）的 11 倍。它原本是 parser-blocking 的 <script src>，放在主 inline
// script 之前 —— 實測（Chromium、Slow 3G 400 kbps／400 ms RTT）：
//   有它在 critical path：UI 可用 14,111 ms
//   擋掉它：               UI 可用     59 ms
// 這種「一行標籤就讓整頁慢 14 秒」的東西很容易被順手加回來（例如有人想「簡化」成
// 靜態標籤），所以用測試把三件事釘住：
//   1. index.html 裡**不能**再出現靜態的 opencc <script src>
//   2. 真的需要中文時，載入器要能把腳本注入（單次、帶 SRI）並讓轉換生效
//   3. 不需要中文時，一個位元組都不該抓
//
// 跑法：node test_opencc_lazy.js   （離開碼 1 表示失敗）

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

// ── 1) 靜態標籤必須消失（這是整個修正的核心）────────────────────────────────
const staticTag = HTML.match(/<script[^>]+src="[^"]*opencc[^"]*"[^>]*>/);
check('index.html 沒有靜態的 opencc <script src>（parser-blocking 會擋住整個 App 啟動）',
  !staticTag, staticTag ? staticTag[0].slice(0, 80) : '');

// 唯一合法的注入點是 ensureOpencc() 裡的 document.createElement('script')
const createElementUses = (HTML.match(/createElement\('script'\)/g) || []).length;
check('opencc 只用動態注入（createElement + appendChild）',
  createElementUses >= 1 && /script\.src = OPENCC_URL/.test(HTML) && /document\.head\.appendChild\(script\)/.test(HTML),
  `createElement('script') 出現 ${createElementUses} 次`);

check('動態載入有帶 SRI 與 crossorigin（上游換檔會直接失敗而不是靜默執行）',
  /script\.integrity = OPENCC_SRI/.test(HTML) && /script\.crossOrigin = 'anonymous'/.test(HTML));
check('OPENCC_SRI 是 sha384 的 base64 摘要',
  /const OPENCC_SRI = 'sha384-[A-Za-z0-9+/=]{40,}'/.test(HTML));

// ── 2) 真的把邏輯跑起來（不是只比對字串）────────────────────────────────────
const start = HTML.indexOf('  const OPENCC_URL');
const end = HTML.indexOf('  function stamp(');
check('找得到 OpenCC 區塊', start > 0 && end > start, `${start}..${end}`);
if (start < 0 || end <= start) { console.log('\n1 項失敗'); process.exitCode = 1; return; }
const block = HTML.slice(start, end);

function makeHarness() {
  const injected = [];
  const sandbox = {
    console: { warn: () => {}, log: () => {}, error: () => {} },
    // 假的 DOM：只記下被注入的 script，並讓測試能手動觸發 onload
    document: {
      head: { appendChild: (el) => injected.push(el) },
      createElement: () => ({})
    },
    state: { engine: 'vosk' },
    el: { lang: { value: 'zh-TW' }, voskSource: { value: 'builtin' }, voskLang: { value: 'cn' } },
    openccConverters: new Map()
  };
  sandbox.window = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${block}\n globalThis.__api = { ensureOpencc, chineseVariant, prefetchOpencc, traditional };`,
    sandbox, { filename: 'opencc-block.js' });
  return { api: sandbox.__api, injected, sandbox };
}

// 需要中文（Vosk 內建 cn）：注入一次、轉換生效
{
  const { api, injected, sandbox } = makeHarness();
  check('chineseVariant()：Vosk 內建 cn → twp', api.chineseVariant() === 'twp', String(api.chineseVariant()));

  const before = api.traditional('软件工程师');
  check('OpenCC 還沒到時原樣輸出（優雅降級，不會壞）', before === '软件工程师', before);
  check('同一次呼叫就觸發了按需載入', injected.length === 1, `注入 ${injected.length} 個 script`);
  check('注入的 script 指向鎖定版本', injected[0] && injected[0].src === 'https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/cn2t.js',
    injected[0] && injected[0].src);

  api.traditional('里面');
  api.ensureOpencc();
  api.prefetchOpencc();
  check('重複呼叫只會注入一次（single-flight）', injected.length === 1, `注入 ${injected.length} 個`);

  // 模擬 CDN 載入完成
  sandbox.window.OpenCC = { Converter: () => (text) => text.replace('软件', '軟體').replace('里面', '裡面') };
  const after = api.traditional('软件工程师');
  check('OpenCC 到位後轉換生效（twp）', after === '軟體工程师', after);

  // zh-HK 的港式用語只在「語言選單決定語言」的引擎成立（Whisper／Web Speech）；
  // Vosk 內建 cn 是模型決定語言，此時選單無效 → 仍是 twp
  sandbox.el.lang.value = 'zh-HK';
  check('chineseVariant()：Vosk 內建 cn 時選單無效 → 仍為 twp',
    api.chineseVariant() === 'twp', String(api.chineseVariant()));
  sandbox.state.engine = 'whisper';
  check('chineseVariant()：Whisper + zh-HK → hk（港式用語）',
    api.chineseVariant() === 'hk', String(api.chineseVariant()));
}

// 不需要中文（英文 / Whisper / Whistle）：一個位元組都不該抓
for (const [engine, lang, voskLang, voskSource] of [
  ['webspeech', 'en-US', 'cn', 'builtin'],
  ['whisper', 'en-GB', 'cn', 'builtin'],
  ['whistle', 'de-DE', 'cn', 'builtin'],
  ['vosk', 'en-US', 'en', 'builtin'],          // 內建英文模型 → 不轉
  ['vosk', 'zh-TW', 'en', 'builtin']           // 內建英文模型即使選單停在中文也不轉
]) {
  const { api, injected, sandbox } = makeHarness();
  Object.assign(sandbox.state, { engine });
  sandbox.el.lang.value = lang;
  sandbox.el.voskLang.value = voskLang;
  sandbox.el.voskSource.value = voskSource;
  const out = api.traditional('hello world');
  api.prefetchOpencc();
  check(`${engine}／${lang}（內建 ${voskLang}）：不轉換也不下載 OpenCC`,
    api.chineseVariant() === null && out === 'hello world' && injected.length === 0,
    `variant=${api.chineseVariant()} injected=${injected.length}`);
}

// 由模型決定語言的三個引擎一定要轉（即使語言選單停在英文）
for (const engine of ['moss', 'sherpa']) {
  const { api, sandbox } = makeHarness();
  sandbox.state.engine = engine;
  sandbox.el.lang.value = 'en-US';
  check(`${engine}：輸出語言由模型決定 → 語言選單是英文也要轉（twp）`,
    api.chineseVariant() === 'twp', String(api.chineseVariant()));
}

// ── 3) 觸發點：begin()／updateEngine()／語言選單 ────────────────────────────
check('begin() 會預抓 OpenCC', /function begin\(\) \{\s*\n\s*prefetchOpencc\(\);/.test(HTML));
check('updateEngine() 會預抓 OpenCC 並顯示 Whistle 的語言提示',
  /el\.langNote\.hidden = state\.engine !== 'whistle';/.test(HTML) && /prefetchOpencc\(\);\s+\/\/ 這個引擎/.test(HTML));
check('語言選單變更時會預抓', /el\.lang\.onchange = \(\) => \{\s*\n\s*prefetchOpencc\(\);/.test(HTML));
check('MOSS 的整批寫入會等 OpenCC（而不是整份留簡體）',
  /async function commitBatch\(lines\) \{\s*\n\s*if \(chineseVariant\(\)\) await ensureOpencc\(\);/.test(HTML) &&
  /await commitBatch\(\[/.test(HTML));

console.log(`\n${failed === 0 ? '全部通過' : `${failed} 項失敗`}`);
process.exitCode = failed ? 1 : 0;
