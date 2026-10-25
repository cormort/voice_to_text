// Whistle（Cactus Compute 的 needle 引擎）—— 模型下載、worker 膠水與推論。
//
// 原本散在 src/app.js（loadWhistle／fetchWhistleModel／ensureWhistleWorker…），
// 2026-10 依 Phase 2 收斂搬進來：引擎自己負責「怎麼把模型弄到手、怎麼推論」，
// app.js 只留 UI 接線。排隊／啟停／量測仍由 src/engines/batch.js 提供。

import { createBatchPipeline } from './batch.js';

/**
 * @param {object} ctx el / t / showToast / loadScript / downloadInChunks / syncModelButtons
 *                     （再加 batch pipeline 需要的 el/state/commit/AudioCapture 等）
 */
export function createWhistleEngine(ctx) {
  const { el, t, showToast, loadScript, downloadInChunks, syncModelButtons } = ctx;

  // Worker 與請求配對表（原本是 app.js 的模組層變數，跟著函式一起搬進來）
  let whistleWorker = null;
  let whistleWorkerSeq = 0;
  const whistleWorkerPending = new Map();


const WHISTLE_MODEL_URL = 'https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact';

const WHISTLE_GLUE = 'needle/needle.js';

const WHISTLE_WASM = new URL('needle/needle.wasm', document.baseURI).href;

const WHISTLE_CACHE = 'whistle-model-v1';

const WHISTLE_LANGS = {
  'en-US': 'en', 'en-GB': 'en', 'es-ES': 'es', 'fr-FR': 'fr', 'de-DE': 'de'
};

const WHISTLE_SEGMENT_SECONDS = 10;

const WHISTLE_MAX_QUEUED = 3;

const whistle = {
  module: null, loaded: false, loadPromise: null, url: null, workerMode: false
};

function ensureWhistleWorker() {
  if (whistleWorker) return whistleWorker;
  try {
    whistleWorker = new Worker('whistle-worker.js');   // classic worker：worker 內用 importScripts
  } catch (error) {
    console.warn('Whistle worker unavailable; falling back to the main thread:', error);
    whistleWorker = null;
    return null;
  }
  whistleWorker.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.type === 'error') {
      console.warn('[whistle-worker]', msg.phase, msg.message);
      const waiting = msg.id != null ? whistleWorkerPending.get(msg.id) : null;
      if (waiting) {
        whistleWorkerPending.delete(msg.id);
        waiting.reject(Object.assign(new Error(msg.message), { phase: msg.phase }));
      } else if (msg.id == null) {
        // 沒有 id 的錯誤只會是 load 階段（見 whistle-worker.js）→ 收掉等待者，
        // 讓 loadWhistle 能接手走主執行緒退路
        for (const [, p] of whistleWorkerPending) p.reject(Object.assign(new Error(msg.message), { phase: msg.phase }));
        whistleWorkerPending.clear();
      }
      return;
    }
    const pending = whistleWorkerPending.get(msg.type === 'ready' ? 'load' : msg.id);
    if (pending) {
      whistleWorkerPending.delete(msg.type === 'ready' ? 'load' : msg.id);
      pending.resolve(msg);
    }
  };
  whistleWorker.onerror = (event) => {
    console.warn('Whistle worker crashed:', event.message || event);
    for (const [, p] of whistleWorkerPending) p.reject(new Error(event.message || 'worker crash'));
    whistleWorkerPending.clear();
    try { whistleWorker.terminate(); } catch (error) { /* 已經死了 */ }
    whistleWorker = null;
    // Worker 死了 = 那份模型也沒了；不清掉 loaded 的話 UI 會一直寫「已就緒」
    if (whistle.workerMode) {
      whistle.workerMode = false;
      whistle.loaded = false;
      el.whistleStatus.textContent = t().loadFailed + (event.message || 'worker crash');
      el.whistleStatus.className = 'model-status error';
      syncModelButtons();
    }
  };
  return whistleWorker;
}

