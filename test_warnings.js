// 警告集中處理的測試（不需要瀏覽器）。
//
// 這支的行為直接決定「事故看不看得出來」，所以每一條規則都測：
//   1. 每一則都要進 history（就算去重不彈 toast）
//   2. 同一 engine＋phase 在 dedupe 視窗內只彈一次（避免一次載入噴五次）
//   3. 超過視窗要再彈（不能永久靜音）
//   4. 不同 phase 各自彈
//   5. toast 一定要帶 phase 與原始訊息（不能只說「失敗」）
//   6. history 有上限、訊息會被截短
//   7. showToast 自己壞掉時不能影響載入流程
//
// 跑法：node test_warnings.js
'use strict';

const assert = require('assert');
const { createWarningSink, trimMessage, exposeWarnings } = require('./src/engine-warnings.js');

let clock = 0;
const now = () => clock;
const toasts = [];
const sink = createWarningSink({ showToast: message => toasts.push(message), now, label: () => '本機作業警告', dedupeMs: 1000, historyLimit: 3 });

// 1 + 2：同一階段連兩則 → history 兩筆、toast 一則
sink.report('underdog', 'cache', 'QuotaExceededError: quota exceeded');
sink.report('underdog', 'cache', 'QuotaExceededError: quota exceeded again');
assert.strictEqual(toasts.length, 1, '同一階段在去重視窗內只彈一次');
assert.strictEqual(sink.history().length, 2, '兩則都要進 history（去重只影響 toast）');

// 5：toast 帶 phase 與原始訊息
assert.ok(/cache/.test(toasts[0]), 'toast 要標明階段');
assert.ok(/QuotaExceededError/.test(toasts[0]), 'toast 要帶原始訊息，不能只說「失敗」');

// 3：視窗過後要再彈
clock = 1500;
sink.report('underdog', 'cache', 'still failing');
assert.strictEqual(toasts.length, 2, '超過去重視窗要再提醒一次');

// 4：不同階段各自彈
clock = 1600;
sink.report('underdog', 'opfs', 'OPFS write failed');
assert.strictEqual(toasts.length, 3, '不同 phase 要各自提醒');

// 6：history 上限（3）與訊息截短
clock = 5000;
sink.report('underdog', 'cache', 'x'.repeat(500));
assert.strictEqual(sink.history().length, 3, 'history 不能無限長');
const last = sink.history()[2];
assert.ok(last.message.length <= 160, `訊息要截短（實得 ${last.message.length}）`);
assert.ok(/…$/.test(last.message), '截短要有省略號');

// 空訊息也要有意義
assert.strictEqual(trimMessage(''), '(沒有訊息)');
assert.strictEqual(trimMessage(null), '(沒有訊息)');
assert.strictEqual(trimMessage('  a\n b  '), 'a b');

// 7：toast 壞掉不能丟出去
const broken = createWarningSink({ showToast: () => { throw new Error('toast broken'); }, now });
assert.doesNotThrow(() => broken.report('x', 'y', 'z'));
assert.strictEqual(broken.stats().toastFailures, 1);
assert.strictEqual(broken.history().length, 1);

// exposeWarnings：掛到假 window，讓診斷頁讀得到
const fakeWindow = {};
exposeWarnings(sink, fakeWindow);
assert.strictEqual(typeof fakeWindow.__engineWarnings.history, 'function');
assert.strictEqual(fakeWindow.__engineWarnings.history().length, 3);
fakeWindow.__engineWarnings.clear();
assert.strictEqual(sink.history().length, 0);

console.log('engine-warnings: 7 checks passed');
