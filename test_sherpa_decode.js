// sherpa 解碼迴圈的分支測試：partial / endpoint 有字 / endpoint 空字 / 換場後不再寫入
// 直接載入 src/engines/sherpa-decode.js（2026-10 從 app.js 的 sherpaDecode 抽出來，
// 那時只能刮 HTML 原始碼來測，現在測的是真正的實作）。
// 跑法：node test_sherpa_decode.js
'use strict';

const assert = require('assert');
const { decodeSherpa } = require('./src/engines/sherpa-decode.js');

function run({ ready, text, endpoint, active = true }) {
  const log = { emitted: [], reset: 0, decodes: 0 };
  let readyLeft = ready;
  const recognizer = {
    isReady: () => readyLeft-- > 0,
    decode: () => { log.decodes += 1; },
    getResult: () => ({ text }),
    isEndpoint: () => endpoint,
    reset: () => { log.reset += 1; },
  };
  decodeSherpa({
    recognizer,
    stream: {},
    emit: h => log.emitted.push(h),
    isActive: () => active,
  });
  return log;
}

let r = run({ ready: 3, text: '你好世界', endpoint: false });
assert.deepStrictEqual(r.emitted.map(h => h.type), ['partial'], 'partial 只吐 partial');
assert.strictEqual(r.emitted[0].text, '你好世界');
assert.strictEqual(r.reset, 0, '沒有 endpoint 不該 reset');
assert.strictEqual(r.decodes, 3, 'isReady 幾次就 decode 幾次');

r = run({ ready: 1, text: '這句結束了', endpoint: true });
assert.deepStrictEqual(r.emitted.map(h => h.type), ['final'], 'endpoint 有字 → final');
assert.strictEqual(r.emitted[0].text, '這句結束了');
assert.strictEqual(r.reset, 1, 'endpoint 後必須 reset');

r = run({ ready: 1, text: '   ', endpoint: true });
assert.deepStrictEqual(r.emitted.map(h => h.type), ['partial'], 'endpoint 空字不 commit（只更新 partial）');
assert.strictEqual(r.emitted[0].text, '', '空字會 trim 成空字串');
assert.strictEqual(r.reset, 1, 'endpoint 空字仍須 reset');

r = run({ ready: 5, text: '過期', endpoint: true, active: false });
assert.deepStrictEqual(r.emitted, [], '換場之後不該再寫入字幕');
assert.strictEqual(r.reset, 0, '換場之後不該動 recognizer');
assert.strictEqual(r.decodes, 0, '換場之後連 decode 都不該跑');

console.log('decodeSherpa: 4 checks passed');