function whistleWorkerRequest(payload, transfer) {
  const worker = ensureWhistleWorker();
  if (!worker) return Promise.reject(new Error('worker unavailable'));
  const key = payload.id || 'load';
  return new Promise((resolve, reject) => {
    whistleWorkerPending.set(key, { resolve, reject });
    try {
      worker.postMessage(payload, transfer || []);
    } catch (error) {
      whistleWorkerPending.delete(key);
      reject(error);
    }
  });
}

function setWhistleProgress(loaded, total) {
  const mb = n => (n / 1048576).toFixed(1);
  if (total) {
    el.whistleBar.classList.remove('indeterminate');
    el.whistleBar.style.width = `${(loaded / total * 100).toFixed(1)}%`;
    el.whistleStatus.textContent =
      `${t().whistleDownloading} ${mb(loaded)} / ${mb(total)} MB（${(loaded / total * 100).toFixed(1)}%）`;
  } else {
    el.whistleStatus.textContent = `${t().whistleDownloading} ${mb(loaded)} MB`;
  }
}

async function fetchWhistleModel(url) {
  let cache = null;
  try {
    cache = await caches.open(WHISTLE_CACHE);
  } catch (error) {
    console.warn('Cache Storage unavailable:', error);
  }

  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      el.whistleStatus.textContent = t().whistleFromCache;
      el.whistleBar.classList.remove('indeterminate');
      el.whistleBar.style.width = '100%';
      return hit.arrayBuffer();
    }
  }

  const bytes = await downloadInChunks(url, setWhistleProgress);

  if (cache) {
    try {
      await cache.put(url, new Response(bytes, {
        headers: { 'Content-Type': 'application/octet-stream' }
      }));
    } catch (error) {
      console.warn('Caching the Whistle model failed:', error);
      showToast(t().whistleCacheFailed);
    }
  }

  return bytes.buffer;
}

async function clearWhistleCache() {
  if (whistleEngine.isBusy()) {
    showToast(t().busyClear);
    return;
  }
  try {
    const deleted = await caches.delete(WHISTLE_CACHE);
    // 與 sherpa 的清除鈕一致：只清快取，不動已經載入記憶體的模型 ——
    // 這次仍可繼續用，重新整理頁面後才會重新下載。
    el.whistleStatus.textContent = deleted ? t().whistleCacheCleared : t().whistleCacheEmpty;
    el.whistleStatus.className = 'model-status';
    el.whistleBar.style.width = '0';
  } catch (error) {
    console.error('Clearing the Whistle cache failed:', error);
    showToast(t().whistleCacheFailed);
  }
}

