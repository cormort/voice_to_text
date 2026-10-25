// Underdog Bark 3.0（Conway Research，英文 parakeet-tdt-0.6b-v3 微調）的瀏覽器推論 worker。
//
// 這顆模型不是 sherpa 的 transducer 介面（encoder 輸出 640 維、decoder_joint 帶
// state_h/state_c 與 5 個 duration logits），所以借不到既有的 sherpa 管線，這裡自己走
// onnxruntime-web：mel 前處理 → encoder → 貪心 TDT 解碼 → SentencePiece 還原。
//
// 執行環境的取捨（都實測過）：
//   * WebGPU：這份 q4f16 圖在 ORT 1.30 的 WebGPU EP 會建出無效的 compute pipeline
//     （Add/Cast/Sigmoid 全部失敗、encoder_lengths 回 0），只有 WASM EP 可用。
//   * 多執行緒 WASM 需要 crossOriginIsolated（COOP/COEP 標頭），GitHub Pages 給不了，
//     所以固定 numThreads = 1。實測 encoder 對 2.67 秒音訊約 3.2 秒（RTF 1.19）；
//     同機 4 執行緒是 1.6 秒（RTF 0.60），值得但不合本站的部署條件。
//
// 下載量：q4f16 = encoder graph 1.2 MB + encoder 權重 432 MB + decoder_joint 66 MB
//         （＋ tokenizer.json 1.1 MB），全部存進 Cache Storage（UNDERDOG_CACHE）。
'use strict';

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.mjs';
import { makeFrontend } from './underdog/frontend.js';
import { greedyTdt, detokenize, piecesFromTokenizer, checkShapes } from './underdog/tdt.js';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';

const CACHE = 'underdog-model-v1';

const state = {
  base: null, variant: null,
  encSession: null, decSession: null,
  extract: null, pieces: null,
  ffmpegHint: '',
};

let chain = Promise.resolve();          // 轉寫序列化：ORT session 不保證併發安全

function send(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function fail(id, phase, error) {
  send({ type: 'error', id, phase, message: String((error && error.message) || error) });
}

async function openCache() {
  try {
    return await caches.open(CACHE);
  } catch (error) {
    return null;
  }
}

// 從 Cache Storage 拿；沒有就下載（含位元組級進度），成功才寫回快取。
async function fetchBytes(url, cache, onProgress, label) {
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      onProgress({ label, loaded: buf.byteLength, total: buf.byteLength, cached: true });
      return new Uint8Array(buf);
    }
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}（${url}）`);
  const total = Number(response.headers.get('content-length') || 0);

  let bytes;
  if (!response.body) {
    bytes = new Uint8Array(await response.arrayBuffer());
    onProgress({ label, loaded: bytes.length, total: bytes.length || bytes.length, cached: false });
  } else {
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0, lastPost = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      const now = performance.now();
      if (now - lastPost > 200) {
        lastPost = now;
        onProgress({ label, loaded, total, cached: false });
      }
    }
    onProgress({ label, loaded, total: total || loaded, cached: false });
    bytes = new Uint8Array(loaded);
    let off = 0;
    for (const chunk of chunks) { bytes.set(chunk, off); off += chunk.length; }
  }

  if (cache) {
    try {
      await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch (error) {
      send({ type: 'warn', phase: 'cache', message: String(error && error.message || error) });
    }
  }
  return bytes;
}

async function load(base, variant, id) {
  const dir = new URL(base.endsWith('/') ? base : base + '/', self.location.href).href;
  const cache = await openCache();
  const t0 = performance.now();

  const step = (label, loaded, total, cached) =>
    send({ type: 'progress', id, phase: 'download', label, loaded, total, cached });

  // 1) 前處理參數與 tokenizer（小檔，先抓才知道後面要幾個 mel）
  const ppBytes = await fetchBytes(`${dir}preprocessor_config.json`, cache, p => step('preprocessor_config.json', p.loaded, p.total, p.cached));
  const pp = JSON.parse(new TextDecoder().decode(ppBytes));
  const tokBytes = await fetchBytes(`${dir}tokenizer.json`, cache, p => step('tokenizer.json', p.loaded, p.total, p.cached));
  const pieces = piecesFromTokenizer(JSON.parse(new TextDecoder().decode(tokBytes)));

  // 2) encoder：graph（1.2 MB）+ 外部權重（q4f16 432 MB）
  const encName = `onnx/encoder_model_${variant}.onnx`;
  const dataName = `onnx/encoder_model_${variant}.onnx_data`;
  const encGraph = await fetchBytes(dir + encName, cache, p => step(`encoder_model_${variant}.onnx`, p.loaded, p.total, p.cached));
  const encData = await fetchBytes(dir + dataName, cache, p => step(`encoder_model_${variant}.onnx_data`, p.loaded, p.total, p.cached));

  send({ type: 'progress', id, phase: 'init', label: 'encoder', loaded: 0, total: 0 });
  const encSession = await ort.InferenceSession.create(encGraph.buffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    externalData: [{ path: `encoder_model_${variant}.onnx_data`, data: encData }],
  });

  // 3) decoder_joint（66 MB，fp32 權重）
  const decName = `onnx/decoder_joint_model_${variant}.onnx`;
  const decGraph = await fetchBytes(dir + decName, cache, p => step(`decoder_joint_model_${variant}.onnx`, p.loaded, p.total, p.cached));
  send({ type: 'progress', id, phase: 'init', label: 'decoder', loaded: 0, total: 0 });
  const decSession = await ort.InferenceSession.create(decGraph.buffer, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });

  checkShapes(encSession, decSession);

  if (state.encSession) { try { await state.encSession.release(); } catch (error) { /* 舊的 */ } }
  if (state.decSession) { try { await state.decSession.release(); } catch (error) { /* 舊的 */ } }

  Object.assign(state, {
    base: dir, variant, encSession, decSession,
    extract: makeFrontend(pp), pieces,
  });

  send({ type: 'ready', id, ms: performance.now() - t0 });
}

async function transcribe(audio, id) {
  if (!state.encSession) throw new Error('模型尚未載入');
  const t0 = performance.now();
  const { features, T, valid } = state.extract(audio);
  if (T < 8) throw new Error('音訊太短');

  const mask = new BigInt64Array(T);
  for (let t = 0; t < T; t++) mask[t] = BigInt(t < valid ? 1 : 0);

  const enc = await state.encSession.run({
    input_features: new ort.Tensor('float32', features, [1, T, 128]),
    attention_mask: new ort.Tensor('int64', mask, [1, T]),
  });
  const encLen = Number(enc.encoder_lengths.data[0]);
  const frames = enc.encoder_outputs.data;
  const { tokens, steps } = await greedyTdt(ort, state.decSession, frames, encLen);
  const text = detokenize(tokens, state.pieces);
  send({ type: 'result', id, text, ms: performance.now() - t0, frames: encLen, steps });
}

self.onmessage = event => {
  const msg = event.data || {};
  if (msg.type === 'load') {
    // 載入是一次性的，序列化避免與轉寫交錯
    chain = chain.then(() => load(msg.baseUrl, msg.variant || 'q4f16', msg.id || 'load'))
      .catch(error => fail(msg.id || 'load', 'load', error));
    return;
  }
  if (msg.type === 'transcribe') {
    chain = chain.then(() => transcribe(msg.audio, msg.id))
      .catch(error => fail(msg.id, 'transcribe', error));
    return;
  }
};
