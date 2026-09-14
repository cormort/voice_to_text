// Worker 失敗時的退路與狀態清理測試。
//
// 為什麼要這支：Worker 化之後出現過兩個同型 bug，都是「Worker 掛掉時的處理」不完整 ——
//   1. Whisper：`new Worker` 建得起來不代表載得動（CDN 被擋、import 失敗、不支援 module
//      worker）。少了 try/catch，這些情況會直接判整個引擎死亡，而主執行緒路徑其實還有機會。
//   2. sherpa：Worker 死掉時沒有清 `loaded`，UI 還寫著「已載入」，下一次 start 會對著
//      一個沒有 recognizer 的 Worker 發訊息，錯誤訊息完全看不懂。
// 這兩種都不會在正常操作下出現，所以需要刻意模擬：把 worker 檔擋掉、或注入一個會崩的
// Worker。純函式測試（test_vad.js 那種）碰不到這條路徑。
//
// 跑法：
//   node test_worker_fallback.js
//   PW_MODULE=/path/to/playwright/index.js node test_worker_fallback.js
//
// 需要 playwright（沒裝會直接告訴你要跑什麼）：
//   npm i -D playwright && npx playwright install chromium
//
// 離開碼 1 表示有案例失敗。

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.FALLBACK_PORT || 8934);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png'
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('nope'); return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      // 一定要 no-store：否則瀏覽器會餵回舊的 index.html／worker，測到的不是這份程式
      'cache-control': 'no-store'
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail: String(detail) }); };

// 案例 1：Whisper 的 worker 檔載不起來 → 必須退回主執行緒並真的能用
async function whisperFallback(pw, browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const requests = [];
  const warns = [];
  page.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType() }));
  page.on('console', (m) => { if (/falling back to the main thread/i.test(m.text())) warns.push(m.text()); });
  page.on('pageerror', (e) => warns.push('pageerror: ' + e.message));
  // 注入假 Worker：只對 whisper-worker.js 生效，收到 postMessage 後回報一則載入失敗
  // （模擬 worker 內部的 CDN import 被擋 —— 也就是實際最常見的失敗）。
  // 不能用 page.route 擋 worker 檔：Playwright 的 route 攔不到 worker script 的請求，
  // 那樣「擋掉」其實沒擋到，worker 會正常載入、根本不會走到退路（實測踩過）。
  await page.addInitScript(() => {
    const RealWorker = window.Worker;
    window.__fakeWhisperWorkerUsed = false;
    window.Worker = function (url, opts) {
      if (String(url).includes('whisper-worker.js')) {
        window.__fakeWhisperWorkerUsed = true;
        return {
          onmessage: null,
          onerror: null,
          postMessage(msg) {
            // 用真實 worker 的錯誤協定回報，讓頁面的 pending 被 reject（= 他們修的那條路）
            setTimeout(() => { if (this.onmessage) this.onmessage({ data: { type: 'error', id: msg && msg.id, phase: 'load', message: 'simulated CDN import failure' } }); }, 30);
          },
          terminate() {}
        };
      }
      return new RealWorker(url, opts);
    };
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.click('[data-engine="whisper"]');
  await page.click('#loadWhisperBtn');
  let ready = false;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(1000);
    const cls = await page.evaluate(() => document.getElementById('loadWhisperBtn').className);
    if (/\bdone\b/.test(cls)) { ready = true; break; }
  }
  const st = await page.evaluate(() => ({
    status: document.getElementById('whisperStatus').textContent,
    runtime: document.getElementById('statusRuntimeValue').textContent
  }));
  check('Whisper：worker 回報載入失敗時仍載入成功（退回主執行緒）', ready && /ready|已載入/i.test(st.status),
    `ready=${ready} 狀態="${st.status}" runtime="${st.runtime}"`);
  check('Whisper：有印出退回主執行緒的警告', warns.some((w) => /falling back to the main thread/i.test(w)),
    warns.slice(0, 1).join(' | ') || '沒有警告');
  check('Whisper：確實走過 Worker 路徑（假 Worker 被使用）',
    await page.evaluate(() => !!window.__fakeWhisperWorkerUsed),
    String(await page.evaluate(() => !!window.__fakeWhisperWorkerUsed)));
  check('Whisper：沒有未捕捉的例外', !warns.some((w) => w.startsWith('pageerror:')),
    warns.find((w) => w.startsWith('pageerror:')) || 'none');
  await ctx.close();
}

