// Whistle 的呼叫層與 worker 訊息協定測試（不需要 16.9 MB 模型、不需要瀏覽器）。
//
// 為什麼要這支：Whistle 的解碼呼叫有幾個「寫錯會安靜壞掉」的細節 ——
//   * needle_load 的長度參數是 unsigned long long（wasm i64），傳 Number 直接丟
//     TypeError（實測：Cannot convert 16919407 to a BigInt）→ 模型永遠載不起來
//   * needle_transcribe 的語言是「七個字串或 NULL」，送 'zh' 不是猜錯而是不存在的代碼
//   * 一次上限 30 秒，超量要自己裁
//   * word_timestamps 旗標沒開就沒有詞級時間戳
// 這些都在 whistle-engine.js 的**唯一一份實作**裡（worker 與主執行緒退路共用），
// 所以這裡用一個假 module 跑真正的 whistle-engine.js，不必下載模型。
//
// 同時驗證 worker 協定（whistle-worker.js）：load 要回 ready、transcribe 要回帶 id 的
// result、失敗要回帶 id 的 error（主執行緒的等待器靠 id 對答案，少了就是無聲卡住）。
//
// 跑法：node test_whistle_worker_api.js   （離開碼 1 表示失敗）

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENGINE_SRC = fs.readFileSync(path.join(__dirname, 'whistle-engine.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'whistle-worker.js'), 'utf8');
const HTML_SRC = require('./test_src.js')();

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

const SAMPLE_RATE = 16000;

// ── 假的 needle module：位址用 bump allocator，行為對齊 needle.h ──────────────
function makeFakeModule() {
  const calls = { load: [], transcribe: [], tokens: [] };
  const heap = new Uint8Array(4 * 1024 * 1024);
  let next = 64;

  const readCString = (pointer) => {
    let text = '';
    for (let i = pointer; heap[i]; i++) text += String.fromCharCode(heap[i]);
    return text;
  };

  return {
    calls,
    heap,
    HEAPU8: heap,
    UTF8ToString: readCString,
    _malloc: (bytes) => {
      next = (next + 7) & ~7;
      const pointer = next;
      next += bytes;
      if (next > heap.length) throw new Error('fake heap exhausted');
      return pointer;
    },
    _free: () => {},
    _needle_load: (pointer, length) => {
      calls.load.push({ pointer, length, type: typeof length });
      return calls.loadFailure ? -1 : 0;
    },
    _needle_models: () => 2,
    _needle_last_error: () => 0,
    _needle_transcribe: (pcm, samples, language, keywords, wordTimestamps, out, capacity) => {
      calls.transcribe.push({
        pcm, samples, keywords, wordTimestamps, out, capacity,
        language: language ? readCString(language) : null,
        hasLanguagePointer: !!language
      });
      const json = JSON.stringify({
        text: ' Turn off the kitchen lights. ',
        language: language ? readCString(language) : 'en',
        words: [{ word: 'Turn', start: 0, end: 0.24, probability: 0.78 }],
        ttft_ms: 376.2,
        decode_tps: 30.3
      });
      const bytes = new TextEncoder().encode(json);
      heap.set(bytes, out);
      heap[out + bytes.length] = 0;
      return 12;
    }
  };
}

// ── 在 VM 裡跑真正的 whistle-engine.js（與瀏覽器／worker 相同的載入方式）────────
function loadEngine() {
  // VM 沙箱沒有 TextEncoder（瀏覽器與 Worker 都有），補進去
  const sandbox = { console, TextEncoder, Date };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ENGINE_SRC, sandbox, { filename: 'whistle-engine.js' });
  return sandbox.WhistleEngine;
}

// ── 在 VM 裡跑真正的 whistle-worker.js：注入 self / importScripts / 假引擎 ──────
function makeWorkerHarness() {
  const posted = [];
  const modules = [];
  const fetched = [];
  let failNextLoad = false;

  // Worker 裡的 `self` **就是**全域物件：importScripts 進來的 `var WhistleEngine`
  // 會變成 self 的屬性。沙箱必須照這個關係建立，否則測試會與真實行為分岔。
  const sandbox = {
    TextEncoder, Date, JSON,
    console: { warn: () => {}, log: () => {}, error: () => {} }
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.postMessage = (msg) => posted.push(msg);
  sandbox.onmessage = null;
  // Worker 會自己 fetch needle.wasm（同源、走 Service Worker 快取）
  sandbox.fetch = async (url) => {
    fetched.push(url);
    return { ok: true, status: 200, url, arrayBuffer: async () => new ArrayBuffer(2048) };
  };

  sandbox.importScripts = (url) => {
    if (String(url).includes('needle.js')) {
      // 真實膠水層在這裡定義 createNeedle；工廠要能被 await，並且記下 locateFile 的結果
      sandbox.createNeedle = async (options) => {
        const module = makeFakeModule();
        // 真的膠水層是從 Module.wasmBinary 讀位元組（沒有 locateFile 入口）
        module.wasmBinary = options.wasmBinary;
        module.locateFilePassed = typeof options.locateFile === 'function';
        module.calls.loadFailure = failNextLoad;
        modules.push(module);
        return module;
      };
    } else if (String(url).includes('whistle-engine.js')) {
      vm.runInContext(ENGINE_SRC, sandbox, { filename: 'whistle-engine.js' });
    } else {
      throw new Error(`unexpected importScripts(${url})`);
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(WORKER_SRC, sandbox, { filename: 'whistle-worker.js' });

  const send = (msg) => sandbox.onmessage({ data: msg });
  return { posted, send, modules, fetched, sandbox, failLoad: () => { failNextLoad = true; } };
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

(async () => {
  // ── 1) 呼叫層 ────────────────────────────────────────────────────────────
  const engine = loadEngine();
  const module = makeFakeModule();
  const models = engine.loadModel(module, new ArrayBuffer(1024));

  check('loadModel 回傳 needle_models（2 = 語音模型）', models === 2, String(models));
  check('needle_load 的長度是 BigInt（傳 Number 在真的 wasm 會丟 TypeError）',
    module.calls.load.length === 1 && module.calls.load[0].type === 'bigint',
    `typeof length = ${module.calls.load[0] && module.calls.load[0].type}`);

  const audio = new Float32Array(SAMPLE_RATE * 3);
  const output = engine.transcribe(module, audio, 'de');
  const call = module.calls.transcribe[0];

  check('needle_transcribe 收到正確的取樣數', call.samples === audio.length, String(call.samples));
  check('keywords 傳 0、word_timestamps 傳 1（要詞級時間戳）',
    call.keywords === 0 && call.wordTimestamps === 1, JSON.stringify({ k: call.keywords, w: call.wordTimestamps }));
  check('指定語言時傳入對應字串指標', call.hasLanguagePointer && call.language === 'de', call.language);
  check('輸出緩衝用的是引擎自己宣告的大小', call.capacity === engine.OUT_CAPACITY, String(call.capacity));
  check('回傳值有解析 JSON（text 去頭尾空白、words、ttft）',
    output.text === 'Turn off the kitchen lights.' && output.language === 'de' &&
    output.words.length === 1 && output.ttftMs === 376.2,
    JSON.stringify(output));

  const auto = engine.transcribe(module, audio, null);
  check('沒有指定語言時傳 NULL（讓引擎自動偵測）',
    module.calls.transcribe[1].hasLanguagePointer === false, JSON.stringify(module.calls.transcribe[1]));
  check('自動偵測時回傳偵測到的語言', auto.language === 'en', auto.language);

  const long = new Float32Array(SAMPLE_RATE * 40);
  engine.transcribe(module, long, null);
  check('超過 30 秒的音訊會被裁到上限（needle.h 的限制）',
    module.calls.transcribe[2].samples === 30 * SAMPLE_RATE,
    String(module.calls.transcribe[2].samples));

  // ── 2) worker 協定 ───────────────────────────────────────────────────────
  const { posted, send, modules, fetched } = makeWorkerHarness();

  send({ type: 'transcribe', id: 1, audio: new Float32Array(16) });
  await wait();
  check('模型還沒載入就 transcribe 會回 error（而不是靜默）',
    posted.some((m) => m.type === 'error' && m.phase === 'transcribe'),
    JSON.stringify(posted));

  posted.length = 0;
  send({ type: 'load', wasmUrl: 'https://example.test/needle/needle.wasm', model: new ArrayBuffer(2048) });
  await wait();
  check('load 之後會回 ready 並帶 models=2',
    posted.some((m) => m.type === 'ready' && m.models === 2), JSON.stringify(posted));
  // 真實踩過的坑：needle.js 沒有 Module.locateFile 入口，Worker 裡的
  // `self.location.href` 會讓它去抓 <站台根>/needle.wasm，伺服器回 HTML 就炸
  // `expected magic word 00 61 73 6d, found 3c 21 44 4f`（`<!DO`）。所以位元組要用
  // wasmBinary 直接餵，不能靠路徑推導。
  check('Worker 會自己抓 needle.wasm 並以 wasmBinary 交給引擎（不靠 locateFile 的路徑推導）',
    fetched.length === 1 && fetched[0] === 'https://example.test/needle/needle.wasm' &&
    modules[0] && modules[0].wasmBinary instanceof ArrayBuffer && modules[0].wasmBinary.byteLength === 2048,
    JSON.stringify({ fetched, wasmBinary: modules[0] && modules[0].wasmBinary && modules[0].wasmBinary.byteLength }));
  check('不把 locateFile 當成可用的入口（這份建置不支援它）',
    modules[0] && modules[0].locateFilePassed === false,
    String(modules[0] && modules[0].locateFilePassed));

  check('index.html 的主執行緒退路同樣用 wasmBinary（不是靠「膠水層剛好在 needle/ 目錄下」）',
    /createNeedle\(\{\s*wasmBinary/.test(HTML_SRC),
    /createNeedle\(\{\s*wasmBinary/.test(HTML_SRC) ? '' : '找不到 createNeedle({ wasmBinary … })');

  posted.length = 0;
  send({ type: 'transcribe', id: 7, audio: new Float32Array(SAMPLE_RATE), language: 'fr' });
  await wait();
  const results = posted.filter((m) => m.type === 'result');
  check('transcribe 會回帶 id 的 result（主執行緒靠 id 對答案）',
    results.length === 1 && results[0].id === 7 && results[0].text === 'Turn off the kitchen lights.',
    JSON.stringify(results));
  check('transcribe 階段沒有回 error', !posted.some((m) => m.type === 'error'), JSON.stringify(posted));

  // 引擎丟錯時，error 一定要帶 id —— 否則主執行緒的 Promise 永遠不會 settle
  const broken = makeWorkerHarness();
  broken.send({ type: 'load', wasmUrl: 'x', model: new ArrayBuffer(8) });
  await wait();
  broken.posted.length = 0;
  const originalTranscribe = broken.modules[0]._needle_transcribe;
  broken.modules[0]._needle_transcribe = () => { throw new Error('boom'); };
  broken.send({ type: 'transcribe', id: 9, audio: new Float32Array(32), language: null });
  await wait();
  broken.modules[0]._needle_transcribe = originalTranscribe;
  check('引擎丟錯時 error 帶回原本的 id（否則主執行緒的 Promise 永遠不 settle）',
    broken.posted.some((m) => m.type === 'error' && m.id === 9 && /boom/.test(m.message)),
    JSON.stringify(broken.posted));

  const failedLoad = makeWorkerHarness();
  failedLoad.failLoad();
  failedLoad.send({ type: 'load', wasmUrl: 'x', model: new ArrayBuffer(8) });
  await wait();
  check('needle_load 失敗時回 error phase=load（載入流程要能據此退回主執行緒）',
    failedLoad.posted.some((m) => m.type === 'error' && m.phase === 'load'),
    JSON.stringify(failedLoad.posted));

  // ── 3) 單一實作守則：index.html 不該自己再寫一份解碼呼叫 ──────────────────
  const directCalls = HTML_SRC.match(/_(needle_transcribe|needle_load)\s*\(/g) || [];
  check('index.html 沒有直接呼叫 needle 的底層 API（解碼只有 whistle-engine.js 一份實作）',
    directCalls.length === 0, directCalls.join(', '));
  check('index.html 的主執行緒退路走 WhistleEngine',
    /WhistleEngine\.loadModel|WhistleEngine\.transcribe/.test(HTML_SRC),
    /WhistleEngine\.loadModel|WhistleEngine\.transcribe/.test(HTML_SRC) ? '' : '找不到 WhistleEngine.loadModel / WhistleEngine.transcribe');
  const SW_TEXT = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
  check('Service Worker 預抓 whistle-worker.js 與 whistle-engine.js',
    /\.\/whistle-worker\.js/.test(SW_TEXT) && /\.\/whistle-engine\.js/.test(SW_TEXT));
  // needle 引擎（342 KB gzip 的 wasm + 18 KB 的 js）只有選 Whistle 的人會用到，
  // 預抓等於讓所有訪客多付 360 KB —— 它由 fetch handler 在第一次使用時快取即可
  check('needle 引擎**不**預抓（改由第一次使用時寫進快取）',
    !/\.\/needle\/needle\.(wasm|js)/.test(SW_TEXT));


  // ── 4) UI 接線：引擎卡片、下拉選項、面板、按鈕、ENGINES 分派 ──────────────
  const SW_SRC = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
  const wiring = [
    ['引擎卡片', /data-engine="whistle"/],
    ['下拉選項', /id="optWhistle"/],
    ['設定面板', /id="whistleConfig"/],
    ['載入按鈕', /id="loadWhistleBtn"/],
    ['清除快取按鈕', /id="clearWhistleCacheBtn"/],
    ['ENGINES 分派', /whistle: whistleEngine,/],
    ['KNOWN_ENGINES 白名單', /KNOWN_ENGINES = \[[^\]]*'whistle'/],
    ['Service Worker 外殼清單', /'\.\/whistle-worker\.js'/, SW_SRC]
  ];
  for (const [label, pattern, source] of wiring) {
    const text = source || HTML_SRC;
    check(`index.html/sw.js 有接上${label}`, pattern.test(text), pattern.test(text) ? '' : String(pattern));
  }

  // 中英文字串都要有，否則切換語言會出現空白或 undefined
  for (const [name, probe] of [
    ['whistleHint', /whistleHint:/g],
    ['ecards.whistle', /whistle: \{ name: 'Whistle'/g],
    ['quickstart.whistle', /whistle: '(在 Whistle|Click <b>Load model<\/b> in the Whistle)/g],
    ['optWhistle', /optWhistle:/g]
  ]) {
    const hits = (HTML_SRC.match(probe) || []).length;
    check(`中英文都有 ${name} 字串`, hits === 2, `找到 ${hits} 處`);
  }

  console.log(`\n${failed === 0 ? '全部通過' : `${failed} 項失敗`}`);
  process.exitCode = failed ? 1 : 0;
})();
