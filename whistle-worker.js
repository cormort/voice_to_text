// Whistle（Cactus Compute）推論 Worker —— 把 16.9 MB 的語音模型解碼移出主執行緒。
//
// 為什麼要這支：Whistle 是 Cactus 的 C++ 引擎（needle）跑 .cact 模型，WASM 下實測
// RTF 約 0.27–0.35（3 秒音訊約 0.98 秒、30 秒約 10.6 秒），一次解碼就是數秒的同步工作。
// 放在主執行緒會直接凍結 UI —— 這個專案在 sherpa（阻塞 18.9%）與 Whisper（49.6%）
// 已經踩過同一個坑，所以新引擎一律從 Worker 開始，主執行緒只做訊息搬運。
//
// 模型本體（whistle.cact，16.9 MB）由主執行緒下載與快取（沿用 fetchWhistleModel，
// 進度條與 Cache Storage 行為與 Vosk／sherpa 一致），下載完的位元組用 transferable
// 交進來（零拷貝）。引擎與呼叫層都與站台同源（needle/needle.js、needle/needle.wasm、
// whistle-engine.js），所以這裡直接用相對路徑 importScripts —— 同源不受
// 「跨網域 importScripts 會失敗」那條限制（sherpa 的資產在 HF 上才需要 blob: URL）。
//
// 訊息協定
//   main → worker
//     { type:'load', wasmUrl, model: ArrayBuffer }        （model 以 transferable 傳）
//     { type:'transcribe', id, audio: Float32Array, language }  （audio 以 transferable 傳）
//   worker → main
//     { type:'ready', models }
//     { type:'result', id, text, language, words, ttftMs, decodeTps, ms }
//     { type:'error', phase, message }
//
// 為什麼 wasmUrl 要由主執行緒傳、而且在 Worker 裡自己 fetch 成 wasmBinary：
// 這份 needle.js 建置**沒有** Module.locateFile 這個入口（整支膠水層只有一個
// `function locateFile(path){return scriptDirectory+path}`，scriptDirectory 在 Worker 裡
// 取自 `self.location.href`，也就是站台根目錄），所以它會去抓 `<站台根>/needle.wasm`。
// 那個路徑不存在時，伺服器回的是 HTML，症狀是啟動時的
// `Aborted(CompileError: ... expected magic word 00 61 73 6d, found 3c 21 44 4f)` ——
// 3c 21 44 4f 就是 `<!DO`（DOCTYPE）。傳 wasmBinary 讓它完全不碰路徑推導。

let module = null;
let ready = false;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const reason = error => String((error && error.message) || error);

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === 'load') {
    try {
      importScripts('./needle/needle.js');       // 定義 createNeedle
      importScripts('./whistle-engine.js');      // 定義 WhistleEngine（與主執行緒退路共用同一份）
      const factory = self.createNeedle;
      if (typeof factory !== 'function') throw new Error('createNeedle 未定義（膠水層沒載入成功）');
      if (!self.WhistleEngine) throw new Error('WhistleEngine 未定義（whistle-engine.js 沒載入成功）');

      // wasm 位元組由這裡抓（同源，Service Worker 會以 cache-first 供給），
      // 再以 wasmBinary 交給引擎 —— 見檔頭對 locateFile 的說明
      const wasm = await fetch(msg.wasmUrl).then((response) => {
        if (!response.ok) throw new Error(`needle.wasm HTTP ${response.status}`);
        return response.arrayBuffer();
      });
      module = await factory({ wasmBinary: wasm });
      const models = self.WhistleEngine.loadModel(module, msg.model);
      ready = true;
      post({ type: 'ready', models: models });
    } catch (error) {
      module = null;
      ready = false;
      post({ type: 'error', phase: 'load', message: reason(error) });
    }
    return;
  }

  if (msg.type === 'transcribe') {
    if (!ready || !module) {
      post({ type: 'error', phase: 'transcribe', message: '模型尚未載入' });
      return;
    }
    try {
      const output = self.WhistleEngine.transcribe(module, msg.audio, msg.language || null);
      post({ type: 'result', id: msg.id, ...output });
    } catch (error) {
      post({ type: 'error', phase: 'transcribe', id: msg.id, message: reason(error) });
    }
    return;
  }
};
