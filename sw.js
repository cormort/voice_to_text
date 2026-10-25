'use strict';

// v15：新增 src/persist.js（逐字稿本機保存），外殼要列入。
// v16：下載樣板抽成 src/download.js（fetchRange／downloadInChunks／streamWhole／formatProgress）。
// v14：Underdog 的模型載入與 worker 膠水搬進 src/engines/underdog.js。
// v13：Whistle 的模型載入與 worker 膠水搬進 src/engines/whistle.js。
// v12：串流引擎也收斂（src/engines/live.js ＋ sherpa-decode.js），Vosk／sherpa 共用啟停。
// v11：引擎介面收斂（src/engines/batch.js），三個批次引擎共用一條 pipeline。
// v10：程式拆成 src/（app.js / i18n.js / util.js / vad.js），外殼要全部列入。
// v9：主程式從 index.html 搬到 src/app.js（單檔 HTML 結束），外殼必須包含它。
// v8：新增雙語字幕（mt-worker.js）與量測 HUD。
// v7：新增 Underdog Bark 3.0 引擎（underdog-worker.js / underdog/frontend.js / underdog/tdt.js）。
// v6：needle 引擎（needle.js + needle.wasm，實測傳輸 360 KB）不再預抓 —— 它只有選 Whistle
// 的人會用到，而同源資產本來就會在第一次用到時被下面的 fetch handler 寫進快取。
// v5：新增 Whistle 引擎（whistle-worker.js / whistle-engine.js / needle 引擎的 js 與 wasm）。
// v4：sherpa-worker.js 修好 getResult(stream)（先前每個音塊都丟 TypeError、字幕永遠空白）。
// **為什麼一定要升版**：worker 檔在 ASSETS 裡、由 fetch handler 以 cache-first 供應，
// 而瀏覽器只會比對 sw.js 本身的位元來決定要不要更新 SW —— 只改 worker 不改 sw.js 的話，
// install 不會重跑、cache.addAll 不會重抓，既有使用者會永遠拿到舊 worker。
// 升版名同時讓 activate 的清快取邏輯把舊 shell 砍掉。
const CACHE = 'stt-shell-v19';
// 只清「自己的」外殼快取版本。transformers-cache（Whisper 模型）與
// sherpa-onnx-model-v1（sherpa 的 .data）是模型快取，砍掉會讓使用者重新下載數百 MB，
// 所以用前綴比對而不是「除了 CACHE 以外全刪」。
const SHELL_PREFIX = 'stt-shell-';
// 上限 64 MB：單一回應超過就不放進外殼快取，避免一個大檔把配額吃光。
// 注意這裡「不是」為內建 Vosk ZIP 設的 —— 48e98e5 之後 ZIP 由 index.html 的
// fetchVoskPackage 以 Range 分段下載並存進 VOSK_CACHE，帶 Range 的請求本來就不會
// 進外殼快取（見下方 isCacheable）。sherpa 的 .data（199 MB）同理走 SHERPA_CACHE。
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const ASSETS = [
  './', './manifest.webmanifest',
  './icon-192.png', './icon-512.png',
  './icon-maskable-192.png', './icon-maskable-512.png',
  './apple-touch-icon.png',
  './whisper-worker.js',
  './sherpa-worker.js',
  // Whistle 的 worker 與呼叫層（各約 4 KB）值得預抓；**needle 引擎不預抓**：
  // needle.js（63 KB 原始／18 KB gzip）＋ needle.wasm（923 KB 原始／342 KB gzip）
  // 只有選 Whistle 的人會用到，預抓等於讓所有訪客多付 360 KB。它們是同源資產，
  // fetch handler 會在第一次使用時寫進快取 —— 犧牲的只有「離線後第一次就選 Whistle」，
  // 而那個情境本來就不成立（首次使用一定要連網下載 16.9 MB 模型）。
  './whistle-worker.js',
  './whistle-engine.js',
  // Underdog Bark 3.0 的 worker 與前處理／解碼模組（各約 5 KB），同樣只有選它的人才會用到；
  // 這裡先預抓是因為它們是同源小檔，而 worker 一旦被 Service Worker 以舊版供應就會與
  // index.html 的訊息協定對不上（見上面的版本註記）。onnxruntime-web 由 jsdelivr 載入、
  // 權重（432 MB）走 UNDERDOG_CACHE，都不在外殼快取裡。
  './underdog-worker.js',
  './underdog/frontend.js',
  './underdog/tdt.js',
  // 主程式（2026-10 從 index.html 搬到 src/）：外殼一定要有，否則離線開啟會白畫面。
  // app.js 會 import src/i18n.js（文案）、src/util.js（純函式）、src/vad.js（分段），
  // 三者都列進來，離線時才不會缺模組。
  './src/app.js',
  './src/i18n.js',
  './src/util.js',
  './src/vad.js',
  './src/persist.js',
  './src/download.js',
  './src/opfs.js',
  './src/storage-debug.js',
  './src/engine-warnings.js',
  './src/engines/batch.js',
  './src/engines/live.js',
  './src/engines/sherpa-decode.js',
  './src/engines/whistle.js',
  './src/engines/underdog.js',
  // 翻譯 worker（約 3 KB）：字幕條一開就會用到，體積可以忽略
  './mt-worker.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(SHELL_PREFIX) && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// 206（部分內容）不能放進 Cache Storage：Cache.put() 對 206 會直接 reject。
// 帶 Range 的請求也不能用「整份回應」的快取回答，否則呼叫端會拿到 200 而不是 206
// （index.html 的 fetchRange 會因此判定失敗）。錯誤回應同樣不存，避免把一時的
// 404/500 永久留在快取裡。
function isCacheable(request, response) {
  if (!response || !response.ok) return false;
  if (response.status === 206 || request.headers.has('range')) return false;
  if (response.headers.get('Vary') === '*') return false;
  const length = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > MAX_CACHE_BYTES) return false;
  return true;
}

function putInCache(request, response) {
  const copy = response.clone();
  // 一定要把 promise 交回給 event.waitUntil 並自己吞掉失敗（配額不足等），
  // 否則 SW 可能在寫入完成前就被關掉，或留下未處理的 rejection
  return caches.open(CACHE)
    .then((cache) => cache.put(request, copy))
    .catch((error) => console.warn('SW cache put failed:', request, error));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 外部 CDN（模型下載、transformers 等）不做快取，避免大檔把配額塞滿
  if (url.origin !== self.location.origin) return;

  // 帶 Range 的請求一律走網路。caches.match() 不看 headers，會拿「整份 200」來回答
  // 部分內容的請求，呼叫端（index.html 的 fetchRange）等的是 206，就會整個解析錯。
  // 寫入端的 isCacheable 已經擋掉 Range，讀取端也要擋，否則兩邊的假設對不起來。
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        if (isCacheable(request, response)) event.waitUntil(putInCache('./index.html', response));
        return response;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (isCacheable(request, response)) event.waitUntil(putInCache(request, response));
        return response;
      });
    })
  );
});
