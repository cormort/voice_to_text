// sherpa-worker 的訊息協定測試（不需要 200 MB 模型）。
//
// 為什麼要這支：worker 化的價值是把解碼移出主執行緒，但代價是**同一組 sherpa API 被呼叫兩次
// 實作**（index.html 的主執行緒路徑、sherpa-worker.js 的 worker 路徑），兩邊只要有一個參數
// 對不上就會壞掉 —— 而且壞得很安靜。
//
// 實際發生過：官方膠水層的簽名是 `getResult(stream)`（內部讀 `stream.handle`），
// worker 卻寫成 `recognizer.getResult()`（沒帶 stream），於是**每一個音訊塊都丟
// TypeError**；worker 把錯誤包成 `{type:'error', phase:'feed'}` 傳回主執行緒，
// 而主執行緒的等待器只認 `ready/final/started`，這個訊息沒有任何人處理 ——
// 症狀就是「音量 bar 有動、字幕永遠不出來」，而且在 UI 上完全沒有線索。
//
// 這支測試用一個**假膠水層**在 Node 裡跑真正的 sherpa-worker.js：假 recognizer 的
// `getResult(stream)` 會像真的一樣讀 `stream.handle`（沒帶參數就丟 TypeError），
// 所以「忘記帶 stream」這種錯會直接讓測試紅燈，不必下載模型。
//
// 跑法：node test_sherpa_worker_api.js   （離開碼 1 表示失敗）

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, 'sherpa-worker.js'), 'utf8');

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

// ── 假的膠水層：簽名與官方 sherpa-onnx-asr.js 一致 ────────────────────────
// 關鍵是真實性：getResult 一定要讀 stream.handle，否則這個測試就抓不到漏參數的 bug。
function makeFakeGlue() {
  const calls = { getResult: [], acceptWaveform: [], decode: 0, reset: 0 };

  class OnlineStream {
    constructor() { this.handle = { fake: 'stream-handle' }; }
    acceptWaveform(sampleRate, samples) { calls.acceptWaveform.push({ sampleRate, n: samples.length }); }
    inputFinished() { this.finished = true; }
    free() { this.freed = true; }
  }

  class OnlineRecognizer {
    createStream() { return new OnlineStream(); }
    // 真實模型的行為：手上還有音訊可以解時回 true，解完就回 false（worker 的 while 迴圈靠這個收斂）。
    // 假物件若永遠回 true，worker 會卡在迴圈裡 —— 這一點也是真實契約的一部分。
    isReady(stream) {
      if (!stream || !stream.handle) return false;
      stream.readyCalls = (stream.readyCalls || 0) + 1;
      return stream.readyCalls <= 2;
    }
    decode(stream) { calls.decode++; }
    isEndpoint(stream) { return !!stream.handle; }
    reset(stream) { calls.reset++; }
    getResult(stream) {
      // 真膠水層：this.Module._SherpaOnnxGetOnlineStreamResultAsJson(this.handle, stream.handle)
      calls.getResult.push(stream && stream.handle ? 'with-stream' : 'NO-STREAM');
      if (!stream || !stream.handle) {
        throw new TypeError("Cannot read properties of undefined (reading 'handle')");
      }
      return { text: '你好世界' };
    }
  }

  return { calls, createOnlineRecognizer: () => new OnlineRecognizer() };
}

// ── 在 VM 裡跑真正的 worker：注入 self / importScripts / 假膠水層 ──────────
function makeWorkerHarness() {
  const posted = [];
  const glue = makeFakeGlue();

  const self = {
    postMessage: (msg) => posted.push(msg),
    onmessage: null,
  };

  // importScripts 會被呼叫兩次：第一次要定義 createOnlineRecognizer，第二次是 emscripten
  // 主模組（它會去摸 self.Module.onRuntimeInitialized）。這裡照真實行為讓它觸發初始化。
  const importScripts = (url) => {
    if (String(url).includes('glue1')) self.createOnlineRecognizer = glue.createOnlineRecognizer;
    else if (typeof self.Module?.onRuntimeInitialized === 'function') self.Module.onRuntimeInitialized();
  };

  const sandbox = {
    self,
    importScripts,
    console: { warn: () => {}, log: () => {}, error: () => {} },
    module: { exports: {} },
    require,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'sherpa-worker.js' });

  const send = (msg) => self.onmessage({ data: msg });
  return { posted, glue, send };
}

