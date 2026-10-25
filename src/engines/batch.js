// 批次引擎的共用生命週期（Phase 2 的介面收斂）。
//
// 為什麼要有這支：Whisper、Whistle、Underdog 這三個引擎的「排隊 → 逐段推論 → commit →
// 停止時等收尾」是同一段邏輯，各自複製了一份（約 80 行 × 3）。三份的差異只有：
//   * 送進去的音訊要不要帶語言
//   * 推論怎麼呼叫（transformers.js / needle / onnxruntime-web）
//   * 失敗訊息與「裝置掉線」這類善後
//   * 分段上限與佇列上限
// 所以這裡只留一份狀態機，其餘用 spec 注入。
//
// 介面（所有引擎都長這樣，含非批次引擎）：
//   id, role('live'|'refine'|'fallback'|'cloud'), runtime, start(), stop(),
//   enqueue(audio), drain(), drainAll(), isBusy(), reset()
//
// runtime 是「引擎自己的狀態物件」（佇列、目前 session、VAD…）。刻意由呼叫端傳進來，
// 而不是包在 pipeline 裡面，這樣 index.html 時代留下的 `whistle.queue` 之類的讀取
// 不需要全部改寫，除錯時也還看得到同一個物件。

/**
 * @param {object} ctx  共用環境：el / t / state / commit / showToast / AudioCapture /
 *                      createVad / vadPush / vadFlush / setLevel / render / begin / finish /
 *                      updateButtons / metricsSubmit / metricsCommit
 * @param {object} spec 引擎差異：
 *   id, role, runtime, segmentSeconds, maxQueued, queueFullMessage(),
 *   canStart(), describe(audio) -> 附加欄位, transcribe(job) -> text,
 *   onInferenceError(error) -> void, engineName（metrics 用，預設等於 id）
 */
export function createBatchPipeline(ctx, spec) {
  const {
    el, t, state, commit, showToast, AudioCapture, createVad, vadPush, vadFlush,
    setLevel, render, begin, finish, updateButtons, metricsSubmit, metricsCommit,
  } = ctx;

  const {
    id, role = 'refine', engineName = id, runtime,
    segmentSeconds = 15, maxQueued = 3,
    queueFullMessage = () => '', canStart = () => true,
    describe = () => ({}), transcribe, onInferenceError = () => {},
  } = spec;

  runtime.queue = runtime.queue || [];
  runtime.sessionId = runtime.sessionId || 0;
  runtime.drainPromise = runtime.drainPromise || null;
  runtime.vad = runtime.vad || null;
  runtime.session = runtime.session || null;
  runtime.dropWarned = runtime.dropWarned || false;

  const isBusy = () => !!runtime.drainPromise || runtime.queue.length > 0;

  function enqueue(audio) {
    runtime.queue.push({
      ...describe(audio),
      audio,
      sessionId: runtime.sessionId,
      job: metricsSubmit(engineName, audio.length),
    });
    // 回壓：本機推論可能比即時慢，佇列無限成長會讓「停止」等不完
    while (runtime.queue.length > maxQueued) {
      runtime.queue.shift();
      if (!runtime.dropWarned) {
        runtime.dropWarned = true;
        showToast(queueFullMessage());
      }
    }
    void drain();
  }

  function drain() {
    if (runtime.drainPromise) return runtime.drainPromise;
    const processingSessionId = runtime.sessionId;

    runtime.drainPromise = (async () => {
      try {
        while (runtime.queue.length > 0) {
          const job = runtime.queue.shift();
          if (!job || job.sessionId !== processingSessionId) continue;

          const pending = runtime.queue.length;
          el.statusState.textContent = pending > 0 ? `${t().processing}（+${pending}）` : t().processing;
          try {
            const text = String((await transcribe(job)) || '').trim();
            metricsCommit(job.job, text);
            if (job.sessionId === runtime.sessionId && text) commit(text);
          } catch (error) {
            console.error(`${id} inference failed:`, error);
            onInferenceError(error);
          }
        }
      } finally {
        runtime.drainPromise = null;
        if (state.running) el.statusState.textContent = t().listening;
        if (runtime.queue.length > 0) void drain();
      }
    })();

    return runtime.drainPromise;
  }

  async function drainAll() {
    while (runtime.drainPromise || runtime.queue.length > 0) {
      await (runtime.drainPromise || drain());
    }
  }

  async function start() {
    if (!canStart()) return showToast(t().loadFirst);

    if (isBusy()) {
      state.stopping = true;
      updateButtons();
      el.statusState.textContent = t().processing;
      try {
        await drainAll();
      } catch (error) {
        console.error(`Failed to drain the previous ${id} session:`, error);
        state.stopping = false;
        updateButtons();
        return;
      }
      state.stopping = false;
    }

    begin();
    state.running = true;
    state.stopping = false;
    runtime.sessionId += 1;
    runtime.queue = [];
    runtime.dropWarned = false;
    updateButtons();
    el.engine.disabled = el.lang.disabled = true;

    const vad = createVad(segmentSeconds);
    runtime.vad = vad;

    try {
      runtime.session = new AudioCapture((chunk, rms) => {
        if (!state.running || state.stopping) return;
        const utterance = vadPush(vad, chunk, rms);
        state.interim = vad.speaking ? t().capturing : '';
        render();
        if (utterance) enqueue(utterance);
      }, setLevel);
      await runtime.session.start();
    } catch (error) {
      console.error(error);
      showToast(t().mic);
      await stop();
    }
  }

  async function stop() {
    if (state.stopping) return;
    state.stopping = true;
    state.running = false;
    updateButtons();

    const finalAudio = runtime.vad ? vadFlush(runtime.vad) : null;
    if (finalAudio) enqueue(finalAudio);

    try {
      await runtime.session?.stop();
    } catch (error) {
      console.warn(`${id} audio session cleanup failed:`, error);
    } finally {
      runtime.session = null;
    }

    await drainAll();
    finish();
  }

  function reset() {
    runtime.queue = [];
    runtime.vad = null;
    runtime.dropWarned = false;
  }

  return { id, role, engineName, runtime, start, stop, enqueue, drain, drainAll, isBusy, reset };
}
