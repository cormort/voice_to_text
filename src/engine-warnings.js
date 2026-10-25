// 引擎／worker 的警告集中處理（把「靜默失敗」變成看得到的東西）。
//
// 為什麼要有這支：Underdog 的 431.9 MB 權重那次事故，worker 明明有送出
// `{ type: 'warn', phase: 'cache', message }`，但主執行緒只印一行 console.warn，
// 然後彈一個**看不出原因的**通用 toast，而且每個檔案彈一次 —— 於是「配額爆掉、
// 每次重抓 430 MB」在畫面上完全看不出來。
//
// 這裡的規則：
//   * 每一則都進 console（完整訊息）
//   * 每一則都進 history（window.__engineWarnings，給診斷頁與自動化測試讀）
//   * 同一個 engine＋phase 在 dedupeMs 內只彈一次 toast（避免一次載入噴五次）
//   * toast 一定要帶 phase 與「原始訊息」，不能只說「失敗了」

export const WARN_HISTORY_LIMIT = 20;
export const WARN_DEDUPE_MS = 60000;

export function trimMessage(message, max = 160) {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '(沒有訊息)';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * @param {object} deps
 *   showToast  — 顯示提示（必填）
 *   label      — 回傳前綴文案的函式，例如 t().engineWarn（可選）
 *   now        — 時鐘（測試用）
 *   historyLimit / dedupeMs — 可調
 */
export function createWarningSink({ showToast, label = () => '本機作業警告', now = Date.now, historyLimit = WARN_HISTORY_LIMIT, dedupeMs = WARN_DEDUPE_MS } = {}) {
  const history = [];
  const lastByKey = new Map();
  let toastFailures = 0;

  function report(engine, phase, message, extra = {}) {
    // extra.silent：只進 console 與 history，不彈 toast（例如「從 400 MB 續傳」）
    const entry = {
      at: new Date(now()).toISOString(),
      engine: String(engine || 'unknown'),
      phase: String(phase || 'unknown'),
      message: trimMessage(message),
      ...extra,
    };
    console.warn(`[${entry.engine}] ${entry.phase}: ${entry.message}`);
    history.push(entry);
    if (history.length > historyLimit) history.shift();

    if (extra.silent) return entry;

    const key = `${entry.engine}:${entry.phase}`;
    // 用 has() 判斷「有沒有前一次」：時鐘從 0 開始時，`lastByKey.get(key) || 0` 會讓
    // 第一則就被當成「剛講過」而靜音（假時鐘的測試就是這樣抓到的）
    if (lastByKey.has(key) && now() - lastByKey.get(key) < dedupeMs) return entry;
    lastByKey.set(key, now());

    try {
      showToast(`${label()}（${entry.phase}）：${entry.message}`);
    } catch (error) {
      toastFailures += 1;                                // toast 壞掉不能連帶影響載入
    }
    return entry;
  }

  return {
    report,
    history: () => history.slice(),
    clear: () => { history.length = 0; lastByKey.clear(); },
    stats: () => ({ count: history.length, toastFailures }),
  };
}

/** 掛到 window，讓診斷頁與自動化測試看得到（不影響功能） */
export function exposeWarnings(sink, target = typeof window !== 'undefined' ? window : null) {
  if (!target) return sink;
  target.__engineWarnings = {
    history: () => sink.history(),
    clear: () => sink.clear(),
    stats: () => sink.stats(),
  };
  return sink;
}

// 站上只有一份 history：三個引擎（Underdog／Whistle／Whisper）都往同一個 sink 報告，
// window.__engineWarnings 才看得到全部。各自 new 一個的話，後建立的會蓋掉前面的。
let sharedSink = null;

export function getSharedWarningSink({ showToast, label } = {}) {
  if (!sharedSink) {
    sharedSink = createWarningSink({
      showToast: showToast || (() => {}),
      label: label || (() => '本機作業警告'),
    });
    exposeWarnings(sharedSink);
  }
  return sharedSink;
}
