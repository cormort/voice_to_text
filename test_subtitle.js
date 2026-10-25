// 雙語字幕層（Phase 1）與量測（Phase 0）的接線測試。
//
// 為什麼要這支：字幕層有幾個「壞掉會很安靜」的地方 ——
//   * 翻譯只該在「已結束的句子」觸發（半句去翻，中文會跳三次）
//   * 中文引擎的輸出不能丟進 en→zh 模型（會被翻壞），所以要擋非拉丁為主的句子
//   * 「錄音開始」這種標記不是語音，不該送翻譯
//   * 量測是「有記錄、不影響流程」：HUD 可以關，但 __sttMetrics 一定要有數字
//   * 翻譯模型（114 MB）不能在開頁時下載，只能在真的要用時載
//
// 真正的模型推論在瀏覽器裡驗（uitest-mt.mjs），這裡只驗純邏輯與接線，零依賴、零網路。
//
// 跑法：node test_subtitle.js   （離開碼 1 表示失敗）

'use strict';

const fs = require('fs');
const path = require('path');

const HTML = require('./test_src.js')();
const WORKER = fs.readFileSync(path.join(__dirname, 'mt-worker.js'), 'utf8');
const SW = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

// ── 從 index.html 抽出純函式來跑（與 test_vad.js 同一招）────────────────────
function extract(name) {
  const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}\\n`);
  const match = HTML.replace(/\r\n/g, '\n').match(re);
  if (!match) throw new Error(`extract failed: ${name}`);
  return match[0];
}

// isLatinDominated 在 2026-10 搬到 src/util.js（純函式），直接載入實作來測
const helpers = require('./src/util.js');

// ── 1. 該翻與不該翻 ─────────────────────────────────────────────────────
check('英文句子要翻', helpers.isLatinDominated('So the key idea is a state space model.'));
check('中英混雜但以英文為主仍要翻', helpers.isLatinDominated('這個 attention mechanism 換成 state space model'));
check('中文句子不翻（免得被 en→zh 翻壞）', !helpers.isLatinDominated('這是一個狀態空間模型，取代注意力機制'));
check('空字串不翻', !helpers.isLatinDominated(''));

check('標記句（錄音開始）不進翻譯佇列',
  /function queueTranslation\(segment\) \{[\s\S]*?\/\^--- \.\* ---\$\/\.test\(segment\.text\)/.test(HTML.replace(/\r\n/g, '\n')));
check('已翻過的句子不重複送', /if \(segment\.zh \|\| !isLatinDominated\(segment\.text\)\) return;/.test(HTML));
// 只該有三個呼叫點：commit()、setMtEnabled()（補翻既有段落）、mtScript 切換（重翻）
const queueCalls = (HTML.match(/queueTranslation\(/g) || []).length;
check('翻譯只由 commit()／開啟翻譯／切換字體三處觸發（不是 partial 或 render）',
  queueCalls === 4 &&
  /function commit\(s\) \{[\s\S]*?queueTranslation\(segment\);/.test(HTML.replace(/\r\n/g, '\n')) &&
  !/function render\(\) \{[\s\S]{0,600}?queueTranslation/.test(HTML.replace(/\r\n/g, '\n')),
  `${queueCalls} 個 queueTranslation( 出現（含定義 1 個）`);

// ── 2. 翻譯層的接線 ─────────────────────────────────────────────────────
check('翻譯跑在自己的 worker', /new Worker\('mt-worker\.js', \{ type: 'module' \}\)/.test(HTML));
check('worker 用 transformers.js 3.8.1（4.x 對這顆模型會炸）',
  /@huggingface\/transformers@3\.8\.1/.test(WORKER) && !/transformers@4\./.test(WORKER));
check('worker 走 wasm + q8', /device: 'wasm'/.test(WORKER) && /dtype: 'q8'/.test(WORKER));
check('worker 有 load／translate 兩種訊息與 ready／result／error 回報',
  ['load', 'translate'].every(t => WORKER.includes(`msg.type === '${t}'`)) &&
  ['ready', 'result', 'error'].every(t => WORKER.includes(`type: '${t}'`)));
check('同一句有快取（不重複推論）', /mt\.cache\.has\(key\)/.test(HTML) && /MT_CACHE_LIMIT/.test(HTML));
check('譯文經 OpenCC 轉繁（可選簡體）', /async function toTraditional\(text\)/.test(HTML) && /zt\.script !== 'zh-Hant'/.test(HTML.replace(/mt\.script/g, 'zt.script')));
check('翻譯失敗只降級、不擋辨識', /Translation failed/.test(HTML) && !/catch \(error\) \{[^}]*throw/.test(HTML.slice(HTML.indexOf('async function processMtQueue'))));
check('transformer 模型預設是 opus-mt-en-zh', /MT_DEFAULT_MODEL = 'Xenova\/opus-mt-en-zh'/.test(HTML));
check('模型不會在載入頁面時下載（只在需要時載）',
  !/^(?![\s\S]*if \(p\.mtEnabled\))[\s\S]*ensureMtLoaded\(\)/.test(HTML.split("load();")[0]) &&
  /if \(mt\.enabled\) \{\s*\n\s*el\.mtStatus\.textContent = t\(\)\.mtPending;/.test(HTML.replace(/\r\n/g, '\n')));
check('worker 進 service worker 外殼快取', /'\.\/mt-worker\.js'/.test(SW));

// ── 3. 字幕條與浮動視窗 ─────────────────────────────────────────────────
check('字幕條元素存在（中文大字＋原文小字）',
  /id="subtitleBar"/.test(HTML) && /class="subtitle-zh"/.test(HTML) && /class="subtitle-en"/.test(HTML));
check('只留最近兩句', /function recentSubtitleSegments\(n = 2\)/.test(HTML));
check('字幕條會跳過標記句', /\/\^--- \.\* ---\$\/\.test\(segment\.text\)\) continue;/.test(HTML));
// 關窗的 pagehide 先把 pipWindow 設成 null，任何「在 if (pipWindow) 裡才復原」的 inline
// display 都會漏掉 —— 關過一次浮動窗，主視窗字幕條就永遠看不到。主字幕條只准用 hidden 控制。
check('主視窗字幕條不用 inline display 控制（關浮動窗後才會回來）', !/subtitleBar\.style\.display/.test(HTML));
// 全大寫輸入會讓 Marian 陷入「3 3 3 3…」的重複迴圈（實機踩過），兩道防線都要在
check('翻譯前把全大寫轉小寫、並限制重複 n-gram',
  /text === text\.toUpperCase\(\) \? text\.toLowerCase\(\)/.test(WORKER) && /no_repeat_ngram_size:\s*3/.test(WORKER));
check('Document PiP 有支援檢查與退路',
  /'documentPictureInPicture' in window/.test(HTML) && /t\(\)\.pipUnsupported/.test(HTML) && /t\(\)\.pipFailed/.test(HTML));
check('浮動視窗會複製樣式並共用同一個渲染函式',
  /querySelectorAll\('style, link\[rel="stylesheet"\]'\)/.test(HTML) && /function subtitleTargets\(\)/.test(HTML));
check('字幕大小可調且作用到浮動視窗', /function applySubScale\(value\)/.test(HTML) && /--sub-zh/.test(HTML));

// ── 4. 量測（Phase 0）───────────────────────────────────────────────────
check('量測有 submit／commit 兩個端點', /function metricsSubmit\(engine, samples\)/.test(HTML) && /function metricsCommit\(job, text\)/.test(HTML));
// Phase 2：量測改由共用的批次 pipeline 打點一次，三個引擎只要宣告自己的 id
check('每個批次引擎都經過同一條 pipeline（量測不會漏掉任何一個）',
  /id: 'whisper'/.test(HTML) && /id: 'whistle'/.test(HTML) && /id: 'underdog'/.test(HTML) &&
  /metricsSubmit\(engineName, audio\.length\)/.test(HTML) &&
  (HTML.match(/metricsCommit\(job\.job, text\)/g) || []).length === 1 &&
  /metricsSubmit, metricsCommit/.test(HTML));
check('RTF＝處理時間／音訊長度', /rtf: job\.audioSec > 0 \? Number\(\(latency \/ job\.audioSec\)\.toFixed\(2\)\)/.test(HTML));
check('有 longtask 觀測', /entryTypes: \['longtask'\]/.test(HTML));
check('HUD 預設關閉', /id="metricsHud" hidden/.test(HTML));
check('__sttMetrics 永遠可讀（給自動化測試）', /window\.__sttMetrics = \{ snapshot: metricsSnapshot/.test(HTML));
check('中文與英文都有量測文案', /metricsLatency: '處理延遲'/.test(HTML) && /metricsLatency: 'latency'/.test(HTML));

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exitCode = failed ? 1 : 0;
