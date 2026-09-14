'use strict';

const CACHE = 'stt-shell-v3';
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
  './sherpa-worker.js'
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