// 案例 2：sherpa 的 worker 中途死掉 → 狀態要清乾淨，且要退回主執行緒
// 用注入的假 Worker（只對 sherpa-worker.js 生效）＋擋掉 .data，讓整條路徑在幾秒內結束，
// 不必下載 190 MB。判斷「有沒有退回主執行緒」用 resourceType：
// worker 路徑是 fetch 抓膠水層，主執行緒路徑是用 <script> 載入。
async function sherpaWorkerCrash(pw, browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType() }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const RealWorker = window.Worker;
    window.__fakeSherpaWorkerUsed = false;
    window.Worker = function (url, opts) {
      if (String(url).includes('sherpa-worker.js')) {
        window.__fakeSherpaWorkerUsed = true;
        // 只實作頁面會用到的介面：onmessage/onerror 指派 + postMessage 後丟錯（模擬 worker 崩潰）
        return {
          onmessage: null,
          onerror: null,
          postMessage() { setTimeout(() => { if (this.onerror) this.onerror({ message: 'simulated worker crash' }); }, 30); },
          terminate() {}
        };
      }
      return new RealWorker(url, opts);
    };
  });
  // 讓退回的主執行緒路徑也快速失敗（否則會真的去抓 190 MB）
  await page.route('**/sherpa-onnx-wasm-main-asr.data', (route) => route.fulfill({ status: 404, body: 'blocked' }));

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.click('[data-engine="sherpa"]');
  await page.click('#loadSherpaBtn');
  await page.waitForTimeout(6000);
  const st = await page.evaluate(() => ({
    fakeUsed: !!window.__fakeSherpaWorkerUsed,
    status: document.getElementById('sherpaStatus').textContent,
    statusClass: document.getElementById('sherpaStatus').className,
    btnClass: document.getElementById('loadSherpaBtn').className,
    btnDisabled: document.getElementById('loadSherpaBtn').disabled
  }));
  check('sherpa：有走到 Worker 路徑（假 Worker 被使用）', st.fakeUsed, String(st.fakeUsed));
  check('sherpa：worker 崩潰後 UI 不謊報「已載入」',
    !/Model ready|已載入/i.test(st.status) && /error/.test(st.statusClass),
    `狀態="${st.status.slice(0, 70)}" class="${st.statusClass}"`);
  check('sherpa：worker 崩潰後載入鈕恢復可用（不會卡死）',
    !st.btnDisabled && !/\bdone\b/.test(st.btnClass),
    `disabled=${st.btnDisabled} class="${st.btnClass}"`);
  check('sherpa：崩潰後確實退回主執行緒（用 <script> 載膠水層）',
    requests.some((r) => /sherpa-onnx-asr\.js/.test(r.url) && r.type === 'script'),
    `script 型請求 ${requests.filter((r) => /sherpa-onnx-asr\.js/.test(r.url) && r.type === 'script').length} 次`);
  check('sherpa：沒有未捕捉的例外', errors.length === 0, errors.slice(0, 2).join(' | ') || 'none');
  await ctx.close();
}