const wait = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  const { posted, glue, send } = makeWorkerHarness();

  // 1) load：假膠水層以 blob URL 身分進來
  send({ type: 'load', dir: 'https://example.invalid/sherpa/', glueUrls: ['blob:glue1', 'blob:glue2'], package: new ArrayBuffer(8), sampleRate: 16000 });
  await wait();
  check('load 之後會回 ready', posted.some((m) => m.type === 'ready'), JSON.stringify(posted.map((m) => m.type)));

  // 2) start：必須回 started（主執行緒的等待器只認 ready/final/started）
  send({ type: 'start', sessionId: 7 });
  await wait();
  check('start 之後會回 started（且帶正確 sessionId）',
    posted.some((m) => m.type === 'started' && m.sessionId === 7),
    JSON.stringify(posted.slice(-2)));

  // 3) feed：這是本次 bug 的所在 —— getResult 必須帶 stream
  posted.length = 0;
  send({ type: 'feed', sessionId: 7, audio: new Float32Array(2048) });
  await wait();

  const getResultArgs = glue.calls.getResult.slice();
  check('feed 時呼叫 getResult 有帶 stream（官方簽名是 getResult(stream)，沒帶就是每個音塊丟 TypeError）',
    getResultArgs.length > 0 && getResultArgs.every((x) => x === 'with-stream'),
    `getResult 參數紀錄：${JSON.stringify(getResultArgs)}`);

  const results = posted.filter((m) => m.type === 'result');
  check('feed 之後會回 result，且文字不為空',
    results.length === 1 && results[0].sessionId === 7 && String(results[0].text).trim() === '你好世界',
    JSON.stringify(results));

  check('feed 階段沒有回任何 error 訊息',
    !posted.some((m) => m.type === 'error'),
    JSON.stringify(posted.filter((m) => m.type === 'error')));

  // 4) flush：補靜音收尾，也要帶 stream 並回 final 文字
  posted.length = 0;
  send({ type: 'flush', sessionId: 7 });
  await wait();
  const finals = posted.filter((m) => m.type === 'final');
  check('flush 之後會回 final，且文字不為空（收尾同樣要帶 stream）',
    finals.length === 1 && String(finals[0].text).trim() === '你好世界',
    JSON.stringify(finals));
  check('flush 有補送 0.4 秒靜音（16 kHz × 0.4）',
    glue.calls.acceptWaveform.some((c) => c.sampleRate === 16000 && c.n === 6400),
    JSON.stringify(glue.calls.acceptWaveform));

  // 5) free：釋放 stream 並回 freed
  posted.length = 0;
  send({ type: 'free' });
  await wait();
  check('free 之後會回 freed', posted.some((m) => m.type === 'freed'), JSON.stringify(posted));

  // 6) 對照組：原始碼裡不應該再出現任何「不帶參數的 getResult()」
  // 也要抓 `getResult?.()`（選擇性呼叫）—— 實際的 bug 就是寫成 `r?.getResult?.()`
  const bare = SRC.match(/getResult\s*\??\.\s*\(\s*\)/g) || [];
  check('原始碼中沒有不帶參數的 getResult() 呼叫',
    bare.length === 0, bare.length ? `找到 ${bare.length} 處` : '0 處');

  console.log(`\n${failed === 0 ? '全部通過' : `${failed} 項失敗`}`);
  process.exitCode = failed ? 1 : 0;
})();
