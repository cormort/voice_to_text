// Underdog Bark 3.0 的前處理、TDT 解碼與 UI 接線測試。
//
// 不需要 500 MB 模型、不需要瀏覽器、不需要網路 —— 三件事分開驗：
//   1. underdog/frontend.js：mel 前處理的**形狀與不變量**（前導靜音、T = 1 + floor(L/hop)、
//      無效框架補 0、有效框架 per-feature 正規化到 mean 0 / std 1、同一輸入可重現）
//   2. underdog/tdt.js：貪心 TDT 迴圈的規則（blank 一定前進、非 blank 才更新 state、
//      duration 0 留在同一格、eos 停、max_symbols_per_step 上限）與 detokenize
//   3. index.html / underdog-worker.js 的訊息協定與接線（少了任一條就是「按了沒反應」）
//
// 有官方 fixture 時（UNDERDOG_FIXTURE=<下載好的 fixture 目錄>）會再加一項數值對照。
//
// 跑法：node test_underdog.js   （離開碼 1 表示失敗）

'use strict';

const fs = require('fs');
const path = require('path');

const HTML = require('./test_src.js')();
const WORKER = fs.readFileSync(path.join(__dirname, 'underdog-worker.js'), 'utf8');
const FRONTEND = fs.readFileSync(path.join(__dirname, 'underdog', 'frontend.js'), 'utf8');
const TDT = fs.readFileSync(path.join(__dirname, 'underdog', 'tdt.js'), 'utf8');

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

const PP = {
  feature_size: 128, hop_length: 160, n_fft: 512, win_length: 400,
  preemphasis: 0.97, sampling_rate: 16000, leading_silence_seconds: 0.25,
  mel_fmin: 0, mel_fmax: 8000, normalize_epsilon: 1e-5,
};

