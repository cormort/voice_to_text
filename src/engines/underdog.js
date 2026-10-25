// Underdog Bark 3.0（Conway Research 的 parakeet-TDT 英文微調）—— 模型下載與推論。
//
// 原本散在 src/app.js（loadUnderdog／ensureUnderdogWorker／setUnderdogProgress…），
// 2026-10 依 Phase 2 收斂搬進來。推論本身在 underdog-worker.js（onnxruntime-web +
// 431 MB 外部權重），這裡只負責「把模型弄到手、把 worker 叫起來、把音訊送進去」。
// 排隊／啟停／量測由 src/engines/batch.js 提供。

import { createBatchPipeline } from './batch.js';
import { opfsStore, opfsAvailable } from '../opfs.js';
import { createWarningSink, exposeWarnings } from '../engine-warnings.js';

/**
 * @param {object} ctx el / t / showToast / syncModelButtons（＋ batch pipeline 需要的其餘成員）
 */
export function createUnderdogEngine(ctx) {
  const { el, t, showToast, syncModelButtons } = ctx;

  // worker 的失敗理由不再只進 console：同一階段一分鐘內彈一次、帶原始訊息，
  // 並全部寫進 window.__engineWarnings（診斷頁／自動化測試讀得到）。
  const warnings = exposeWarnings(createWarningSink({ showToast, label: () => t().engineWarn }));


const UNDERDOG_DEFAULT_BASE = 'https://huggingface.co/ai-ecoverse/Underdog-Bark-3.0-ONNX/resolve/main/';

const UNDERDOG_CACHE = 'underdog-model-v1';

const UNDERDOG_SEGMENT_SECONDS = 15;

const UNDERDOG_MAX_QUEUED = 2;

const underdog = {
  loaded: false, loadPromise: null, base: null, variant: null
};

let underdogWorker = null;

let underdogSeq = 0;

const underdogPending = new Map();

function ensureUnderdogWorker() {
  if (underdogWorker) return underdogWorker;
  try {
    // module worker：worker 內部以 ESM import 載入 onnxruntime-web（jsdelivr）與 underdog/*
    underdogWorker = new Worker('underdog-worker.js', { type: 'module' });
  } catch (error) {
    console.warn('Underdog worker unavailable:', error);
    underdogWorker = null;
    return null;
  }
  underdogWorker.onmessage = event => {
    const msg = event.data || {};
    if (msg.type === 'progress') {
      setUnderdogProgress(msg);
      return;
    }
    if (msg.type === 'warn') {
      // 例：cache 寫入失敗、OPFS 續傳中止 —— 這些都不影響本次可用性，但一定要看得到
      warnings.report('underdog', msg.phase, msg.message);
      if (msg.phase === 'cache' || msg.phase === 'opfs') {
        el.underdogStatus.textContent = `${t().underdogStorageWarn}（${msg.phase}）`;
        el.underdogStatus.className = 'model-status error';
      }
      return;
    }
    const key = msg.type === 'ready' ? 'load' : msg.id;
    const pending = underdogPending.get(key);
    if (!pending) return;
    underdogPending.delete(key);
    if (msg.type === 'error') pending.reject(Object.assign(new Error(msg.message), { phase: msg.phase }));
    else pending.resolve(msg);
  };
  underdogWorker.onerror = event => {
    console.warn('Underdog worker crashed:', event.message || event);
    for (const [, p] of underdogPending) p.reject(new Error(event.message || 'worker crash'));
    underdogPending.clear();
    try { underdogWorker.terminate(); } catch (error) { /* 已經死了 */ }
    underdogWorker = null;
    if (underdog.loaded) {
      underdog.loaded = false;
      el.underdogStatus.textContent = t().loadFailed + (event.message || 'worker crash');
      el.underdogStatus.className = 'model-status error';
      syncModelButtons();
    }
  };
  return underdogWorker;
}

function underdogRequest(payload, transfer) {
  const worker = ensureUnderdogWorker();
  if (!worker) return Promise.reject(new Error('worker unavailable'));
  const key = payload.type === 'load' ? 'load' : payload.id;
  return new Promise((resolve, reject) => {
    underdogPending.set(key, { resolve, reject });
    try {
      worker.postMessage(payload, transfer || []);
    } catch (error) {
      underdogPending.delete(key);
      reject(error);
    }
  });
}

function setUnderdogProgress(msg) {
  const mb = n => (n / 1048576).toFixed(1);
  if (msg.cached) {
    el.underdogBar.classList.remove('indeterminate');
    el.underdogBar.style.width = '100%';
    el.underdogStatus.textContent = `${t().underdogFromCache}（${msg.label}）`;
    return;
  }
  if (msg.phase === 'init') {
    el.underdogBar.classList.add('indeterminate');
    el.underdogStatus.textContent = `${t().underdogInit}（${msg.label}）`;
    return;
  }
  el.underdogBar.classList.remove('indeterminate');
  if (msg.total) {
    el.underdogBar.style.width = `${(msg.loaded / msg.total * 100).toFixed(1)}%`;
    el.underdogStatus.textContent =
      `${t().underdogDownloading} ${msg.label} ${mb(msg.loaded)} / ${mb(msg.total)} MB（${(msg.loaded / msg.total * 100).toFixed(1)}%）`;
  } else {
    el.underdogStatus.textContent = `${t().underdogDownloading} ${msg.label} ${mb(msg.loaded)} MB`;
  }
}

async function clearUnderdogCache() {
  if (underdogEngine.isBusy()) {
    showToast(t().busyClear);
    return;
  }
  // v17 起 431.9 MB 的權重存在 OPFS（可續傳），清快取時一定要一起清，
  // 否則使用者以為清掉了、空間卻還在。
  let opfsDeleted = 0;
  if (await opfsAvailable()) {
    for (const entry of await opfsStore.list()) {
      if (!entry.key.startsWith('underdog/')) continue;
      if (await opfsStore.remove(entry.key)) opfsDeleted += 1;
    }
  }
  try {
    const deleted = (await caches.delete(UNDERDOG_CACHE)) || opfsDeleted > 0;
    el.underdogStatus.textContent = deleted ? t().underdogCacheCleared : t().underdogCacheEmpty;
    el.underdogStatus.className = 'model-status';
    el.underdogBar.style.width = '0';
  } catch (error) {
    console.error('Clearing the Underdog cache failed:', error);
    showToast(t().underdogCacheFailed);
  }
}

function underdogBaseResolved() {
  try {
    const raw = el.underdogBase.value.trim();
    if (!raw) return null;
    return new URL(raw.endsWith('/') ? raw : `${raw}/`, document.baseURI).href;
  } catch (error) {
    return null;
  }
}

async function loadUnderdog() {
  if (underdog.loadPromise) return underdog.loadPromise;

  const base = underdogBaseResolved();
  if (!base) {
    el.underdogStatus.textContent = t().underdogNoBase;
    el.underdogStatus.className = 'model-status error';
    return;
  }
  const variant = el.underdogVariant.value;
  if (underdog.loaded && underdog.base === base && underdog.variant === variant) {
    el.underdogStatus.textContent = `${t().loaded}（WASM / CPU）`;
    el.underdogStatus.className = 'model-status success';
    return;
  }

  underdog.loadPromise = (async () => {
    el.loadUnderdog.disabled = true;
    el.underdogProgress.classList.add('visible');
    el.underdogBar.classList.add('indeterminate');
    el.underdogBar.style.width = '';
    el.underdogStatus.textContent = t().underdogLoading;
    el.underdogStatus.className = 'model-status';

    try {
      const ready = await underdogRequest({ type: 'load', baseUrl: base, variant });
      underdog.loaded = true;
      underdog.base = base;
      underdog.variant = variant;
      el.underdogStatus.textContent = `${t().loaded}（WASM / CPU，${((ready.ms || 0) / 1000).toFixed(1)} s）`;
      el.underdogStatus.className = 'model-status success';
    } catch (error) {
      console.error('Underdog load failed:', error);
      underdog.loaded = false;
      el.underdogStatus.textContent = t().loadFailed + (error.message || error);
      el.underdogStatus.className = 'model-status error';
    } finally {
      el.underdogBar.classList.remove('indeterminate');
      el.underdogBar.style.width = underdog.loaded ? '100%' : '0';
      el.loadUnderdog.disabled = false;
      syncModelButtons();
    }
  })();

  try {
    await underdog.loadPromise;
  } finally {
    underdog.loadPromise = null;
  }
}

async function underdogTranscribe(audio) {
  const id = ++underdogSeq;
  const copy = audio.slice();
  return underdogRequest({ type: 'transcribe', id, audio: copy }, [copy.buffer]);
}

  const pipeline = createBatchPipeline(ctx, {
    id: 'underdog',
    role: 'refine',
    runtime: underdog,
    segmentSeconds: UNDERDOG_SEGMENT_SECONDS,
    maxQueued: UNDERDOG_MAX_QUEUED,
    queueFullMessage: () => t().underdogQueueFull,
    canStart: () => underdog.loaded,
    transcribe: async job => (await underdogTranscribe(job.audio))?.text || '',
    onInferenceError: error => showToast(t().underdogFailed + (error.message || error)),
  });

  return {
    ...pipeline,
    load: loadUnderdog,                 // 載入模型（重複呼叫會回同一個 promise）
    clearCache: clearUnderdogCache,     // 只清 Cache Storage，不動已載入的 session
    isReady: () => underdog.loaded && underdog.base === underdogBaseResolved() && underdog.variant === el.underdogVariant.value,
    baseResolved: underdogBaseResolved,
    /** 給「來源／精度已變更」提示用的唯讀快照 */
    state: () => ({ loaded: underdog.loaded, base: underdog.base, variant: underdog.variant }),
  };
}
