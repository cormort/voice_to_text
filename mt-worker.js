// 本機翻譯 worker（Phase 1）。
//
// 用 transformers.js 3.8.1 跑 Marian（預設 Xenova/opus-mt-en-zh）：載入 7.8 s、
// 每句 220–562 ms（WASM、q8，實測見 ARCHITECTURE.md）。**刻意不用 4.x**：
// 4.2.0 對這顆模型的 merged decoder 會炸
// `TransposeDQWeightsForMatMulNBits Missing required scale`，
// 而 Whisper 那條路仍然用 4.2.0 —— 兩者跑在不同 worker，互不干擾。
//
// 只在「已結束的句子」被呼叫，不做串流翻譯：半句翻譯會讓中文一行跳三次。
'use strict';

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

const state = { pipe: null, model: null };
let chain = Promise.resolve();

function post(msg) {
  self.postMessage(msg);
}

async function load(model) {
  if (state.pipe && state.model === model) {
    post({ type: 'ready', model });
    return;
  }
  post({ type: 'progress', phase: 'load', model });
  const pipe = await pipeline('translation', model, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: info => {
      if (info.status === 'progress' && info.progress != null) {
        post({ type: 'progress', phase: 'download', file: info.file, progress: info.progress });
      }
    },
  });
  state.pipe = pipe;
  state.model = model;
  post({ type: 'ready', model });
}

async function translate(id, text) {
  if (!state.pipe) throw new Error('翻譯模型尚未載入');
  const out = await state.pipe(text, { max_new_tokens: 160 });
  const zh = Array.isArray(out)
    ? out.map(x => x.translation_text || '').join(' ')
    : (out.translation_text || '');
  post({ type: 'result', id, text: zh.trim() });
}

self.onmessage = event => {
  const msg = event.data || {};
  if (msg.type === 'load') {
    chain = chain.then(() => load(msg.model)).catch(error => {
      post({ type: 'error', id: 'load', message: String((error && error.message) || error) });
    });
    return;
  }
  if (msg.type === 'translate') {
    const id = msg.id;
    chain = chain.then(() => translate(id, msg.text)).catch(error => {
      post({ type: 'error', id, message: String((error && error.message) || error) });
    });
  }
};