// 案例 3：sherpa「載入成功之後」worker 才死掉 —— 這是 e38a68c 修的那個情況。
// 若不把 loaded/workerMode 清掉，UI 會一直寫著「已載入」，下一次 start 對著沒有 recognizer
// 的 Worker 發訊息，錯誤訊息完全看不懂。
// 為了不真的下載 190 MB：先在 Cache Storage 種一份假的 .data，讓 fetchSherpaPackage 直接命中。
async function sherpaCrashAfterLoad(pw, browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const RealWorker = window.Worker;
    window.Worker = function (url, opts) {
      if (String(url).includes('sherpa-worker.js')) {
        const fake = {
          onmessage: null,
          onerror: null,
          postMessage(msg) {
            if (msg && msg.type === 'load') {
              // 先假裝載入成功，讓頁面進入「已載入」狀態
              setTimeout(() => { if (this.onmessage) this.onmessage({ data: { type: 'ready' } }); }, 20);
              // 再讓 worker 死掉（模擬 after-load 崩潰）
              setTimeout(() => { if (this.onerror) this.onerror({ message: 'simulated crash after load' }); }, 700);
              return;
            }
            if (msg && msg.type === 'free' && this.onmessage) {
              setTimeout(() => { this.onmessage({ data: { type: 'freed' } }); }, 0);
            }
          },
          terminate() {}
        };
        return fake;
      }
      return new RealWorker(url, opts);
    };
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  // 種一份假的 .data 進快取，讓 fetchSherpaPackage 命中（不下載 190 MB）
  const dataUrl = await page.evaluate(async () => {
    const input = document.getElementById('sherpaBaseUrl');
    const base = new URL(input.value.trim().replace(/\/?$/, '/'), document.baseURI).href;
    const url = base + 'sherpa-onnx-wasm-main-asr.data';
    const cache = await caches.open('sherpa-onnx-model-v1');
    await cache.put(url, new Response(new Uint8Array(16), { headers: { 'Content-Type': 'application/octet-stream' } }));
    return url;
  });
  await page.click('[data-engine="sherpa"]');
  await page.click('#loadSherpaBtn');
  await page.waitForTimeout(2500);          // 等「假成功 → 崩潰」兩段都發生
  const st = await page.evaluate(() => ({
    status: document.getElementById('sherpaStatus').textContent,
    statusClass: document.getElementById('sherpaStatus').className,
    btnClass: document.getElementById('loadSherpaBtn').className,
    btnDisabled: document.getElementById('loadSherpaBtn').disabled
  }));
  check('sherpa：載入成功後 worker 死掉 → UI 不再寫「已載入」',
    !/Model ready|已載入/i.test(st.status) && /error/.test(st.statusClass),
    `狀態="${st.status.slice(0, 70)}" class="${st.statusClass}"`);
  check('sherpa：載入成功後 worker 死掉 → 載入鈕回到未完成、可用狀態',
    !/\bdone\b/.test(st.btnClass) && !st.btnDisabled,
    `class="${st.btnClass}" disabled=${st.btnDisabled}`);
  check('sherpa：假 .data 有命中快取（證明沒真的下載 190 MB）', !!dataUrl, dataUrl.slice(-40));
  check('sherpa：載入後崩潰沒有未捕捉例外', errors.length === 0, errors.slice(0, 2).join(' | ') || 'none');
  await ctx.close();
}

(async () => {
  let pw;
  try {
    pw = (await import(process.env.PW_MODULE || 'playwright')).default;
  } catch (error) {
    console.error('找不到 playwright。請先：npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
  const server = await serve();
  const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    console.log('案例 1：Whisper worker 載入失敗 → 退回主執行緒');
    await whisperFallback(pw, browser);
    console.log('案例 2：sherpa worker 崩潰 → 狀態清理 + 退回主執行緒');
    await sherpaWorkerCrash(pw, browser);
    console.log('案例 3：sherpa 載入成功後 worker 崩潰 → 狀態清理');
    await sherpaCrashAfterLoad(pw, browser);
  } finally {
    await browser.close();
    server.close();
  }

  let fail = 0;
  for (const r of results) {
    if (r.pass) console.log(`  PASS  ${r.name}  [${r.detail}]`);
    else { fail++; console.log(`  FAIL  ${r.name}  [${r.detail}]`); }
  }
  console.log(`\n${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
