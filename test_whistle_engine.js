// Whistle 真引擎端到端測試（**需要 16.9 MB 的模型檔**，沒有就自動跳過）。
//
// 為什麼要這支：test_whistle_worker_api.js 用假 module 驗協定，抓不到「引擎本身」
// 的問題（wasm 載不起來、模型格式不合、API 參數在真引擎上不成立）。這支跑真的
// whistle.cact，量真的數字。
//
// 模型取得方式（二選一）：
//   curl -L -o whistle.cact https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact
//   WHISTLE_CACT=/path/to/whistle.cact node test_whistle_engine.js
//
// 沒設定 WHISTLE_CACT 時會依序找：./whistle.cact、./.cache/whistle.cact、
// ~/Downloads/whistle.cact。找不到就印訊息並以 0 離開（CI 不會紅）。
//
// 音檔：預設用 macOS 的 say + afconvert 產生 16 kHz 單聲道語音；也可用 WHISTLE_WAV 指定。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const need = (name) => path.join(DIR, name);

function findModel() {
  const candidates = [
    process.env.WHISTLE_CACT,
    need('whistle.cact'),
    need('.cache/whistle.cact'),
    path.join(os.homedir(), 'Downloads/whistle.cact')
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function makeWav(text) {
  const out = path.join(os.tmpdir(), `whistle-test-${process.pid}.wav`);
  const aiff = out.replace(/\.wav$/, '.aiff');
  const say = spawnSync('say', ['-v', 'Samantha', '-o', aiff, text]);
  if (say.status !== 0) return null;
  const convert = spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, out]);
  if (convert.status !== 0) return null;
  return out;
}

function readWavPcm16(file) {
  const buffer = fs.readFileSync(file);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      const count = Math.floor(size / 2);
      const pcm = new Float32Array(count);
      for (let i = 0; i < count; i++) pcm[i] = buffer.readInt16LE(offset + 8 + i * 2) / 32768;
      return pcm;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV 裡找不到 data chunk');
}

(async () => {
  const modelPath = findModel();
  if (!modelPath) {
    console.log('跳過：找不到 whistle.cact（設定 WHISTLE_CACT=/path/to/whistle.cact 即可執行）');
    return;
  }

  const reference = 'Turn off the kitchen lights and set a timer for ten minutes.';
  const wav = process.env.WHISTLE_WAV || makeWav(reference);
  if (!wav) {
    console.log('跳過：無法產生測試語音（需要 macOS 的 say + afconvert，或用 WHISTLE_WAV 指定檔案）');
    return;
  }

  const createNeedle = require(need('needle/needle.js'));
  // 用與瀏覽器相同的方式載入呼叫層（whistle-engine.js 是定義全域的 classic script）
  const vm = require('vm');
  const sandbox = { TextEncoder, Date, JSON, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(need('whistle-engine.js'), 'utf8'), sandbox, { filename: 'whistle-engine.js' });
  const WhistleEngine = sandbox.WhistleEngine;

  let failed = 0;
  const check = (name, pass, detail = '') => {
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
  };

  const started = Date.now();
  const module = await createNeedle({ locateFile: (file) => need(`needle/${file}`), print() {}, printErr() {} });
  const loadStart = Date.now();
  const models = WhistleEngine.loadModel(module, fs.readFileSync(modelPath));
  check('whistle.cact 載入成功且是語音模型（needle_models = 2）', models === 2,
    `${models}／耗時 ${Date.now() - loadStart} ms`);
  if (failed) { process.exitCode = 1; return; }

  const pcm = readWavPcm16(wav);
  const seconds = pcm.length / 16000;
  const output = WhistleEngine.transcribe(module, pcm, null);
  console.log(`參考答案: ${reference}`);
  console.log(`模型輸出: ${output.text}`);
  console.log(`語言: ${output.language}｜音訊 ${seconds.toFixed(2)} s｜耗時 ${output.ms} ms｜RTF ${(output.ms / (seconds * 1000)).toFixed(2)}｜ttft ${output.ttftMs} ms｜${output.decodeTps} tok/s`);

  check('輸出逐字稿不為空', output.text.length > 0);
  // 詞級時間戳：turn off the kitchen lights … 都在
  const words = output.words.map((word) => String(word.word).toLowerCase().replace(/[^a-z0-9]/g, ''));
  check('有詞級時間戳（每個詞都有 start/end/probability）',
    output.words.length >= 8 && output.words.every((word) => typeof word.start === 'number' && typeof word.end === 'number' && typeof word.probability === 'number'),
    `${output.words.length} 個詞`);
  check('關鍵詞都對（kitchen / lights / timer / minutes）',
    ['kitchen', 'lights', 'timer', 'minutes'].every((word) => words.includes(word)), words.join(' '));
  check('RTF < 1（比即時快，才可能當即時字幕的骨幹）', output.ms < seconds * 1000,
    `RTF ${(output.ms / (seconds * 1000)).toFixed(2)}`);

  // 語言參數：指定德文時 needle.h 要求使用七個代碼之一；這裡只驗「指定不會壞」
  const german = WhistleEngine.transcribe(module, pcm, 'de');
  check('指定語言（de）不會丟錯，且回傳結構一致',
    typeof german.text === 'string' && Array.isArray(german.words), `language=${german.language}`);

  console.log(`\n${failed === 0 ? '全部通過' : `${failed} 項失敗`}（總耗時 ${Date.now() - started} ms）`);
  process.exitCode = failed ? 1 : 0;
})();
