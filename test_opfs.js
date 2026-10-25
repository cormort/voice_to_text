// OPFS 續傳的邏輯測試（假 store + 假 fetch，不需要瀏覽器）。
//
// 為什麼要這支：續傳最容易錯的地方不是「寫檔案」，而是**邊界判斷**：
//   * 已抓完（size === total）→ 不該再發任何 Range 請求
//   * 抓到一半（0 < size < total）→ 從 size 接下去，且前面的內容不能丟
//   * size > total 或 size 對不上（伺服器換檔）→ 必須從 0 重來，不能寫出壞檔
// 這些用假 store 就能驗，不必真的中斷 430 MB 的下載。
//
// 跑法：node test_opfs.js
'use strict';

const assert = require('assert');
const { downloadResumable } = require('./src/opfs.js');

const TOTAL = 20 * 1024 * 1024;                 // 20 MB，用預設 8 MB 分段 → 3 段
const FULL = Buffer.alloc(TOTAL);
for (let i = 0; i < TOTAL; i++) FULL[i] = i & 0xff;

function makeStore(initial = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, Uint8Array.from(v)]));
  return {
    files,
    async size(key) { return files.has(key) ? files.get(key).length : 0; },
    async read(key) { return files.has(key) ? Uint8Array.from(files.get(key)) : null; },
    async openWriter(key) {
      // 只實作 append（模組的契約就是「既有內容後面接」）
      let buf = files.get(key) || new Uint8Array(0);
      files.set(key, buf);
      return {
        async write(data) {
          const part = Uint8Array.from(data);
          const next = new Uint8Array(buf.length + part.length);
          next.set(buf, 0);
          next.set(part, buf.length);
          buf = next;
          files.set(key, buf);
        },
        async close() {},
        async abort() {},
      };
    },
    async remove(key) { return files.delete(key); },
  };
}

function makeFetch({ failAfter = Infinity } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range);
    const [start, end] = [Number(m[1]), Number(m[2])];
    calls.push([start, end]);
    if (calls.length > failAfter) throw new TypeError('network down');
    if (start === 0 && end === 0) {
      return {
        ok: true, status: 206, headers: { get: k => (k === 'Content-Range' ? `bytes 0-0/${TOTAL}` : null) },
        arrayBuffer: async () => FULL.buffer.slice(0, 1),
      };
    }
    return {
      ok: true, status: 206, headers: { get: k => (k === 'Content-Range' ? `bytes ${start}-${end}/${TOTAL}` : null) },
      arrayBuffer: async () => FULL.buffer.slice(start, end + 1),
    };
  };
  return { fetchImpl, calls };
}

(async () => {
  // 1) 全新下載：三段請求 + probe，內容正確，寫進 store
  {
    const store = makeStore();
    const { fetchImpl, calls } = makeFetch();
    const out = await downloadResumable('u', 'k', { store, fetchImpl });
    assert.strictEqual(out.fromCache, false);
    assert.strictEqual(out.resumedFrom, 0);
    assert.ok(Buffer.from(out.bytes).equals(FULL), '內容必須與原檔一致');
    assert.strictEqual(calls.length, 1 + 3, 'probe + 3 段');
    assert.strictEqual(store.files.get('k').length, TOTAL, 'store 裡要是完整檔案');
  }

  // 2) 已經抓完：不再發出任何請求（第二次載入模型不碰網路）
  {
    const store = makeStore({ k: FULL });
    const { fetchImpl, calls } = makeFetch();
    const out = await downloadResumable('u', 'k', { store, fetchImpl });
    assert.strictEqual(out.fromCache, true, '應判定為快取命中');
    assert.strictEqual(calls.length, 1, '只發 probe，不重新下載');
    assert.ok(Buffer.from(out.bytes).equals(FULL));
  }

  // 3) 抓到一半就斷：下次從斷點續傳，而且前半段不能丟
  {
    const store = makeStore();
    const first = makeFetch({ failAfter: 3 });          // probe + 2 段之後斷線
    await assert.rejects(downloadResumable('u', 'k', { store, fetchImpl: first.fetchImpl }), /network down/);
    const partial = store.files.get('k').length;
    assert(partial > 0 && partial < TOTAL, `中斷後應留下部分檔案（實得 ${partial}）`);

    const second = makeFetch();
    const out = await downloadResumable('u', 'k', { store, fetchImpl: second.fetchImpl });
    assert.strictEqual(out.resumedFrom, partial, '必須從已寫入的位元組接下去');
    const resumed = Buffer.from(out.bytes);
    let firstBad = -1;
    for (let i = 0; i < Math.min(resumed.length, FULL.length); i++) {
      if (resumed[i] !== FULL[i]) { firstBad = i; break; }
    }
    assert.ok(resumed.equals(FULL),
      `續傳後內容必須與原檔一致（len=${resumed.length}、store=${store.files.get('k').length}、resumedFrom=${out.resumedFrom}、firstBad=${firstBad}、ranges=${JSON.stringify(second.calls)}）`);
    const firstRange = second.calls[1];
    assert.strictEqual(firstRange[0], partial, '續傳的第一個 Range 要從斷點開始');
  }

  // 4) 大小對不上（伺服器換檔）→ 從 0 重來，不能拼出新舊混雜的壞檔
  {
    const store = makeStore({ k: Buffer.alloc(TOTAL * 2, 7) });
    const { fetchImpl, calls } = makeFetch();
    const out = await downloadResumable('u', 'k', { store, fetchImpl });
    assert.strictEqual(out.resumedFrom, 0, '大小不符應重新下載');
    assert.ok(Buffer.from(out.bytes).equals(FULL), '重下之後內容正確');
    assert.deepStrictEqual(calls[1], [0, Math.min(8 * 1024 * 1024, TOTAL) - 1], '第一段必須從 0 開始');
  }

  console.log('opfs: 4 checks passed');
})();
