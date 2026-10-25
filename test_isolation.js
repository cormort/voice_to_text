// 跨來源隔離（COOP/COEP 由 sw.js 補）與 Underdog 多執行緒的測試。
//
// 為什麼要這支：隔離壞掉時沒有任何錯誤訊息 —— 頁面照常運作，只是 crossOriginIsolated
// 變回 false、Underdog 悄悄退回 1 執行緒，轉寫慢 2–3 倍（實測 RTF 0.28 → 0.85）。
// 這裡守住三件事：
//   1. sw.js 在頁面、快取命中、網路回應上都補了兩個標頭（COEP 是 credentialless）
//   2. 第一次造訪會重整一次拿到標頭，但 SW 更新時不重整（錄音中不能被打斷）
//   3. worker 只在隔離時開多執行緒，上限 4，`?threads=N` 可覆蓋
//
// 跑法：node test_isolation.js   （離開碼 1 表示失敗）
'use strict';

const fs = require('fs');
const path = require('path');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n');
const SW = read('sw.js');
const HTML = read('index.html');
const WORKER = read('underdog-worker.js');
const ENGINE = read('src/engines/underdog.js');

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

// ── 1. sw.js 補標頭 ───────────────────────────────────────────────────────
check('COOP: same-origin', /'Cross-Origin-Opener-Policy': 'same-origin'/.test(SW));
check('COEP: credentialless（不是 require-corp，否則 HF／jsDelivr／GA 全被擋）',
  /'Cross-Origin-Embedder-Policy': 'credentialless'/.test(SW) && !/require-corp'/.test(SW));
check('頁面（navigate）回應有補', /return withIsolation\(response\);\s*\n\s*\}\)\.catch\(\(\) => caches\.match\('\.\/index\.html'\)\.then\(withIsolation\)\)/.test(SW));
check('快取命中也有補（離線開啟仍是隔離的）', /if \(hit\) return withIsolation\(hit\);/.test(SW));
// GitHub Pages 是 max-age=600：install 不繞 HTTP 快取的話，部署後 10 分鐘內升版會把舊 worker
// 裝進新快取，之後一直拿到舊檔（瀏覽器實測重現過）
check('install 抓外殼繞過 HTTP 快取（cache: reload）', /new Request\(url, \{ cache: 'reload' \}\)/.test(SW));

// withIsolation 本身：抽出來用假的 Response／Headers 跑
{
  const src = SW.match(/const ISOLATION_HEADERS = \{[\s\S]*?\n\};\n\nfunction withIsolation\([\s\S]*?\n\}\n/);
  check('找得到 withIsolation', !!src);
  if (src) {
    class FakeResponse {
      constructor(body, init = {}) { Object.assign(this, { body, type: 'basic' }, init); this.headers = new Headers(init.headers); }
    }
    const fn = new Function('Response', `${src[0]}; return withIsolation;`)(FakeResponse);
    const out = fn(new FakeResponse('x', { status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/html' } }));
    check('補上兩個標頭，原本的標頭還在',
      out.headers.get('Cross-Origin-Embedder-Policy') === 'credentialless' &&
      out.headers.get('Cross-Origin-Opener-Policy') === 'same-origin' &&
      out.headers.get('Content-Type') === 'text/html' && out.status === 200);
    const opaque = { type: 'opaque', status: 0 };
    check('opaque 回應原樣交回（不能重包）', fn(opaque) === opaque);
  }
}

// ── 2. 第一次造訪重整一次，SW 更新不重整 ─────────────────────────────────
check('只在「載入時沒有 controller」時重整',
  /const firstVisit = !navigator\.serviceWorker\.controller;/.test(HTML) &&
  /if \(firstVisit && !self\.crossOriginIsolated\) location\.reload\(\);/.test(HTML));

// ── 3. worker 的執行緒數 ─────────────────────────────────────────────────
{
  const src = WORKER.match(/function pickThreads\([\s\S]*?\n\}\n/);
  check('找得到 pickThreads', !!src);
  if (src) {
    const pick = (selfObj, requested) => new Function('self', `${src[0]}; return pickThreads;`)(selfObj)(requested);
    const isolated = cores => ({ crossOriginIsolated: true, navigator: { hardwareConcurrency: cores } });
    check('沒有隔離 → 1（Safari、第一次造訪）', pick({ crossOriginIsolated: false, navigator: { hardwareConcurrency: 8 } }) === 1);
    check('隔離、6 核 → 4（上限）', pick(isolated(6)) === 4);
    check('隔離、2 核 → 2', pick(isolated(2)) === 2);
    check('?threads=2 可覆蓋', pick(isolated(8), 2) === 2);
    check('沒有隔離時 ?threads 也不能硬開（沒有 SharedArrayBuffer）', pick({ crossOriginIsolated: false }, 4) === 1);
  }
}
check('只在第一次建 session 前設定 numThreads', /if \(!state\.encSession\) ort\.env\.wasm\.numThreads = pickThreads\(options\.threads\);/.test(WORKER));
check('threads 一路從 load 訊息傳到 worker',
  /threads: msg\.threads/.test(WORKER) && /type: 'load', baseUrl: base, variant, useOpfs, threads/.test(ENGINE));

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exitCode = failed ? 1 : 0;
