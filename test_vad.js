// 最小可跑檢查：vadPush / vadFlush 的分段行為
// 直接從 index.html 抽出函式原始碼，避免測試與實際程式碼分岔。
// 跑法：node test_vad.js
const fs = require('fs');
const assert = require('assert');

const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const src = [
  /function vadPush\([\s\S]*?\n  \}\n/,
  /function vadFlush\([\s\S]*?\n  \}\n/,
  /function concat\([\s\S]*?\n  \}\n/
].map(re => html.match(re)[0]).join('\n');

const SAMPLE_RATE = 16000;
const CHUNK = 2048; // 128 ms @16 kHz

// 每塊的第一個 sample 帶 marker，用來追蹤某一塊音訊在 utterance 中出現幾次
const run = new Function('SAMPLE_RATE', 'CHUNK', `${src}
  return function run(script) {
    const v = { speaking: false, silence: 0, speech: 0, pre: [], audio: [], samples: 0, threshold: 0.018 };
    const log = { utterances: [], flushed: null, speaking: false, samples: 0 };
    for (const step of script) {
      const chunk = new Float32Array(CHUNK);
      if (step.marker !== undefined) chunk[0] = step.marker;
      const out = vadPush(v, chunk, step.rms);
      if (out) log.utterances.push(out);
    }
    log.speaking = v.speaking;
    log.samples = v.samples;
    log.flushed = vadFlush(v);
    return log;
  };`)(SAMPLE_RATE, CHUNK);

const silence = n => Array.from({ length: n }, () => ({ rms: 0 }));
const speech = (n, firstMarker = 42) =>
  Array.from({ length: n }, (_, i) => ({ rms: 1, marker: firstMarker + i }));
const occurrences = (array, value) => array.reduce((n, x) => n + (x === value ? 1 : 0), 0);

// 1) 語音開頭不得重複：第一個有聲塊只應該出現一次（修正前會出現兩次）
let r = run([...silence(6), ...speech(8), ...silence(7)]);
assert.strictEqual(r.utterances.length, 1, '8 塊語音 + 800 ms 靜音後應產出 1 段 utterance');
const first = r.utterances[0];
assert.strictEqual(occurrences(first, 42), 1, '第一個有聲塊不應在 utterance 中重複');
assert.strictEqual(occurrences(first, 49), 1, '最後一個有聲塊應完整保留');
assert.strictEqual(first.length, (3 + 8 + 7) * CHUNK,
  '長度應為 pre-roll（0.4 秒內取 3 塊）+ 8 塊語音 + 7 塊尾端靜音');
assert.strictEqual(r.speaking, false, '收尾後應回到非說話狀態');

// 2) 同一場 session 的第二段也不能重複（狀態有正確重置）
r = run([...silence(6), ...speech(8, 42), ...silence(7), ...speech(8, 100), ...silence(7)]);
assert.strictEqual(r.utterances.length, 2, '連續兩段語音都應產出');
assert.strictEqual(occurrences(r.utterances[1], 100), 1, '第二段的第一個有聲塊同樣不應重複');

// 3) 太短的語音（< 800 ms）不應送出
r = run([...silence(6), ...speech(3), ...silence(8)]);
assert.strictEqual(r.utterances.length, 0, '384 ms 的語音應被丟棄');
assert.strictEqual(r.speaking, false, '丟棄後狀態仍須重置');
assert.strictEqual(r.samples, 0, '丟棄後緩衝應清空');

// 4) 連續語音遇到靜音時，超過 15 秒要一次吐出整段（給 Whisper 的 chunk_length_s 切）
r = run([...silence(6), ...speech(130), { rms: 0 }]);
assert.strictEqual(r.utterances.length, 1, '超過 15 秒的語音應在靜音出現時送出');
assert.ok(r.utterances[0].length >= SAMPLE_RATE * 15, '送出的長度應至少 15 秒');

// 5) vadFlush 只吐還算有效的殘段
r = run([...silence(6), ...speech(20)]);
assert.ok(r.flushed, '停止時說話中的殘段應被 flush');
assert.strictEqual(occurrences(r.flushed, 42), 1, 'flush 出來的音訊同樣不應重複');
r = run([...silence(6), ...speech(3)]);
assert.strictEqual(r.flushed, null, '不足 800 ms 的殘段不應 flush');

// 6) 一路說不停（完全沒有靜音塊）時，15 秒上限也要切段。
//    這格原本沒測到：check 4 的腳本結尾有一塊靜音，走的是靜音分支。
r = run([...silence(6), ...speech(470)]);   // 約 60 秒連續語音
assert.ok(r.utterances.length >= 3, `連續語音應被 15 秒上限切成多段，實得 ${r.utterances.length}`);
for (const u of r.utterances) {
  assert.ok(u.length <= SAMPLE_RATE * 16, '每段不應遠超過 15 秒上限');
}
assert.ok(r.samples <= SAMPLE_RATE * 16, `緩衝不應無限成長，實得 ${(r.samples / SAMPLE_RATE).toFixed(1)} 秒`);

console.log('vadPush/vadFlush: 6 checks passed');
