// src/util.js 的行為測試（純函式，不需要瀏覽器）。
//
// 為什麼要這支：util.js 是從 app.js 抽出來的，抽取時漏掉一個模組層常數（SAMPLE_RATE）
// 讓 makeAudioBuffer 在瀏覽器裡直接 ReferenceError；呼叫端的 try/catch 只印了一行
// console.warn，表現是「有在收音、字幕永遠不出來」。這種「只有真的跑才會炸」的錯誤，
// 用一個假 context 就能在 Node 裡抓到。
//
// 跑法：node test_util.js   （離開碼 1 表示失敗）
'use strict';

const assert = require('assert');
const { stamp, concat, resample, makeAudioBuffer, isLatinDominated } = require('./src/util.js');

let checks = 0;

// ── makeAudioBuffer：一定要用 16 kHz，而且真的把樣本寫進去 ────────────────
{
  let usedRate = null;
  let copied = null;
  const fakeContext = {
    createBuffer(channels, length, rate) {
      usedRate = rate;
      return {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        copyToChannel(data) { copied = data; },
      };
    },
  };
  const data = new Float32Array([0.1, -0.2, 0.3]);
  const buffer = makeAudioBuffer(fakeContext, data);
  assert.strictEqual(usedRate, 16000, 'Vosk 的 acceptWaveform 需要 16 kHz 的 AudioBuffer');
  assert.strictEqual(buffer.length, 3);
  assert.strictEqual(copied, data, '樣本要原樣寫進第 0 軌');
  checks += 1;
}

// ── concat ────────────────────────────────────────────────────────────────
{
  const out = concat([new Float32Array([1, 2]), new Float32Array([3])], 3);
  assert.deepStrictEqual(Array.from(out), [1, 2, 3]);
  assert.strictEqual(concat([], 0).length, 0);
  checks += 1;
}

// ── resample：整數倍要平均、長度用 ceil（不要每塊都掉尾巴）─────────────────
{
  const up = resample(new Float32Array([1, 1, 1, 1]), 16000, 32000);
  assert.strictEqual(up.length, 8, '16k→32k 應該是兩倍長');
  assert.ok(up.every(v => Math.abs(v - 1) < 1e-6), '常數訊號重取樣後仍是常數');
  const down = resample(new Float32Array(10).fill(0.5), 48000, 16000);
  assert.strictEqual(down.length, Math.ceil(10 / 3), '長度用 ceil');
  checks += 1;
}

// ── isLatinDominated ──────────────────────────────────────────────────────
{
  assert.ok(isLatinDominated('state space model'));
  assert.ok(!isLatinDominated('狀態空間模型'));
  assert.ok(!isLatinDominated(''));
  checks += 1;
}

// ── stamp：固定格式 [HH:MM:SS] ────────────────────────────────────────────
{
  const s = stamp(new Date(2026, 9, 25, 9, 5, 7));
  assert.strictEqual(s, '[09:05:07]');
  checks += 1;
}

console.log(`util: ${checks} checks passed`);
