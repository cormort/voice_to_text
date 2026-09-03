// 最小可跑檢查：sherpaDecode 的分支（partial / endpoint 有字 / endpoint 空字 / 過期 session）
// 直接從 index.html 抽出函式原始碼，避免測試與實際程式碼分岔。
// 跑法：node test_sherpa_decode.js
const fs = require('fs');
const assert = require('assert');

const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const src = html.match(/function sherpaDecode\(sessionId\) \{[\s\S]*?\n  \}/)[0];

function run({ ready, text, endpoint, sessionId = 1 }) {
  const log = { committed: [], reset: 0, interim: null };
  let readyLeft = ready;
  const sherpa = {
    sessionId: 1,
    stream: {},
    recognizer: {
      isReady: () => readyLeft-- > 0,
      decode: () => {},
      getResult: () => ({ text }),
      isEndpoint: () => endpoint,
      reset: () => { log.reset += 1; }
    }
  };
  const state = {};
  const commit = s => log.committed.push(s);
  const traditional = s => s;
  const render = () => { log.interim = state.interim; };
  new Function('sherpa', 'state', 'commit', 'traditional', 'render',
    `${src}; sherpaDecode(${sessionId});`)(sherpa, state, commit, traditional, render);
  return log;
}

let r = run({ ready: 3, text: '你好世界', endpoint: false });
assert.deepStrictEqual(r.committed, [], 'partial 不應 commit');
assert.strictEqual(r.reset, 0);
assert.strictEqual(r.interim, '你好世界');

r = run({ ready: 1, text: '這句結束了', endpoint: true });
assert.deepStrictEqual(r.committed, ['這句結束了'], 'endpoint 有字時應 commit');
assert.strictEqual(r.reset, 1, 'endpoint 後必須 reset');
assert.strictEqual(r.interim, null, 'commit 後不再寫 interim');

r = run({ ready: 1, text: '   ', endpoint: true });
assert.deepStrictEqual(r.committed, [], 'endpoint 空字不應 commit');
assert.strictEqual(r.reset, 1, 'endpoint 空字仍須 reset');
assert.strictEqual(r.interim, '', 'endpoint 空字應清空 interim');

r = run({ ready: 5, text: '過期', endpoint: true, sessionId: 99 });
assert.deepStrictEqual(r.committed, [], '過期 session 不應寫入');
assert.strictEqual(r.reset, 0, '過期 session 不應動 recognizer');

console.log('sherpaDecode: 4 checks passed');
