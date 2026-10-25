// 儲存空間診斷（`?debug=storage`）。
//
// 為什麼要有這頁：OPFS 續傳那次事故的教訓是「配額不足 → 寫入中止 → 靜靜退回 →
// 每次都重抓 431.9 MB」，而畫面上完全看不出來。這頁把三個問題一次講清楚：
//   1. 這個 origin 的配額還剩多少（navigator.storage.estimate）
//   2. OPFS 到底寫不寫得進去（真的寫 1 MiB、讀回來比對、再刪掉）
//   3. 每個 Cache Storage 裡佔了多少（模型快取是幾百 MB 的等級）
//
// 全部依賴都做成可注入，所以 Node 測試不需要瀏覽器。

const MB = 1048576;

export function formatBytes(bytes) {
  if (bytes == null) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
}

/** 真的寫一小塊進 OPFS，讀回來比對，成功才刪。回傳 { ok, bytes, ms, error } */
export async function probeOpfs(store) {
  const key = 'diagnostics/opfs-probe.bin';
  const size = MB;                       // 1 MiB：夠大能踩到配額，夠小不浪費
  const payload = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) payload[i] = i & 0xff;   // 有點內容，不是全 0
  const started = Date.now();
  try {
    await store.remove(key).catch(() => {});
    const writer = await store.openWriter(key);
    await writer.write(payload);
    await writer.close();
    const back = await store.read(key);
    const ok = !!back && back.length === size && back[0] === payload[0] && back[size - 1] === payload[size - 1];
    await store.remove(key).catch(() => {});
    return ok
      ? { ok: true, bytes: size, ms: Date.now() - started }
      : { ok: false, bytes: 0, ms: Date.now() - started, error: back ? '讀回來的內容不一致' : '讀不回來' };
  } catch (error) {
    await store.remove(key).catch(() => {});
    return { ok: false, bytes: 0, ms: Date.now() - started, error: String((error && error.name) || error) + '：' + String((error && error.message) || '') };
  }
}

/** 每個 cache 有幾筆、各佔多少（用 blob().size，cache 的內容本來就在磁碟上） */
export async function cacheUsage(openCache, names, perCacheLimit = 30) {
  const out = [];
  for (const name of names) {
    // 每個 cache 各自 try：一個讀不到（SecurityError、schema 壞掉）不該讓整份報告變空
    try {
      const cache = await openCache(name);
      const requests = await cache.keys();
      let bytes = 0;
      const files = [];
      for (const request of requests.slice(0, perCacheLimit)) {
        let size = null;
        try {
          const response = await cache.match(request);
          if (response) size = (await response.blob()).size;
        } catch { /* 單筆讀不到就當未知 */ }
        if (size) bytes += size;
        files.push({ name: request.url.split('/').pop() || request.url, size });
      }
      out.push({ name, entries: requests.length, bytes, files, truncated: requests.length > perCacheLimit });
    } catch (error) {
      out.push({ name, entries: 0, bytes: 0, error: String((error && error.message) || error) });
    }
  }
  return out;
}

/**
 * 收集完整報告。所有依賴可注入（Node 測試用假物件）。
 * @param {object} deps
 *   storage   — 有 estimate() / persisted()（預設 navigator.storage）
 *   opfs      — 有 openWriter/read/remove/list（預設 src/opfs.js 的 opfsStore）
 *   cacheNames/openCache — Cache Storage（預設 caches）
 */
export async function collectStorageReport({
  storage = typeof navigator !== 'undefined' ? navigator.storage : null,
  opfs = null,
  cacheNames = async () => (typeof caches !== 'undefined' ? caches.keys() : []),
  openCache = name => caches.open(name),
  perCacheLimit = 30,
  warnings = typeof window !== 'undefined' && window.__engineWarnings
    ? () => window.__engineWarnings.history()
    : () => [],
  // 隔離與執行緒數：Underdog 只有在 crossOriginIsolated 時才會開多執行緒，
  // 而「沒開」的時候畫面完全正常、只是慢 2–3 倍 —— 所以要能在這裡一眼看出來。
  isolation = typeof window !== 'undefined'
    ? () => ({ crossOriginIsolated: !!window.crossOriginIsolated, threads: Number(window.__underdogThreads) || null, cores: navigator.hardwareConcurrency || null })
    : () => ({ crossOriginIsolated: false, threads: null, cores: null }),
} = {}) {
  const report = { at: new Date().toISOString(), ua: typeof navigator !== 'undefined' ? navigator.userAgent : 'node', quota: null, usage: null, persisted: null, opfs: null, models: [], caches: [] };

  if (storage && storage.estimate) {
    try {
      const estimate = await storage.estimate();
      report.quota = estimate.quota ?? null;
      report.usage = estimate.usage ?? null;
      report.available = report.quota != null && report.usage != null ? report.quota - report.usage : null;
      report.usageRatio = report.quota ? Number((report.usage / report.quota).toFixed(3)) : null;
    } catch (error) {
      report.quotaError = String(error && error.message);
    }
  } else {
    report.quotaError = 'navigator.storage.estimate 不可用（非安全環境或舊瀏覽器）';
  }

  if (storage && storage.persisted) {
    try { report.persisted = await storage.persisted(); } catch { /* 忽略 */ }
  }

  if (opfs) {
    report.opfs = await probeOpfs(opfs);
    try {
      report.models = (await opfs.list()).map(entry => ({ key: entry.key, size: entry.size }));
    } catch (error) {
      report.modelsError = String(error && error.message);
    }
  } else {
    report.opfs = { ok: false, error: '沒有傳入 OPFS store' };
  }

  try {
    report.caches = await cacheUsage(openCache, await cacheNames(), perCacheLimit);
  } catch (error) {
    report.cachesError = String(error && error.message);
  }

  // 引擎／worker 的警告歷史（engine-warnings.js 的 sink 掛在 window.__engineWarnings）。
  // 這些是「不致命、但發生過」的事：cache 寫入失敗、OPFS 續傳中止、WebGPU 退回 WASM…
  // 出國前看一次就知道這台機器載模型時踩過什麼。
  try {
    report.isolation = typeof isolation === 'function' ? await isolation() : (isolation || null);
  } catch (error) {
    report.isolation = null;
    report.isolationError = String((error && error.message) || error);
  }

  try {
    const entries = typeof warnings === 'function' ? await warnings() : (warnings || []);
    report.warnings = Array.isArray(entries) ? entries.slice(-10) : [];
  } catch (error) {
    report.warnings = [];
    report.warningsError = String((error && error.message) || error);
  }

  return report;
}