async function loadWhistle() {
  if (whistle.loadPromise) return whistle.loadPromise;

  const url = el.whistleUrl.value.trim();
  if (!url) {
    el.whistleStatus.textContent = t().whistleNoUrl;
    el.whistleStatus.className = 'model-status error';
    return;
  }
  if (whistle.loaded) {
    if (whistle.url !== url) {
      el.whistleStatus.textContent = t().sourceChanged;
      el.whistleStatus.className = 'model-status error';
      return;
    }
    el.whistleStatus.textContent = t().loaded;
    el.whistleStatus.className = 'model-status success';
    return;
  }

  whistle.loadPromise = (async () => {
    el.loadWhistle.disabled = true;
    el.whistleProgress.classList.add('visible');
    el.whistleBar.classList.add('indeterminate');
    el.whistleStatus.textContent = t().whistleLoading;
    el.whistleStatus.className = 'model-status';

    try {
      // 首選：Worker。16.9 MB 的下載與快取留在主執行緒（進度條不變），
      // 位元組用 transferable 交進去。
      if (ensureWhistleWorker()) {
        try {
          const model = await fetchWhistleModel(url);
          el.whistleStatus.textContent = t().whistleLoading;
          const ready = await whistleWorkerRequest(
            { type: 'load', wasmUrl: WHISTLE_WASM, model }, [model]);
          whistle.workerMode = true;
          whistle.module = null;
          whistle.loaded = true;
          whistle.url = url;
          el.whistleStatus.textContent = `${t().loaded}（WASM / CPU）`;
          el.whistleStatus.className = 'model-status success';
          if (ready.models !== 2) console.warn('Whistle 載入的不是語音模型（needle_models =', ready.models, '）');
          return;
        } catch (workerError) {
          // Worker 建得起來不代表它載得動（CSP、舊瀏覽器、wasm 檔缺失）。沒有這層退路，
          // 這些情況會直接判整個引擎死亡，而主執行緒其實還有機會成功。
          console.warn('Whistle worker path failed; falling back to the main thread:', workerError);
          ctx.warnings?.report('whistle', 'fallback', String((workerError && workerError.message) || workerError));
          try { whistleWorker?.terminate(); } catch (error) { /* 已經死了 */ }
          whistleWorker = null;
          whistleWorkerPending.clear();
          whistle.workerMode = false;
          el.whistleBar.classList.add('indeterminate');
          el.whistleBar.style.width = '';
        }
      }

      // 後備：主執行緒。上面的 model 位元組已經 transfer 給死掉的 worker（detached），
      // 所以這裡要重新取一份 —— 有快取時就是快取命中，不會重抓 16.9 MB。
      await loadScript('whistle-engine.js', 'WhistleEngine');
      await loadScript(WHISTLE_GLUE, 'createNeedle');
      // wasm 也用 wasmBinary 直接餵：這份 needle.js 沒有 Module.locateFile 入口，
      // 主執行緒只是「剛好」因為膠水層就在 needle/ 目錄下才抓對路徑（換路徑就會壞）
      const wasm = await fetch(WHISTLE_WASM).then(response => {
        if (!response.ok) throw new Error(`needle.wasm HTTP ${response.status}`);
        return response.arrayBuffer();
      });
      whistle.module = await window.createNeedle({ wasmBinary: wasm });
      const model = await fetchWhistleModel(url);
      el.whistleStatus.textContent = t().whistleLoading;
      window.WhistleEngine.loadModel(whistle.module, model);
      whistle.loaded = true;
      whistle.url = url;
      el.whistleStatus.textContent = `${t().loaded}（主執行緒）`;
      el.whistleStatus.className = 'model-status success';
    } catch (error) {
      console.error('Whistle load failed:', error);
      whistle.loaded = false;
      whistle.module = null;
      el.whistleStatus.textContent = t().loadFailed + (error.message || error);
      el.whistleStatus.className = 'model-status error';
    } finally {
      el.whistleBar.classList.remove('indeterminate');
      el.whistleBar.style.width = whistle.loaded ? '100%' : '0';
      el.loadWhistle.disabled = false;
      syncModelButtons();
    }
  })();

  try {
    await whistle.loadPromise;
  } finally {
    whistle.loadPromise = null;
  }
}

function whistleLanguage() {
  // 七種語言之外的選擇一律自動偵測（送 'zh' 不是猜錯，是引擎不存在的代碼）
  return WHISTLE_LANGS[el.lang.value] || null;
}

async function whistleTranscribe(audio, language) {
  if (whistle.workerMode) {
    const id = ++whistleWorkerSeq;
    const copy = audio.slice();
    const result = await whistleWorkerRequest(
      { type: 'transcribe', id, audio: copy, language }, [copy.buffer]);
    return result;
  }
  return window.WhistleEngine.transcribe(whistle.module, audio, language);
}

  const pipeline = createBatchPipeline(ctx, {
    id: 'whistle',
    role: 'refine',
    runtime: whistle,
    segmentSeconds: WHISTLE_SEGMENT_SECONDS,
    maxQueued: WHISTLE_MAX_QUEUED,
    queueFullMessage: () => t().whistleQueueFull,
    canStart: () => whistle.loaded && (whistle.workerMode || !!whistle.module),
    describe: () => ({ language: whistleLanguage() }),
    transcribe: async job => (await whistleTranscribe(job.audio, job.language))?.text || '',
    onInferenceError: error => showToast(t().whistleFailed + (error.message || error)),
  });

  return {
    ...pipeline,
    load: loadWhistle,                       // 載入模型（重複呼叫會回同一個 promise）
    clearCache: clearWhistleCache,           // 只清快取，不動已載入的記憶體版本
    isReady: () => whistle.loaded && whistle.url === el.whistleUrl.value.trim(),
    currentUrl: () => whistle.url,
  };
}
