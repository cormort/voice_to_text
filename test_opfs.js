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
const { downloadResumable, opfsKey, urlHash, metaKeyOf, opfsStore, CHUNK_BYTES } = require('./src/opfs.js');

const TOTAL = 20 * 1024 * 1024;                 // 20 MB；分段大小改由 CHUNK_BYTES 決定（32 MB → 1 段），測試跟著算
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

// 會記錄來源（網址／大小／ETag）的 store —— 真的 opfsStore 就是這種
function makeTrackingStore(initial = {}, meta = {}) {
  const store = makeStore(initial);
  const texts = new Map(Object.entries(meta).map(([k, v]) => [metaKeyOf(k), JSON.stringify(v)]));
  store.texts = texts;
  store.readText = async key => (texts.has(key) ? texts.get(key) : null);
  store.writeText = async (key, text) => { texts.set(key, text); };
  return store;
}

function makeFetch({ failAfter = Infinity, etag = '"v1"' } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range);
    const [start, end] = [Number(m[1]), Number(m[2])];
    calls.push([start, end]);
    if (calls.length > failAfter) throw new TypeError('network down');
    if (start === 0 && end === 0) {
      return {
        ok: true, status: 206,
        headers: { get: k => (k === 'Content-Range' ? `bytes 0-0/${TOTAL}` : k === 'ETag' ? etag : null) },
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
    assert.strictEqual(calls.length, 1 + Math.ceil(TOTAL / CHUNK_BYTES), 'probe + ceil(總量 / CHUNK_BYTES) 段');
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
    await assert.rejects(downloadResumable('u', 'k', { store, fetchImpl: first.fetchImpl, chunkBytes: 5 * 1024 * 1024 }), /network down/);
    const partial = store.files.get('k').length;
    assert(partial > 0 && partial < TOTAL, `中斷後應留下部分檔案（實得 ${partial}）`);

    const second = makeFetch();
    const out = await downloadResumable('u', 'k', { store, fetchImpl: second.fetchImpl, chunkBytes: 5 * 1024 * 1024 });
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
    assert.strictEqual(calls[1][0], 0, '第一段必須從 0 開始');
  }

  // 5) 有來源紀錄的 store：抓完之後記下網址／大小／ETag，第二次直接命中
  {
    const store = makeTrackingStore();
    await downloadResumable('u', 'k', { store, fetchImpl: makeFetch().fetchImpl });
    assert.deepStrictEqual(JSON.parse(store.texts.get(metaKeyOf('k'))), { url: 'u', total: TOTAL, etag: '"v1"' });
    const again = makeFetch();
    const out = await downloadResumable('u', 'k', { store, fetchImpl: again.fetchImpl });
    assert.strictEqual(out.fromCache, true, '同一份來源 → 命中');
    assert.strictEqual(out.restarted, false);
    assert.strictEqual(again.calls.length, 1, '只發 probe');
  }

  // 6) 抓到一半，伺服器換了檔（ETag 變了、大小沒變）→ 不能接舊的前段，必須從 0 重抓
  {
    const half = FULL.subarray(0, 8 * 1024 * 1024);
    const store = makeTrackingStore({ k: Buffer.alloc(half.length, 9) }, { k: { url: 'u', total: TOTAL, etag: '"v0"' } });
    const { fetchImpl, calls } = makeFetch({ etag: '"v1"' });
    const out = await downloadResumable('u', 'k', { store, fetchImpl });
    assert.strictEqual(out.restarted, true, 'ETag 不同要回報 restarted');
    assert.strictEqual(out.resumedFrom, 0);
    assert.ok(Buffer.from(out.bytes).equals(FULL), '不能拼出新舊混雜的檔案');
    assert.strictEqual(calls[1][0], 0, '第一段必須從 0 開始（結尾由 chunkBytes 決定，不寫死）');
    assert.strictEqual(JSON.parse(store.texts.get(metaKeyOf('k'))).etag, '"v1"', '來源紀錄要更新成新的 ETag');
  }

  // 7) 已抓完、但沒有來源紀錄（舊版留下的檔案）→ 不信任，重抓
  {
    const store = makeTrackingStore({ k: FULL });
    const { fetchImpl, calls } = makeFetch();
    const out = await downloadResumable('u', 'k', { store, fetchImpl });
    assert.strictEqual(out.fromCache, false);
    assert.strictEqual(out.restarted, true);
    assert.strictEqual(calls.length, 1 + Math.ceil(TOTAL / CHUNK_BYTES));
  }

  // 8) 換網址（鏡像）時同一個檔名不會撞到同一個 OPFS 檔
  {
    const a = opfsKey('underdog', 'https://huggingface.co/a/resolve/main/x.onnx', 'x.onnx');
    const b = opfsKey('underdog', 'https://huggingface.co/b/resolve/main/x.onnx', 'x.onnx');
    assert.notStrictEqual(a, b, '不同網址 → 不同 key');
    assert.match(a, /^underdog\/[0-9a-f]{8}-x\.onnx$/);
    assert.strictEqual(urlHash('same'), urlHash('same'), '雜湊要穩定（重新整理後找得到同一個檔）');
  }

  // 9) 真的 opfsStore：worker 裡走 createSyncAccessHandle，每段寫在檔尾並立刻 flush
  //    （flush 了，分頁被關掉也不會丟；createWritable 要等 close() 才落地）
  {
    const disk = { bytes: Uint8Array.from([1, 2, 3]), flushes: 0, closed: false };
    const fileHandleFake = {
      async createSyncAccessHandle() {
        return {
          getSize: () => disk.bytes.length,
          write(view, { at }) {
            const next = new Uint8Array(Math.max(disk.bytes.length, at + view.length));
            next.set(disk.bytes, 0);
            next.set(view, at);
            disk.bytes = next;
            return view.length;
          },
          flush() { disk.flushes += 1; },
          close() { disk.closed = true; },
        };
      },
      async createWritable() { throw new Error('有 sync handle 時不該走 createWritable'); },
    };
    const dir = {
      async getDirectoryHandle() { return dir; },
      async getFileHandle() { return fileHandleFake; },
    };
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { storage: { getDirectory: async () => dir } }, configurable: true,
    });
    try {
      const writer = await opfsStore.openWriter('underdog/k');
      await writer.write(Uint8Array.from([4, 5]));
      assert.strictEqual(disk.flushes, 1, '每一段寫完都要 flush');
      await writer.write(Uint8Array.from([6]));
      assert.deepStrictEqual(Array.from(disk.bytes), [1, 2, 3, 4, 5, 6], '沒給 position：接在既有內容後面');
      // 給了 position 就寫在那裡；之後沒給 position 的寫入接在「這次寫完的地方」
      await writer.write(Uint8Array.from([7, 8]), 1);
      assert.deepStrictEqual(Array.from(disk.bytes), [1, 7, 8, 4, 5, 6], 'position 要被採用，不能被當成追加');
      await writer.write(Uint8Array.from([9]));
      assert.deepStrictEqual(Array.from(disk.bytes), [1, 7, 8, 9, 5, 6], '之後的追加從上一次寫完的位置接');
      await writer.close();
      assert.ok(disk.closed, 'close 要釋放 sync handle（否則之後讀不到檔案）');
    } finally {
      if (saved) Object.defineProperty(globalThis, 'navigator', saved);
      else delete globalThis.navigator;
    }
  }

  console.log('opfs: 9 checks passed');
})();
