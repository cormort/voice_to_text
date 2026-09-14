// Whisper 推論 Worker —— 把 transformers.js 的 pipeline 移出主執行緒。
//
// 為什麼要這支：原本 pipeline 直接在主執行緒跑，實測（Chrome、WASM 後端、
// chunk_length_s: 15）單一 chunk 會阻塞主執行緒 **12,295 ms**、占 25 秒串流的 49.6%
// —— 整頁凍結、按鈕沒反應、逐字稿當下不會更新。搬到 Worker 之後，主執行緒只剩
// 訊息搬運與繪製，凍結消失（音訊用 transferable 傳，零拷貝）。
//
// 這裡刻意重現 index.html 原本處理過的三個坑（都是實際踩過的）：
//   1. transformers.js 4.2.0 會把「WebGPU 失敗」記在模組實例裡，之後同一份實例連
//      WASM 都載不起來 → 退路必須用不同的 query string 取一份全新實例。
//   2. WASM 上 q8 的 decoder 量化會崩（Missing required scale）→ 退路固定用 q4。
//   3. WebGPU 要先確認真的拿得到 adapter 才值得試（失敗那一次會毒化模組）。
// 差別只在於：這些判斷現在跑在 Worker 裡，UI 不會被牽連。
//
// 訊息協定（主執行緒 → Worker）
//   { type:'load', libUrl, model, preferWebGpu }
//   { type:'transcribe', id, audio:Float32Array, language, chunkLength, stride }
//   { type:'dispose', id }
// Worker → 主執行緒
//   { type:'progress', pct, file, loaded, total } | { type:'progress', status, file }
//   { type:'ready', device, model, cached? }
//   { type:'result', id, text }
//   { type:'error', id, phase, message, deviceLost? }
//   { type:'disposed', id }

let pipe = null;
let moduleRef = null;
let device = null;
let model = null;
let libUrl = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function loadModule(fresh) {
  // fresh=true → 不同 query string = 另一份模組實例（見上方坑 1）
  const mod = await import(fresh ? `${libUrl}?fallback=1` : libUrl);
  mod.env.allowLocalModels = false;
  mod.env.useBrowserCache = true;
  return mod;
}

async function hasWebGpuAdapter() {
  if (!self.navigator?.gpu) return false;
  try {
    return !!(await self.navigator.gpu.requestAdapter());
  } catch (error) {
    console.warn('[whisper-worker] WebGPU adapter probe failed:', error);
    return false;
  }
}

async function disposePipe(target) {
  if (!target || typeof target.dispose !== 'function') return;
  try {
    await target.dispose();
  } catch (error) {
    console.warn('[whisper-worker] pipeline disposal failed:', error);
  }
}

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === 'load') {
    libUrl = msg.libUrl;
    try {
      const tLoad = Date.now();
      moduleRef ||= await loadModule(false);
      console.log('[whisper-worker] transformers 模組就緒');

      if (pipe && model === msg.model) {
        post({ type: 'ready', id: msg.id, device, model, cached: true });
        return;
      }

      const previous = pipe;
      pipe = null; device = null; model = null;
      await disposePipe(previous);

      // transformers.js 的下載進度：pct 給 UI 用真的百分比（原本只有 indeterminate）
      const progress_callback = (p) => {
        if (!p) return;
        if (p.status === 'progress' && p.total) {
          post({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total,
                 pct: Math.round((p.loaded / p.total) * 100) });
        } else if (p.status) {
          post({ type: 'progress', status: p.status, file: p.file });
        }
      };

      let candidate = null;
      let candidateDevice = null;

      if (msg.preferWebGpu && (await hasWebGpuAdapter())) {
        try {
          candidate = await moduleRef.pipeline('automatic-speech-recognition', msg.model,
            { device: 'webgpu', dtype: 'q4', progress_callback });
          candidateDevice = 'WebGPU';
        } catch (error) {
          console.warn('[whisper-worker] WebGPU pipeline failed; falling back to WASM:', error);
          moduleRef = await loadModule(true);   // 換一份乾淨的實例（坑 1）
        }
      }

      if (!candidate) {
        candidate = await moduleRef.pipeline('automatic-speech-recognition', msg.model,
          { device: 'wasm', dtype: 'q4', progress_callback });   // q4（坑 2）
        candidateDevice = 'WASM';
      }

      pipe = candidate;
      device = candidateDevice;
      model = msg.model;
      console.log(`[whisper-worker] pipeline 就緒：${device}（${Date.now() - tLoad} ms）`);
      post({ type: 'ready', id: msg.id, device, model });
    } catch (error) {
      pipe = null; device = null; model = null;
      post({ type: 'error', id: msg.id, phase: 'load', message: String(error?.message || error) });
    }
    return;
  }

  if (msg.type === 'transcribe') {
    if (!pipe) {
      post({ type: 'error', id: msg.id, phase: 'transcribe', message: 'pipeline not loaded' });
      return;
    }
    try {
      // msg.audio 是 transferable 過來的 Float32Array（零拷貝）
      const output = await pipe(msg.audio, {
        language: msg.language,
        task: 'transcribe',
        chunk_length_s: msg.chunkLength ?? 15,
        stride_length_s: msg.stride ?? 2
      });
      post({ type: 'result', id: msg.id, text: String(output?.text || '').trim() });
    } catch (error) {
      const message = String(error?.message || error);
      post({ type: 'error', id: msg.id, phase: 'transcribe', message,
             deviceLost: /device lost|webgpu|oom/i.test(message) });
    }
    return;
  }

  if (msg.type === 'dispose') {
    const previous = pipe;
    pipe = null; device = null; model = null;
    await disposePipe(previous);
    post({ type: 'disposed', id: msg.id });
  }
};
