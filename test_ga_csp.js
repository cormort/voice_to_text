// Google Analytics 與 CSP／隱私聲明的一致性測試（不需要瀏覽器、不需要網路）。
//
// 為什麼要這支：這個頁面原本的 CSP **把自己的 GA 擋掉了**，而且失敗是靜默的 ——
// 頁面上「有裝 GA」、gtag() 也叫得到，但 gtag.js 從頭到尾沒下載（實測
// securitypolicyviolation：script-src-elem、transferSize 0），GA 後台一筆資料都沒有。
// 同一個坑有兩個方向：
//   * CSP 收緊時忘了 GA 需要 script-src / connect-src → GA 無聲失效
//   * 為了 GA 放寬成 `script-src *` 之類 → 整個頁面的來源限制形同虛設
// 另外，頁面裝了 GA 之後，隱私聲明就不能再寫「本頁不含任何分析或追蹤程式」——
// 這句話會變成不實陳述。這支測試把三件事釘在一起：放行清單、沒有過度放寬、聲明一致。
//
// 跑法：node test_ga_csp.js   （離開碼 1 表示失敗）

'use strict';

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

// ── 取出 CSP 內容與各指令 ─────────────────────────────────────────────────
const cspMatch = HTML.match(/<meta http-equiv="Content-Security-Policy" content="([\s\S]*?)">/);
check('找得到 CSP meta', !!cspMatch);
if (!cspMatch) { console.log('\n1 項失敗'); process.exitCode = 1; return; }

const csp = cspMatch[1].replace(/\s+/g, ' ');
const directive = (name) => {
  const match = csp.match(new RegExp(`(?:^|; )${name} ([^;]*)`));
  return match ? match[1].trim() : '';
};

// ── 1) GA 需要的放行 ─────────────────────────────────────────────────────
check('script-src 放行 www.googletagmanager.com（gtag.js 本體）',
  directive('script-src').includes('https://www.googletagmanager.com'),
  directive('script-src'));

const connect = directive('connect-src');
check('connect-src 放行 *.google-analytics.com（GA4 的 /g/collect beacon）',
  connect.includes('https://*.google-analytics.com'), connect);
check('connect-src 放行 *.analytics.google.com（部分地區的 GA 端點）',
  connect.includes('https://*.analytics.google.com'), connect);
check('img-src 放行 *.google-analytics.com（不能用 sendBeacon／fetch 時的 pixel 退路）',
  directive('img-src').includes('https://*.google-analytics.com'), directive('img-src'));

// ── 2) 沒有為了 GA 放寬過頭 ───────────────────────────────────────────────
const bareStar = /(^|[ ;])\*(;| |$)/.test(csp);
check('CSP 沒有裸星號來源（`*`）', !bareStar,
  bareStar ? '出現萬用來源' : '（`*` 只出現在 *.hf.co / *.google-analytics.com 這類子網域樣式）');
check('CSP 沒有明文 http: 來源', !/http:\/\//.test(csp));
check('object-src 仍是 none', directive('object-src') === "'none'", directive('object-src'));
check('base-uri 仍是 self', directive('base-uri') === "'self'", directive('base-uri'));
check('default-src 仍是 self', directive('default-src') === "'self'", directive('default-src'));
check('script-src 沒有放行整個 google.com 網域（只放行 googletagmanager）',
  !directive('script-src').includes('*.google.com'), directive('script-src'));

// ── 3) 頁面上的 GA 片段本身 ───────────────────────────────────────────────
check('頁面有 gtag.js 載入與 config 呼叫',
  /googletagmanager\.com\/gtag\/js\?id=G-GHGBM401HN/.test(HTML) && /gtag\('config', 'G-GHGBM401HN'\)/.test(HTML));
check('gtag 片段旁有註解說明「沒有 SRI」的理由（避免有人補上 integrity 反而讓 GA 靜默失效）',
  /沒有 SRI/.test(HTML));

// GA 也不該在解析階段就下載：gtag.js 實測 181 KB（br），是 App 本體 gzip（44.6 KB）的 4 倍
const gaStaticTag = HTML.match(/<script[^>]+src="[^"]*googletagmanager[^"]*"[^>]*>/);
check('index.html 沒有靜態的 gtag <script src>（改成 load 後閒置才下載）',
  !gaStaticTag, gaStaticTag ? gaStaticTag[0].slice(0, 80) : '');
check('GA 由 load／requestIdleCallback 排程載入，且有非 Safari 的退路',
  /requestIdleCallback\(loadAnalytics/.test(HTML) && /addEventListener\('load', scheduleAnalytics/.test(HTML) &&
  /setTimeout\(loadAnalytics, 1200\)/.test(HTML));
check('GA 仍只送 config（沒有自訂事件）且網址與 ID 不變',
  /script\.src = 'https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-GHGBM401HN'/.test(HTML));

// ── 4) 隱私聲明與 GA 一致 ────────────────────────────────────────────────
const conclusions = (HTML.match(/privacyConclusion: '([^']*)'/g) || []).map((line) => line.replace(/^privacyConclusion: '|'$/g, ''));
check('中英文各有一條隱私結論', conclusions.length === 2, `找到 ${conclusions.length} 條`);
const [zh, en] = conclusions;
check('中文聲明不再聲稱「不含任何分析或追蹤程式」',
  !!zh && !/不含任何分析或追蹤/.test(zh), zh ? zh.slice(0, 40) + '…' : '');
check('英文聲明不再聲稱 "no analytics or tracking"',
  !!en && !/no analytics or tracking/i.test(en), en ? en.slice(0, 40) + '…' : '');
check('中文聲明有揭露 Google Analytics', !!zh && /Google Analytics/.test(zh));
check('英文聲明有揭露 Google Analytics', !!en && /Google Analytics/.test(en));
check('中文聲明仍承諾不上傳逐字稿與麥克風音訊',
  !!zh && /逐字稿/.test(zh) && /麥克風音訊/.test(zh));
check('英文聲明仍承諾不上傳 transcript 與 microphone audio',
  !!en && /transcripts/i.test(en) && /microphone audio/i.test(en));

// ── 5) 免責：GA 不該收到音訊或逐字稿 ──────────────────────────────────────
const customEvents = HTML.match(/gtag\('event'/g) || [];
check('頁面沒有送任何自訂 GA 事件（只有 config，不會把引擎／逐字稿內容送出去）',
  customEvents.length === 0, `找到 ${customEvents.length} 個 gtag('event')`);

console.log(`\n${failed === 0 ? '全部通過' : `${failed} 項失敗`}`);
process.exitCode = failed ? 1 : 0;