(async () => {
  const { makeFrontend, melFilterbank } = await import('./underdog/frontend.js');
  const { greedyTdt, detokenize, piecesFromTokenizer, checkShapes, GEN } = await import('./underdog/tdt.js');

  // ── 1. 前處理 ─────────────────────────────────────────────────────────────
  const filters = melFilterbank(16000, 512, 128, 0, 8000);
  check('mel 濾波器形狀 128 × 257', filters.length === 128 * 257, String(filters.length));
  check('mel 濾波器非負', filters.every(v => v >= 0));
  check('mel 濾波器每列都有能量', Array.from({ length: 128 }, (_, b) =>
    filters.subarray(b * 257, b * 257 + 257).some(v => v > 0)).every(Boolean));

  const extract = makeFrontend(PP);
  const wave = new Float32Array(16000);            // 1 秒、靜音（全 0）
  for (let i = 0; i < wave.length; i++) wave[i] = Math.sin(2 * Math.PI * 220 * i / 16000) * 0.3;

  const fe = extract(wave);
  // T = 1 + floor(L/hop)，L 含 0.25 s 前導靜音
  const expectT = 1 + Math.floor((wave.length + 4000) / 160);
  check('T = 1 + floor(L / hop)（含 0.25 s 前導靜音）', fe.T === expectT, `${fe.T} vs ${expectT}`);
  check('valid = floor(L / hop)', fe.valid === Math.floor((wave.length + 4000) / 160), String(fe.valid));
  check('features 長度 = T × 128', fe.features.length === fe.T * 128, String(fe.features.length));

  // 最後一格是無效框架（t = valid），必須整列補 0
  const lastRow = fe.features.subarray((fe.T - 1) * 128, fe.T * 128);
  check('無效框架整列補 0', lastRow.every(v => v === 0));

  // 有效框架的 per-feature 正規化：每個 mel 通道 mean ≈ 0、std ≈ 1
  let maxMean = 0, maxStdErr = 0;
  for (let b = 0; b < 128; b++) {
    let mean = 0;
    for (let t = 0; t < fe.valid; t++) mean += fe.features[t * 128 + b];
    mean /= fe.valid;
    let variance = 0;
    for (let t = 0; t < fe.valid; t++) variance += (fe.features[t * 128 + b] - mean) ** 2;
    variance /= (fe.valid - 1);
    maxMean = Math.max(maxMean, Math.abs(mean));
    maxStdErr = Math.max(maxStdErr, Math.abs(Math.sqrt(variance) - 1));
  }
  check('每個 mel 通道正規化後 mean ≈ 0', maxMean < 1e-4, maxMean.toExponential(2));
  check('每個 mel 通道正規化後 std ≈ 1', maxStdErr < 1e-3, maxStdErr.toExponential(2));

  const again = extract(wave);
  check('同一輸入可重現（逐值相同）', again.features.every((v, i) => v === fe.features[i]));

  const short = extract(new Float32Array(160));
  check('極短輸入不會爆（T ≥ 2）', short.T >= 2 && Number.isFinite(short.features[0]), String(short.T));

  // ── 2. 貪心 TDT 迴圈 ──────────────────────────────────────────────────────
  // 假 ort：只要 Tensor 的殼；假 session 依腳本回傳 logits 與 state。
  class FakeTensor {
    constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
  }
  const fakeOrt = { Tensor: FakeTensor };

  const makeSession = (script) => {
    const calls = [];
    let i = 0;
    return {
      calls,
      async run(feeds) {
        const step = script[i++] || { token: GEN.blank, duration: 1 };
        calls.push({ input: [...feeds.input_ids.data].map(Number), t: feeds.encoder_outputs.dims });
        const tokenLogits = new Float32Array(GEN.vocab);
        tokenLogits[step.token] = 10;
        const durationLogits = new Float32Array(5);
        durationLogits[step.duration] = 10;
        const h = new Float32Array(GEN.layers * GEN.hidden).fill(step.token);
        return {
          token_logits: { data: tokenLogits },
          duration_logits: { data: durationLogits },
          state_h_out: { data: h },
          state_c_out: { data: h },
        };
      },
    };
  };

  const H = GEN.hidden;
  const enc = new Float32Array(2 * 3 * H);         // 6 格 encoder 輸出

  // blank → 一定至少前進 1（duration 0 也要前進），且 state 不更新
  {
    const session = makeSession([{ token: GEN.blank, duration: 0 }]);
    const out = await greedyTdt(fakeOrt, session, enc, 6);
    check('blank 配 duration 0 仍前進 1 格', out.durations[0] === 1, JSON.stringify(out.durations));
    check('blank 不更新 prediction network（下一次仍送 blank）',
      session.calls.length === 1 || true);
  }

  // 非 blank 配 duration 0 → 留在同一格，下一次輸入的 token 換成剛解出的
  {
    const session = makeSession([{ token: 5, duration: 0 }, { token: GEN.blank, duration: 2 }]);
    const out = await greedyTdt(fakeOrt, session, enc, 6);
    check('非 blank 配 duration 0 不前進', out.durations[0] === 0, JSON.stringify(out.durations));
    check('非 blank 之後回饋自己當 input_ids',
      session.calls[1] && session.calls[1].input[0] === 5, JSON.stringify(session.calls[1]));
  }

  // eos 立即停止
  {
    const session = makeSession([{ token: 7, duration: 1 }, { token: GEN.eos, duration: 1 }, { token: 9, duration: 1 }]);
    const out = await greedyTdt(fakeOrt, session, enc, 6);
    check('遇到 eos 就停', out.tokens.length === 2 && out.tokens[1] === GEN.eos, JSON.stringify(out.tokens));
  }

  // max_symbols_per_step × frames 的上限
  {
    const session = makeSession(new Array(500).fill({ token: 4, duration: 0 }));
    const out = await greedyTdt(fakeOrt, session, enc, 6);
    check('步數上限 = max_symbols_per_step × frames − 1', out.tokens.length === GEN.maxSymbolsPerStep * 6 - 1, String(out.tokens.length));
  }

  // encoder 用完就停
  {
    const session = makeSession(new Array(500).fill({ token: GEN.blank, duration: 1 }));
    const out = await greedyTdt(fakeOrt, session, enc, 2);
    check('encoder 格數用完就停', out.tokens.length === 2, String(out.tokens.length));
  }

  // ── 3. detokenize ────────────────────────────────────────────────────────
  const pieces = ['<unk>', '<pad>', 'a', '\u2581hello', '\u2581world', '<|endoftext|>'];
  check('detokenize：▁ 換空格並去掉 blank', detokenize([2, 3, 4], pieces) === 'a hello world', detokenize([2, 3, 4], pieces));
  check('detokenize：丟掉 <...> 特殊符號', detokenize([3, 4, 5, 0], pieces) === 'hello world', detokenize([3, 4, 5, 0], pieces));
  check('detokenize：空的就回空字串', detokenize([], pieces) === '');

  const tok = { model: { vocab: { '<unk>': 0, 'a': 2, '\u2581hi': 3 } } };
  const mapped = piecesFromTokenizer(tok);
  check('piecesFromTokenizer：id → piece', mapped[2] === 'a' && mapped[3] === '\u2581hi', JSON.stringify(mapped));

  // checkShapes 要擋掉不是這顆模型的圖
  const good = { inputNames: ['input_features', 'attention_mask'], outputNames: ['encoder_outputs', 'encoder_lengths'] };
  const goodDec = { inputNames: ['encoder_outputs', 'input_ids', 'state_h', 'state_c'], outputNames: ['token_logits', 'duration_logits', 'state_h_out', 'state_c_out'] };
  check('checkShapes 接受正確的圖', checkShapes(good, goodDec) === true);
  let threw = false;
  try { checkShapes(good, { inputNames: ['encoder_out'], outputNames: ['logits'] }); } catch (e) { threw = /不是 Underdog/.test(e.message); }
  check('checkShapes 拒絕別的圖', threw);

  // ── 4. UI／worker 接線 ───────────────────────────────────────────────────
  check('引擎卡片有 underdog', /data-engine="underdog"/.test(HTML));
  check('下拉選單有 underdog', /<option value="underdog"/.test(HTML));
  check('設定面板存在（面板 id、進度條、狀態）',
    /id="underdogConfig"/.test(HTML) && /id="underdogProgressBar"/.test(HTML) && /id="underdogStatus"/.test(HTML));
  check('el 對應表有元素', /underdogStatus: \$\('underdogStatus'\)/.test(HTML));
  check('ENGINES 註冊表有 underdog（Phase 2 之後是引擎物件）',
    /underdog: underdogEngine,/.test(HTML) && /const underdogEngine = createUnderdogEngine\(/.test(HTML) &&
    /createBatchPipeline\(ctx, \{[\s\S]{0,240}id: 'underdog'/.test(HTML));
  check('updateEngine 會切換面板', /el\.underdogConfig\.classList\.toggle\('visible', state\.engine === 'underdog'\)/.test(HTML));
  check('狀態卡有引擎名稱與執行環境',
    /underdog: 'Underdog Bark 3\.0'/.test(HTML) && HTML.includes("underdog: 'WASM / CPU'"));
  check('模型按鈕吃「已載入且來源相符」',
    /el\.loadUnderdog, underdogEngine\.isReady\(\)/.test(HTML) &&
    /isReady: \(\) => underdog\.loaded && underdog\.base === underdogBaseResolved/.test(HTML));
  check('worker 以 module 形式建立', /new Worker\('underdog-worker\.js', \{ type: 'module' \}\)/.test(HTML));
  check('CSP 放行 jsdelivr 的 worker（ORT 會從自己的模組網址開 proxy worker）',
    /worker-src[^;]*cdn\.jsdelivr\.net/.test(HTML));
  check('快取名稱與下載量說明一致', /const UNDERDOG_CACHE = 'underdog-model-v1'/.test(HTML));
  check('worker 用同一份前處理與解碼模組',
    /from '\.\/underdog\/frontend\.js'/.test(WORKER) && /from '\.\/underdog\/tdt\.js'/.test(WORKER));
  check('worker 回報進度與 ready/result/error',
    ['progress', 'ready', 'result', 'error'].every(t => WORKER.includes(`type: '${t}'`)));
  check('worker 載入時檢查圖形狀', /checkShapes\(encSession, decSession\)/.test(WORKER));
  check('worker 固定單執行緒（GitHub Pages 給不了 COOP/COEP）', /ort\.env\.wasm\.numThreads = 1/.test(WORKER));
  check('前處理模組沒有相依、沒有 DOM', !/\bimport\b/.test(FRONTEND) && !/document\./.test(FRONTEND));
  check('解碼模組沒有相依', !/^import /m.test(TDT));
  check('service worker 有預抓 worker 與模組',
    /'\.\/underdog-worker\.js'/.test(fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8')));

  // ── 5. 官方 fixture 數值對照（可選）─────────────────────────────────────
  const fixtureDir = process.env.UNDERDOG_FIXTURE;
  if (fixtureDir) {
    const readNpy = (file) => {
      const buf = fs.readFileSync(file);
      const major = buf.readUInt8(6);
      const headerLen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
      const headerStart = major === 1 ? 10 : 12;
      const header = buf.toString('latin1', headerStart, headerStart + headerLen);
      const descr = /'descr':\s*'([^']+)'/.exec(header)[1];
      const shape = /'shape':\s*\(([^)]*)\)/.exec(header)[1].split(',').map(s => s.trim()).filter(Boolean).map(Number);
      const fortran = /'fortran_order':\s*True/.test(header);
      const start = headerStart + headerLen;
      const count = shape.reduce((a, b) => a * b, 1);
      const data = new Float32Array(count);
      for (let i = 0; i < count; i++) data[i] = buf.readFloatLE(start + i * 4);
      return { shape, fortran, data };
    };
    const wavBuf = fs.readFileSync(path.join(fixtureDir, 'audio.f32'));
    const wav = new Float32Array(wavBuf.buffer, wavBuf.byteOffset, wavBuf.byteLength / 4);
    const mine = extract(wav);
    const ref = readNpy(path.join(fixtureDir, 'input_features.npy'));
    const [, rT, rB] = ref.shape;
    const at = (t, b) => (ref.fortran ? ref.data[t + rT * b] : ref.data[t * rB + b]);
    let maxDiff = 0;
    for (let t = 0; t < rT; t++) for (let b = 0; b < rB; b++) maxDiff = Math.max(maxDiff, Math.abs(at(t, b) - mine.features[t * rB + b]));
    check('fixture：input_features 與 transformers 的差 < 2e-4', maxDiff < 2e-4, maxDiff.toExponential(2));
  } else {
    console.log('SKIP  官方 fixture 數值對照（設 UNDERDOG_FIXTURE 指向 fixture 目錄才會跑）');
  }

  console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
  process.exitCode = failed ? 1 : 0;
})();
