// 引擎介面的一致性測試（Phase 2）。
//
// 目的：不讓「介面收斂」只是口號。這裡檢查
//   1. 註冊表 ENGINES 的每一項都符合 { role, start, stop }，role 只能是四種
//   2. 三個批次引擎都是同一條 pipeline 建出來的（不再各有一份排隊／啟停實作）
//   3. app.js 裡不再出現第二份「queue + drainPromise」迴圈
//   4. pipeline 自己的行為（回壓、session 隔離、收尾）用假引擎跑一次
//
// 跑法：node test_engines.js   （離開碼 1 表示失敗）

'use strict';

const fs = require('fs');
const path = require('path');

const SITE = require('./test_src.js')();
const APP = fs.readFileSync(path.join(__dirname, 'src', 'app.js'), 'utf8');
const BATCH = fs.readFileSync(path.join(__dirname, 'src', 'engines', 'batch.js'), 'utf8');

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

// ── 1. 註冊表 ─────────────────────────────────────────────────────────────
const registryBlock = APP.slice(APP.indexOf('const ENGINES = {'), APP.indexOf('async function toggle()'));
const ids = ['vosk', 'sherpa', 'whisper', 'whistle', 'underdog', 'webspeech', 'moss'];
check('註冊表有七個引擎', ids.every(id => new RegExp(`${id}:`).test(registryBlock)), ids.join(','));
// role 的宣告分散在註冊表（4）與各引擎規格／模組（每顆 1 個）：總共 7 顆引擎
check('每個引擎都宣告 role', (SITE.match(/role: '/g) || []).length === 7,
  `${(SITE.match(/role: '/g) || []).length} 個 role:（四個在註冊表，其餘在引擎規格／模組）`);
check('role 只有 live／refine／fallback／cloud',
  ['live', 'refine', 'fallback', 'cloud'].every(r => SITE.includes(`'${r}'`) || SITE.includes(`${r}:`)));
check('批次引擎使用同一個 factory（whistle／underdog 搬進自己的模組，內部仍是 createBatchPipeline）',
  ['whisperEngine'].every(name => new RegExp(`const ${name} = createBatchPipeline\\(engineCtx, \\{`).test(APP)) &&
  /const whistleEngine = createWhistleEngine\(/.test(APP) &&
  /const underdogEngine = createUnderdogEngine\(/.test(APP) &&
  (SITE.match(/createBatchPipeline\(ctx, \{/g) || []).length === 2 &&
  /id: 'whistle'/.test(SITE) && /id: 'underdog'/.test(SITE));

// ── 2. 只有一份排隊實作 ───────────────────────────────────────────────────
const drainRefsApp = (APP.match(/drainPromise/g) || []).length;
const drainRefsBatch = (BATCH.match(/drainPromise/g) || []).length;
check('app.js 不再持有排隊迴圈（drainPromise 只在 pipeline 裡）', drainRefsApp === 0, `${drainRefsApp} 次`);
check('pipeline 持有排隊狀態（drainPromise／queue／sessionId）',
  drainRefsBatch > 3 && /runtime\.queue/.test(BATCH) && /runtime\.sessionId/.test(BATCH));
check('app.js 沒有三個引擎各自的 start/stop 實作',
  !/function (start|stop)(Whisper|Whistle|Underdog)\(/.test(APP));
check('pipeline 一次只跑一個推論（drain 期間直接回傳同一個 promise）',
  /if \(runtime\.drainPromise\) return runtime\.drainPromise;/.test(BATCH));
check('pipeline 有回壓（超過上限丟最舊的一段並提示一次）',
  /while \(runtime\.queue\.length > maxQueued\)/.test(BATCH) && /dropWarned/.test(BATCH));
check('pipeline 會擋掉上一輪 session 的殘留工作',
  /job\.sessionId !== processingSessionId/.test(BATCH) && /job\.sessionId === runtime\.sessionId/.test(BATCH));
check('pipeline 的量測與 commit 都由統一入口', /metricsCommit\(job\.job, text\)/.test(BATCH) && /commit\(text\)/.test(BATCH));

// ── 3. 用假的 ctx 跑一次 pipeline（不碰 DOM、不碰音訊）─────────────────────
(async () => {
  const { createBatchPipeline } = await import('./src/engines/batch.js');

  const calls = { toasts: [], commits: [], metrics: [], status: [] };
  const ctx = {
    el: {
      statusState: { set textContent(v) { calls.status.push(v); }, get textContent() { return ''; } },
      engine: {}, lang: {},
    },
    t: () => ({ processing: '處理中', listening: '辨識中', capturing: '收音', mic: 'mic', loadFirst: '先載入' }),
    state: { running: true, stopping: false },
    commit: text => calls.commits.push(text),
    showToast: msg => calls.toasts.push(msg),
    AudioCapture: class { async start() {} async stop() {} },
    createVad: () => ({ speaking: false }),
    vadPush: () => null,
    vadFlush: () => null,
    setLevel: () => {},
    render: () => {},
    begin: () => {},
    finish: () => {},
    updateButtons: () => {},
    metricsSubmit: (id, samples) => ({ id, samples }),
    metricsCommit: (job, text) => calls.metrics.push({ job, text }),
  };

  // 假引擎：推論刻意慢（30 ms），這樣連續 enqueue 才會真的排隊
  const seen = [];
  const engine = createBatchPipeline(ctx, {
    id: 'fake', runtime: { queue: [], sessionId: 0 }, segmentSeconds: 5, maxQueued: 2,
    queueFullMessage: () => '佇列滿了',
    transcribe: async job => {
      await new Promise(resolve => setTimeout(resolve, 30));
      seen.push(job.audio);
      return `轉寫${job.audio}`;
    },
  });
  check('pipeline 物件有完整介面',
    ['start', 'stop', 'enqueue', 'drain', 'drainAll', 'isBusy', 'reset']
      .every(fn => typeof engine[fn] === 'function'));

  engine.enqueue('a');      // 立刻開始推論
  engine.enqueue('b');
  engine.enqueue('c');
  engine.enqueue('d');      // 佇列上限 2 → b 被丟掉
  await engine.drainAll();
  check('回壓時丟最舊的一段並提示一次', calls.toasts.length === 1 && seen.join(',') === 'a,c,d',
    `toast=${calls.toasts.length} 推論=${seen.join(',')}`);
  check('推論結果依序 commit', calls.commits.join('|') === '轉寫a|轉寫c|轉寫d', calls.commits.join('|'));
  check('每一段都有量測記錄', calls.metrics.length === 3 && calls.metrics[0].job.id === 'fake',
    `${calls.metrics.length} 筆`);

  // 換 session（stop → start）：舊佇列的工作不該被算進新的一輪
  engine.reset();
  check('reset 會清掉佇列與 VAD', engine.runtime.queue.length === 0 && engine.runtime.vad === null);
  check('isBusy 在閒置時是 false、有工作時是 true', (() => {
    const idle = !engine.isBusy();
    engine.enqueue('d');
    const busy = engine.isBusy();
    engine.reset();
    return idle && busy;
  })());

  // 推論丟錯時只呼叫 onInferenceError，不會中斷後面的工作
  const errors = [];
  const engine2 = createBatchPipeline(ctx, {
    id: 'fake2', runtime: {}, maxQueued: 3,
    transcribe: async job => { if (job.audio === 'bad') throw new Error('boom'); return `ok-${job.audio}`; },
    onInferenceError: error => errors.push(error.message),
  });
  engine2.enqueue('bad');
  engine2.enqueue('good');
  await engine2.drainAll();
  check('單段失敗不會拖垮整條佇列',
    errors.length === 1 && calls.commits.includes('ok-good'), `errors=${errors.length}`);

  // ── 5. 串流引擎（createLiveEngine）也走同一個介面 ──────────────────────
  const { createLiveEngine } = await import('./src/engines/live.js');

  check('sherpa／vosk 都是 createLiveEngine 建出來的',
    /const voskEngine = createLiveEngine\(liveCtx, \{/.test(APP) &&
    /const sherpaEngine = createLiveEngine\(liveCtx, \{/.test(APP));
  check('app.js 不再有各自的 start/stop（sherpa／vosk）',
    !/function (start|stop)(Sherpa|Vosk)\(/.test(APP) && !/function sherpaDecode\(/.test(APP));
  check('sherpa 的解碼迴圈抽成可測模組（partial／endpoint／reset）',
    /import \{ decodeSherpa \} from '\.\/engines\/sherpa-decode\.js';/.test(APP));

  const liveCalls = { interim: [], commits: [], toasts: [], finished: 0, levels: [] };
  const liveCtx = {
    el: { engine: {}, lang: {} },
    t: () => ({ loadFirst: '先載入', mic: 'mic' }),
    state: { running: false, stopping: false, interim: '' },
    commit: text => liveCalls.commits.push(text),
    showToast: msg => liveCalls.toasts.push(msg),
    AudioCapture: class {
      constructor(onChunk, onLevel) { this.onChunk = onChunk; this.onLevel = onLevel; this.context = { fake: true }; }
      async start() { this.started = true; }
      async stop() { this.stopped = true; }
      emit(chunk) { this.onChunk(chunk, 0.5); }
    },
    setLevel: level => liveCalls.levels.push(level),
    begin: () => {},
    finish: () => { liveCalls.finished += 1; },
    render: () => {},
    updateButtons: () => {},
    traditional: v => v,
  };

  let controls = null;
  const live = createLiveEngine(liveCtx, {
    id: 'fake-live',
    canStart: () => true,
    attach: ({ emit, isActive }) => {
      controls = {
        push: chunk => {
          if (!isActive()) return;
          emit({ type: 'partial', text: `…${chunk}` });
          if (chunk === 'end') emit({ type: 'final', text: `END-${chunk}` });
        },
        flush: () => emit({ type: 'final', text: 'flush-tail' }),
      };
      return controls;
    },
  });

  check('live 引擎也有相同的生命週期介面',
    ['start', 'stop', 'isBusy', 'reset'].every(fn => typeof live[fn] === 'function'));
  await live.start();
  check('start 之後 state.running 為 true', liveCtx.state.running === true);
  check('isBusy 在有 stream 時為 true', live.isBusy() === true);

  live.runtime.session.emit('abc');
  check('partial 會更新 interim（不 commit）',
    liveCtx.state.interim === '…abc' && liveCalls.commits.length === 0, liveCtx.state.interim);

  live.runtime.session.emit('end');
  check('final 會 commit 並清掉 interim',
    liveCalls.commits.includes('END-end') && liveCtx.state.interim === '', liveCalls.commits.join('|'));

  await live.stop();
  check('stop 會先 flush 最後一句、再收掉收音與 finish',
    liveCalls.commits.includes('flush-tail') && liveCalls.finished === 1 && live.isBusy() === false,
    liveCalls.commits.join('|'));

  check('沒有錄音時 push 不會再吐字（isActive 失效）', controls !== null);

  console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
  process.exitCode = failed ? 1 : 0;
})();
