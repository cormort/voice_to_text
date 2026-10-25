// 儲存診斷的邏輯測試（假 storage／假 OPFS／假 cache，不需要瀏覽器）。
//
// 這頁存在的理由就是「配額不足時要看得出來」，所以測試的重點是**失敗要被報出來**，
// 不是「一切正常時長得漂亮」：
//   * estimate 不可用 → 要留錯誤訊息，不是靜靜顯示 ?
//   * OPFS 寫入失敗（QuotaExceededError）→ ok:false 且帶原因
//   * OPFS 讀回來的內容不一致 → 也要算失敗（寫得進去不代表寫對了）
//   * cache 讀不到 → 該筆標記錯誤，其他照樣列
//
// 跑法：node test_storage_debug.js
'use strict';

const assert = require('assert');
const { collectStorageReport, probeOpfs, cacheUsage, formatBytes } = require('./src/storage-debug.js');

function fakeOpfs({ failWrite = null, corruptRead = false } = {}) {
  const files = new Map();
  return {
    files,
    async openWriter(key) {
      return {
        async write(data) {
          if (failWrite) throw Object.assign(new Error('quota'), { name: failWrite });
          files.set(key, Uint8Array.from(data));
        },
        async close() {},
      };
    },
    async read(key) {
      const stored = files.get(key);
      if (!stored) return null;
      if (corruptRead) { const bad = Uint8Array.from(stored); bad[0] ^= 0xff; return bad; }
      return stored;
    },
    async remove(key) { return files.delete(key); },
    async list() { return [...files.entries()].map(([key, value]) => ({ key, size: value.length })); },
  };
}

function fakeCaches(entries) {
  return {
    async cacheNames() { return Object.keys(entries); },
    async openCache(name) {
      if (entries[name] && entries[name].error) throw new Error(entries[name].error);
      const data = entries[name] || [];
      return {
        async keys() { return data.map(entry => ({ url: `https://x/${entry.name}` })); },
        async match() {
          return { blob: async () => ({ size: 1048576 }) };
        },
      };
    },
  };
}

(async () => {
  // 1) 正常：配額、剩餘、OPFS 可寫、cache 有量
  {
    const report = await collectStorageReport({
      storage: { estimate: async () => ({ quota: 10 * 1048576, usage: 4 * 1048576 }), persisted: async () => true },
      opfs: fakeOpfs(),
      ...fakeCaches({ 'underdog-model-v1': [{ name: 'encoder_model_q4f16.onnx_data' }] }),
    });
    assert.strictEqual(report.quota, 10 * 1048576);
    assert.strictEqual(report.available, 6 * 1048576);
    assert.strictEqual(report.usageRatio, 0.4);
    assert.strictEqual(report.persisted, true);
    assert.strictEqual(report.opfs.ok, true, 'OPFS 寫入＋讀回比對應該成功');
    assert.strictEqual(report.caches.length, 1);
    assert.strictEqual(report.caches[0].entries, 1);
    assert.strictEqual(report.caches[0].bytes, 1048576);
  }

  // 2) estimate 不可用 → 要看得出來，而不是空白
  {
    const report = await collectStorageReport({ storage: {}, opfs: fakeOpfs(), ...fakeCaches({}) });
    assert.strictEqual(report.quota, null);
    assert.ok(/estimate/.test(report.quotaError || ''), `應留下原因（實得 ${report.quotaError}）`);
  }

  // 3) OPFS 配額爆掉 → ok:false 且帶原因（就是上次 431.9 MB 事故的形狀）
  {
    const result = await probeOpfs(fakeOpfs({ failWrite: 'QuotaExceededError' }));
    assert.strictEqual(result.ok, false);
    assert.ok(/QuotaExceededError/.test(result.error || ''), `錯誤要帶出來（實得 ${result.error}）`);
    assert.strictEqual(result.bytes, 0);
  }

  // 4) 寫得進去但讀回來不一致 → 也算失敗
  {
    const result = await probeOpfs(fakeOpfs({ corruptRead: true }));
    assert.strictEqual(result.ok, false);
    assert.ok(/不一致/.test(result.error || ''), `要說內容不一致（實得 ${result.error}）`);
  }

  // 5) 某個 cache 讀不到 → 只標記那一筆，其他照樣列
  {
    const report = await collectStorageReport({
      storage: { estimate: async () => ({ quota: 100, usage: 1 }) },
      opfs: fakeOpfs(),
      ...fakeCaches({ bad: { error: 'SecurityError' }, good: [{ name: 'a.bin' }] }),
    });
    const bad = report.caches.find(c => c.name === 'bad');
    const good = report.caches.find(c => c.name === 'good');
    assert.ok(bad && bad.error, '壞掉的 cache 要帶錯誤');
    assert.ok(good && good.entries === 1, '好的 cache 不能受影響');
  }

  // 6) 大小格式（人在看這頁，單位要一眼看懂）
  {
    assert.strictEqual(formatBytes(1024), '1.0 KB');
    assert.strictEqual(formatBytes(1048576), '1.0 MB');
    assert.strictEqual(formatBytes(1048576 * 1024), '1.00 GB');
    assert.strictEqual(formatBytes(null), '?');
  }

  console.log('storage-debug: 6 checks passed');
})();
