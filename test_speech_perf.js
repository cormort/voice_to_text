// 語音引擎的「主執行緒阻塞」量測 harness。
//
// 為什麼要有這支：這個 App 有五種引擎，但「辨識準不準」看得出來、「會不會凍結 UI」
// 看不出來 —— 直到使用者發現按鈕沒反應。Whisper 的 WASM 後端實測單一 chunk 會阻塞
// 主執行緒 12.3 秒（占串流時間 49.6%），就是這支量到的。
//
// 做法：把 `say` 產生的中文語音（或 PERF_WAV 指定的檔案）餵進 Chromium 的假麥克風，
// 用 PerformanceObserver('longtask') 量每個引擎在載入與串流期間阻塞主執行緒多久。
//
// 跑法：
//   node test_speech_perf.js                     # 預設量 vosk 與 whisper
//   PERF_ENGINES=vosk,sherpa,whisper node test_speech_perf.js
//   PERF_WAV=/path/to/16k.wav node test_speech_perf.js
//   PERF_SECONDS=25 PW_MODULE=/path/to/playwright/index.js node test_speech_perf.js
//
// 需要 playwright（沒裝的話這支會直接告訴你要跑什麼）：
//   npm i -D playwright && npx playwright install chromium
//
// 離開碼 1 表示有引擎阻塞主執行緒超過 PERF_MAX_BLOCK_MS（預設 500 ms）—— 可接 CI。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const SECONDS = Number(process.env.PERF_SECONDS || 25);
const MAX_BLOCK_MS = Number(process.env.PERF_MAX_BLOCK_MS || 500);
const ENGINES = (process.env.PERF_ENGINES || 'vosk,whisper').split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.PERF_PORT || 8931);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.zip': 'application/zip', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8'
};

function speechWav() {
  if (process.env.PERF_WAV) return process.env.PERF_WAV;
  const out = '/tmp/stt-perf-speech.wav';
  const aiff = '/tmp/stt-perf-speech.aiff';
  const text = '今天天氣很好，我們來測試語音辨識的即時效能，這是一段用來量測主執行緒阻塞的中文語音。';
  const say = spawnSync('say', ['-v', 'Meijia', '-o', aiff, text]);
  if (say.status !== 0) return null;
  const conv = spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, out]);
  return conv.status === 0 && fs.existsSync(out) ? out : null;
}

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('nope'); return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      // no-store：否則瀏覽器（或持久化的 profile）會餵回舊的 index.html／worker，
      // 量到的就是上一版的程式 —— 實際踩過這個陷阱。
      'cache-control': 'no-store'
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function measure(pw, wav, engine) {
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  if (wav) args.push(`--use-file-for-fake-audio-capture=${wav}`);
  const browser = await pw.chromium.launch({ args });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
  await page.addInitScript(() => {
    window.__long = [];
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); })
        .observe({ entryTypes: ['longtask'] });
    } catch (error) { /* 瀏覽器不支援 longtask */ }
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.click(`[data-engine="${engine}"]`);

  // 載入模型（按鈕出現 .done 代表就緒；Web Speech 與 MOSS 不需要載入）
  const btn = `#load${engine[0].toUpperCase()}${engine.slice(1)}Btn`;
  const tLoad = Date.now();
  await page.evaluate(() => { window.__long = []; });
  if (await page.$(btn)) {
    await page.click(btn);
    for (let i = 0; i < 180; i++) {
      await page.waitForTimeout(1000);
      if (await page.evaluate((id) => /\bdone\b/.test(document.getElementById(id).className), btn.slice(1))) break;
    }
  }
  const loadMs = Date.now() - tLoad;
  const loadLong = await page.evaluate(() => window.__long.slice());

  // 串流：空白鍵切換開始／停止（README 寫的快捷鍵）
  await page.evaluate(() => { window.__long = []; });
  const before = await page.evaluate(() => document.getElementById('transcript').textContent.length);
  await page.keyboard.press('Space');
  await page.waitForTimeout(SECONDS * 1000);
  const r = await page.evaluate(() => ({
    long: window.__long.slice(),
    heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    text: document.getElementById('transcript').textContent.length,
    state: document.getElementById('statusStateValue').textContent
  }));
  await page.keyboard.press('Space');
  await browser.close();

  const streamLong = r.long;
  return {
    engine, loadMs, loadLong: loadLong.length ? Math.max(...loadLong) : 0,
    longCount: streamLong.length, longest: streamLong.length ? Math.max(...streamLong) : 0,
    blocked: streamLong.reduce((a, b) => a + b, 0), heap: r.heap,
    transcribed: r.text > before, state: r.state, errors
  };
}

(async () => {
  let pw;
  try {
    pw = (await import(process.env.PW_MODULE || 'playwright')).default;
  } catch (error) {
    console.error('找不到 playwright。請先：npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }

  const wav = speechWav();
  if (!wav) console.warn('⚠️ 找不到／無法產生測試語音（macOS 的 say + afconvert），將以靜音串流；' +
    '靜音不會觸發辨識，數字只反映載入與音訊處理成本。可用 PERF_WAV=… 指定 16 kHz 單聲道 WAV。');
  const server = await serve();
  const rows = [];
  try {
    for (const engine of ENGINES) {
      process.stdout.write(`量測 ${engine} …`);
      const r = await measure(pw, wav, engine);
      rows.push(r);
      process.stdout.write(` 完成（載入 ${(r.loadMs / 1000).toFixed(1)}s，串流最長阻塞 ${r.longest} ms）\n`);
    }
  } finally {
    server.close();
  }

  console.log(`\n引擎        載入      載入期最長阻塞   ${SECONDS}s 串流長任務   最長   總計   占比    主執行緒 heap  有轉寫  狀態`);
  for (const r of rows) {
    const pct = ((r.blocked / (SECONDS * 1000)) * 100).toFixed(1);
    console.log(
      `${r.engine.padEnd(11)} ${(r.loadMs / 1000).toFixed(1).padStart(5)}s   ` +
      `${String(r.loadLong).padStart(8)} ms   ${String(r.longCount).padStart(8)} 個   ` +
      `${String(r.longest).padStart(6)} ${String(r.blocked).padStart(6)}   ${pct.padStart(5)}%   ` +
      `${String(r.heap ?? '?').padStart(8)} MB   ${(r.transcribed ? '✓' : '✗').padStart(4)}   ${r.state}`
    );
    if (r.errors.length) console.log(`             ⚠️ ${r.errors.slice(0, 2).join(' | ')}`);
  }

  const bad = rows.filter((r) => r.longest > MAX_BLOCK_MS);
  if (bad.length) {
    console.log(`\n❌ 有 ${bad.length} 個引擎阻塞主執行緒超過 ${MAX_BLOCK_MS} ms：` +
      bad.map((r) => `${r.engine}(${r.longest}ms)`).join('、'));
    process.exit(1);
  }
  console.log(`\n✅ 所有引擎的最長阻塞都低於 ${MAX_BLOCK_MS} ms`);
})();