/** 把報告畫成一張卡（純 DOM，不依賴框架） */
export function renderStorageReport(report, t = {}) {
  const strings = {
    title: '儲存空間診斷', close: '關閉', copy: '複製 JSON',
    quota: '配額', usage: '已用', available: '剩餘', persisted: '已申請持久化',
    opfs: 'OPFS 寫入測試', models: 'OPFS 模型', caches: 'Cache Storage', warnings: '警告紀錄', none: '（無）',
    isolation: '跨來源隔離', threads: '執行緒',
    ...t,
  };
  const el = document.createElement('div');
  el.id = 'storageDebug';
  el.style.cssText = 'position:fixed;inset:5% 5% auto 5%;z-index:9999;max-height:88vh;overflow:auto;background:#12131cf2;color:#e8e9f3;border-radius:14px;padding:18px 20px;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 20px 60px #000a';

  const row = (label, value) => `<div><b>${label}</b>　${value}</div>`;
  const yesNo = value => (value == null ? '?' : value ? '✅' : '❌');

  const modelRows = report.models && report.models.length
    ? report.models.map(m => `<li>${m.key} — ${formatBytes(m.size)}</li>`).join('')
    : `<li>${strings.none}</li>`;

  const cacheRows = (report.caches || []).map(cache => {
    const files = (cache.files || []).map(f => `${f.name} ${formatBytes(f.size)}`).join('、');
    return `<li>${cache.name}：${cache.entries} 筆、${formatBytes(cache.bytes)}${cache.error ? `（${cache.error}）` : ''}${files ? `<br><span style="opacity:.65">${files}</span>` : ''}</li>`;
  }).join('') || `<li>${strings.none}</li>`;

  const warningRows = (report.warnings || []).map(w =>
    `<li>${String(w.at || '').slice(11, 19)}　<b>${w.engine}</b>／${w.phase}：${w.message}</li>`
  ).join('') || `<li>${strings.none}</li>`;

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px">
      <strong style="font-size:15px">${strings.title}</strong>
      <span>
        <button id="storageCopy" style="margin-right:8px">${strings.copy}</button>
        <button id="storageClose">${strings.close}</button>
      </span>
    </div>
    ${row(strings.quota, formatBytes(report.quota))}
    ${row(strings.usage, `${formatBytes(report.usage)}${report.usageRatio != null ? `（${(report.usageRatio * 100).toFixed(1)}%）` : ''}`)}
    ${row(strings.available, formatBytes(report.available))}
    ${row(strings.persisted, yesNo(report.persisted))}
    ${row(strings.isolation, report.isolation
      ? `${report.isolation.crossOriginIsolated ? '✅ 已隔離' : '❌ 未隔離（Underdog 只能單執行緒）'}｜${strings.threads} ${report.isolation.threads ?? '—'}／核心 ${report.isolation.cores ?? '—'}`
      : '?')}
    ${report.quotaError ? `<div style="color:#ffb4b4">${report.quotaError}</div>` : ''}
    <hr style="border-color:#ffffff22;margin:10px 0">
    ${row(strings.opfs, report.opfs && report.opfs.ok
      ? `✅ 可寫（1 MiB，${report.opfs.ms} ms）`
      : `❌ ${report.opfs ? report.opfs.error : '?'}`)}
    <div><b>${strings.models}</b><ul style="margin:4px 0 4px 18px">${modelRows}</ul></div>
    <div><b>${strings.caches}</b><ul style="margin:4px 0 4px 18px">${cacheRows}</ul></div>
    <div><b>${strings.warnings}</b>${report.warningsError ? `（${report.warningsError}）` : ''}<ul style="margin:4px 0 4px 18px">${warningRows}</ul></div>
    <div style="opacity:.6;margin-top:10px">${report.ua}</div>
  `;

  document.body.appendChild(el);
  el.querySelector('#storageClose').onclick = () => el.remove();
  el.querySelector('#storageCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 1));
      el.querySelector('#storageCopy').textContent = '✓';
    } catch { el.querySelector('#storageCopy').textContent = '複製失敗'; }
  };
  return el;
}
