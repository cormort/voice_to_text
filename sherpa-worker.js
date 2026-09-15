// sherpa-onnx 推論 Worker —— 把串流 ASR 的解碼移出主執行緒。
//
// 為什麼要這支：index.html 原本的註解就寫了「單執行緒同步解碼；若在低階機器上卡住 UI，
// 再搬進 Worker」。用 test_speech_perf.js 實測（真實中文語音、15 秒串流）：
//   44 個長任務、最長 111 ms、總計 2,834 ms（占 18.9% 時間）、主執行緒 heap 215 MB
// 111 ms 的任務會有肉眼可見的掉幀，所以條件成立。
//
// 設計取捨：**190 MB 的 .data 下載與快取留在主執行緒**（沿用原本的 fetchSherpaPackage，
// 進度條與 Cache Storage 行為完全不變），下載完的 ArrayBuffer 用 transferable 交進來
// （零拷貝）。Worker 只負責 importScripts 兩支膠水層、用 getPreloadedPackage 把位元組
// 餵給 emscripten，以及之後的 acceptWaveform/decode。
//
// 訊息協定
//   main → worker
//     { type:'load', dir, glueUrls:[string,string], package:ArrayBuffer, sampleRate }
//       （package 以 transferable 傳；glueUrls 是頁面抓下來後建立的 Blob URL）
//     { type:'start', sessionId }
//     { type:'feed', sessionId, audio:Float32Array }          （audio 以 transferable 傳）
//     { type:'flush', sessionId }                             （補靜音收尾並回傳最後結果）
//     { type:'free' }
//   worker → main
//     { type:'ready' } | { type:'status', status }
//     { type:'result', sessionId, text, endpoint }
//     { type:'final', sessionId, text }
//     { type:'error', phase, message }

let module = null;
let recognizer = null;
let stream = null;
let baseDir = null;
let sampleRate = 16000;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
// 取目前結果。**必須把 stream 傳進去**：官方膠水層的簽名是 getResult(stream)，
// 它會讀 stream.handle（`_SherpaOnnxGetOnlineStreamResultAsJson(this.handle, stream.handle)`），
// 不帶參數就是每個音訊塊都丟 TypeError，而主執行緒對 feed 階段的 error 訊息沒有處理器
// （只認 ready/final/started），所以錯誤完全靜默 —— 症狀就是「音量 bar 有動、字幕永遠不出來」。
const textOf = (recognizer, stream) => String(recognizer?.getResult?.(stream)?.text || '').trim();

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === 'load') {
    baseDir = msg.dir;
    sampleRate = msg.sampleRate || 16000;
    try {
      // 為什麼用 Blob URL 而不是直接 importScripts(HF 網址)：
      // 跨網域的 importScripts 會失敗（實測 Failed to execute 'importScripts' …
      // failed to load），而 `<script src>` 可以 —— 兩者對 CORS/MIME 的要求不同。
      // 由頁面 fetch 成文字、建立 blob: URL 再 importScripts，blob: 已在 CSP 允許清單內，
      // 也不必要求 HF 回傳特定的 Content-Type 或 CORS 標頭。
      importScripts((msg.glueUrls || [])[0]);              // 定義 createOnlineRecognizer

      const packageData = msg.package;
      const ready = new Promise((resolve, reject) => {
        self.Module = {
          locateFile: (path) => baseDir + path,
          getPreloadedPackage: () => packageData,
          setStatus: (status) => { if (status) post({ type: 'status', status }); },
          onRuntimeInitialized: () => resolve(self.Module),
          onAbort: (reason) => reject(new Error(String(reason)))
        };
      });

      importScripts((msg.glueUrls || [])[1]);              // emscripten 主模組
      module = await ready;
      recognizer = self.createOnlineRecognizer(module);
      post({ type: 'ready' });
    } catch (error) {
      module = null; recognizer = null; stream = null;
      post({ type: 'error', phase: 'load', message: String(error && error.message || error) });
    }
    return;
  }

  if (msg.type === 'start') {
    try {
      stream = recognizer.createStream();
      // 明確回報「已就緒」，主執行緒才知道可以開始餵音。
      // 型別必須與 result 分開 —— 主執行緒的等待器只認 ready/final/started，
      // 若這裡回 result，start 的 promise 永遠不會 resolve（實測麥克風因此從未啟動）。
      post({ type: 'started', sessionId: msg.sessionId });
    } catch (error) {
      post({ type: 'error', phase: 'start', message: String(error && error.message || error) });
    }
    return;
  }

  if (msg.type === 'feed') {
    // 刻意保持同步：Worker 的訊息依序處理，這樣 acceptWaveform 的順序與音訊順序一致
    if (!recognizer || !stream) return;
    try {
      stream.acceptWaveform(sampleRate, msg.audio);
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      let text = textOf(recognizer, stream);
      let endpoint = false;
      if (recognizer.isEndpoint(stream)) {
        endpoint = true;
        recognizer.reset(stream);
      }
      if (text || endpoint) post({ type: 'result', sessionId: msg.sessionId, text, endpoint });
    } catch (error) {
      post({ type: 'error', phase: 'feed', message: String(error && error.message || error) });
    }
    return;
  }

  if (msg.type === 'flush') {
    if (!recognizer || !stream) { post({ type: 'final', sessionId: msg.sessionId, text: '' }); return; }
    try {
      // 補 0.4 秒靜音，讓模型吐出最後一段尚未收尾的語音（與原本 stopSherpa 一致）
      stream.acceptWaveform(sampleRate, new Float32Array(Math.round(sampleRate * 0.4)));
      stream.inputFinished();
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      post({ type: 'final', sessionId: msg.sessionId, text: textOf(recognizer, stream) });
    } catch (error) {
      post({ type: 'error', phase: 'flush', message: String(error && error.message || error) });
      post({ type: 'final', sessionId: msg.sessionId, text: '' });
    }
    return;
  }

  if (msg.type === 'free') {
    try { stream?.free(); } catch (error) { console.warn('[sherpa-worker] stream free failed:', error); }
    stream = null;
    post({ type: 'freed' });
  }
};
