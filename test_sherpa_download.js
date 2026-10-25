// 大檔下載的分段與重試（src/download.js）。
//
// 原本這支測試是從 index.html「刮」出 fetchRange／downloadInChunks 的原始碼再 new Function 執行，
// 只要換行或排版一變就會抓到別的函式（實際發生過：CRLF/LF 混用時抓到跨檔案的 export）。
// 2026-10 抽成模組之後改成直接 import，測的就是真的會跑的那份程式。
//
// 跑法：node test_sherpa_download.js
'use strict';

const assert = require('assert');
const { downloadInChunks, fetchRange, streamWhole, CHUNK_BYTES, formatProgress } = require('./src/download.js');

const TOTAL = 20 * 1024 * 1024;
const full = Buffer.alloc(TOTAL);
for (let i = 0; i < TOTAL; i++) full[i] = i & 0xff;

function makeFetch({ failAt = [], noRange = false } = {}) {
  const calls = { n: 0, ranges: [] };
  const stub = async (url, opts = {}) => {
    calls.n++;
    const range = (opts.headers || {}).Range;
    if (noRange) {
      return {
        ok: true,
        status: 200,
        headers: { get: key => (key === 'Content-Length' ? String(TOTAL) : null) },
        body: {
          getReader() {
            let sent = false;
            return {
              read: async () => (sent ? { done: true }
                : ((sent = true), { done: false, value: new Uint8Array(full) })),
            };
          },
        },
      };
    }
    const m = range.match(/bytes=(\d+)-(\d+)/);
    const [start, end] = [Number(m[1]), Number(m[2])];
    calls.ranges.push([start, end]);
    if (failAt.includes(calls.n)) throw new TypeError('network error');
    return {
      ok: true,
      status: 206,
      headers: { get: key => (key === 'Content-Range' ? `bytes ${start}-${end}/${TOTAL}` : null) },
      arrayBuffer: async () => full.buffer.slice(start, end + 1),
    };
  };
  return [stub, calls];
}

async function run(opts) {
  const [stub, calls] = makeFetch(opts);
  const realFetch = global.fetch;
  const realSetTimeout = global.setTimeout;
  global.fetch = stub;
  global.setTimeout = fn => { fn(); return 0; };   // 重試退避不真的等
  try {
    const out = await downloadInChunks('u');
    return [Buffer.from(out), calls];
  } finally {
    global.fetch = realFetch;
    global.setTimeout = realSetTimeout;
  }
}

(async () => {
  let [got, calls] = await run();
  assert.strictEqual(got.length, TOTAL, '長度應等於總大小');
  assert.ok(got.equals(full), '分段組回來的內容必須與原檔一致');
  // probe（bytes=0-0）也算一次，所以實際分段請求數是 ceil(總量 / CHUNK_BYTES)
  // probe（bytes=0-0）也算一次 range 請求，所以總次數是 ceil(總量 / CHUNK_BYTES) + 1
  assert.strictEqual(calls.ranges.length, Math.ceil(TOTAL / CHUNK_BYTES) + 1,
    '分段請求數應為 ceil(總量 / CHUNK_BYTES) + 1（含 probe）');

  // 第 3 次請求失敗（probe 是第 1 次），重試後仍須組出正確內容
  [got] = await run({ failAt: [3] });
  assert.ok(got.equals(full), '單段失敗重試後內容仍須正確');

  // 同一段連續失敗 3 次仍在重試上限內
  [got] = await run({ failAt: [3, 4, 5] });
  assert.ok(got.equals(full), '同段連續失敗 3 次仍應成功');

  // 超過重試上限應拋出，而不是回傳半截資料
  await assert.rejects(run({ failAt: [3, 4, 5, 6] }), /network error/, '超過上限應拋錯');

  // 伺服器不支援 Range 時退回整份串流
  [got] = await run({ noRange: true });
  assert.ok(got.equals(full), '不支援 Range 時應退回 streamWhole 且內容正確');

  // 200 不算成功：伺服器忽略 Range 時必須拋錯（否則會悄悄退化成整份下載）
  {
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
    await assert.rejects(fetchRange('u', 0, 1), /expected 206/, '非 206 必須視為失敗');
    global.fetch = realFetch;
  }

  // 進度文字：有總量／沒總量都要有 MB，且百分比固定一位小數
  assert.strictEqual(formatProgress(5 * 1048576, 10 * 1048576, '下載'), '下載 5.0 / 10.0 MB（50.0%）');
  assert.strictEqual(formatProgress(5 * 1048576, 0), '5.0 MB');
  assert.strictEqual(typeof streamWhole, 'function');

  console.log('download: 8 checks passed');
})();
