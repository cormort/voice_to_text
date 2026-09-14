// 最小可跑檢查：resample 不應該在每一塊的尾端丟掉 sample
// 直接從 index.html 抽出函式原始碼，避免測試與實際程式碼分岔。
// 跑法：node test_resample.js
const fs = require('fs');
const assert = require('assert');

const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const src = html.match(/function resample\([\s\S]*?\n  \}\n/)[0];
const resample = new Function(`${src}\n  return resample;`)();

const CHUNK = 2048;   // AudioWorklet 的緩衝大小

// 1) 48k → 16k（factor 3，2048 不是 3 的倍數）：長度應該是 ceil 而不是 floor。
//    floor 會讓每一塊都少 2 個 sample，連續錄音就是持續漏音。
const out = resample(new Float32Array(CHUNK).fill(1), 48000, 16000);
assert.strictEqual(out.length, Math.ceil(CHUNK / 3), `48k→16k 長度應為 ${Math.ceil(CHUNK / 3)}，實得 ${out.length}`);

// 2) 輸入全是 1，輸出每一格都該是 1（含尾端那格不足 3 個 sample 的平均）
for (let i = 0; i < out.length; i++) {
  assert.ok(Math.abs(out[i] - 1) < 1e-6, `第 ${i} 格應為 1，實得 ${out[i]}`);
}

// 3) 累積誤差：連續 100 塊的輸出總長，相對於理想的 16k 取樣數不應少於 0.1%
const ideal = CHUNK * 100 / 3;
let total = 0;
for (let i = 0; i < 100; i++) total += resample(new Float32Array(CHUNK), 48000, 16000).length;
assert.ok(total >= ideal, `100 塊累積應不少於 ${ideal.toFixed(0)} samples，實得 ${total}`);

// 4) 同取樣率直接原樣回傳；非整數倍（44.1k→16k）仍走線性內插且長度合理
assert.strictEqual(resample(new Float32Array(CHUNK), 16000, 16000).length, CHUNK, '同取樣率應原樣回傳');
const odd = resample(new Float32Array(CHUNK), 44100, 16000);
assert.ok(Math.abs(odd.length - CHUNK * 16000 / 44100) <= 1, `44.1k→16k 長度應約 ${(CHUNK * 16000 / 44100).toFixed(0)}，實得 ${odd.length}`);

console.log('resample: 4 checks passed');
