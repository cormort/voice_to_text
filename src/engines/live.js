// 串流引擎的共用生命週期（Phase 2 第二部分）。
//
// 批次引擎（batch.js）是「收完一段才推論」，串流引擎是「一邊餵一邊吐字」。
// 這裡把兩者的**外殼**統一：一樣是 start() / stop() / isBusy() / reset()，
// 差別只在於怎麼餵音塊、停止時要不要 flush 最後一句、以及結果怎麼吐。
//
// 引擎只負責兩件事（spec.attach）：
//   attach({ emit, isActive }) -> { push(chunk), flush?() }
//     emit(h)      h = { type: 'partial' | 'final' | 'error', text }
//     isActive()   這一輪是否還有效（換場、停止之後就不要再吐字）
//     push(chunk)  把音塊送進引擎（Vosk 的 acceptWaveform、sherpa 的 worker postMessage…）
//     flush()      停止前補靜音、收最後一句（可選）
//
// 於是 sherpa（Worker／主執行緒兩種模式）與 Vosk（recognizer 事件）只剩
// 「怎麼餵、怎麼收尾」的差異；啟停、字幕套用、錯誤計數只有一份。

/**
 * @param {object} ctx  el / t / state / commit / showToast / AudioCapture / setLevel /
 *                      begin / finish / render / updateButtons / traditional
 * @param {object} spec id, role, canStart(), attach, onError?
 */
export function createLiveEngine(ctx, spec) {
  const {
    el, t, state, commit, showToast, AudioCapture, setLevel,
    begin, finish, render, updateButtons, traditional = v => v,
  } = ctx;

  const { id, role = 'live', canStart = () => true, attach, onError = () => {} } = spec;

  const runtime = { sessionId: 0, session: null, controls: null, feedErrors: 0 };
  let closed = false;

  const isBusy = () => !!runtime.controls;

  function makeSink(sessionId) {
    const isActive = () => !closed && state.running && sessionId === runtime.sessionId;
    return {
      isActive,
      emit: hypothesis => {
        if (!hypothesis) return;
        if (sessionId !== runtime.sessionId) return;
        if (!state.running && hypothesis.type !== 'final') return;
        const text = traditional(String(hypothesis.text || ''));
        if (hypothesis.type === 'partial') {
          state.interim = text;
          render();
          return;
        }
        if (hypothesis.type === 'final') {
          if (!text) return;
          state.interim = '';
          commit(text);
          return;
        }
        // 'error'
        runtime.feedErrors += 1;
        onError(hypothesis);
      },
    };
  }

  async function start() {
    if (!canStart()) return showToast(t().loadFirst);
    runtime.sessionId += 1;
    runtime.feedErrors = 0;
    closed = false;

    begin();
    state.running = true;
    state.stopping = false;
    updateButtons();
    el.engine.disabled = el.lang.disabled = true;

    const sink = makeSink(runtime.sessionId);
    try {
      // 先建 AudioCapture，再 attach：有些引擎（Vosk）需要 AudioContext 才能把
      // Float32Array 包成 AudioBuffer，所以要把 context 一起給它。
      runtime.session = new AudioCapture((chunk, level) => {
        if (!sink.isActive() || state.stopping) return;
        try {
          runtime.controls?.push?.(chunk);
        } catch (error) {
          console.warn(`${id} audio chunk ignored:`, error);
        }
        if (level != null) setLevel(level);
      }, setLevel);
      runtime.controls = await attach({
        emit: sink.emit,
        isActive: sink.isActive,
        // 注意：AudioCapture 的 AudioContext 是在 start() 才建立（建構時是 null），
        // 所以這裡給的是 getter 而不是值。給值的版本會讓 Vosk 在 push 時拿到 null，
        // 例外又被 push 的 try/catch 吞掉 → 看起來「有在收音但永遠不出字」。
        getContext: () => runtime.session?.context ?? null,
      });
      await runtime.session.start();
    } catch (error) {
      console.error(error);
      showToast(t().mic);
      await stop();
    }
  }

  async function stop() {
    if (state.stopping && closed) return;
    state.stopping = true;
    state.running = false;
    updateButtons();

    const controls = runtime.controls;
    try {
      await controls?.flush?.();
    } catch (error) {
      console.warn(`${id} flush failed:`, error);
    } finally {
      closed = true;
      try {
        await runtime.session?.stop();
      } catch (error) {
        console.warn(`${id} audio session cleanup failed:`, error);
      }
      runtime.session = null;
      runtime.controls = null;
      finish();
    }
  }

  function reset() {
    runtime.feedErrors = 0;
  }

  return { id, role, runtime, start, stop, isBusy, reset };
}
