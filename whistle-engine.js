// Whistle 引擎呼叫層 —— **只寫一份**，Worker 與主執行緒退路共用。
//
// 為什麼要獨立一支：這個專案踩過「同一組 API 兩份實作、參數對不上就安靜壞掉」的坑
// （sherpa 的 getResult(stream) 少了 stream，每個音塊都丟 TypeError，字幕永遠空白，
// 見 test_sherpa_worker_api.js）。Whistle 的解碼呼叫（malloc、BigInt 長度、語言指標、
// word_timestamps 旗標、輸出緩衝）有好幾個容易寫錯的細節，所以抽成一份：
//   - whistle-worker.js 用 importScripts('./whistle-engine.js')
//   - index.html 的主執行緒退路用 loadScript('whistle-engine.js', 'WhistleEngine')
// 兩條路徑呼叫的是同一份程式碼，不存在「兩份實作漂移」。
//
// 對外介面（全域 WhistleEngine）：
//   loadModel(module, arrayBuffer) -> number（needle_models：1 = 文字、2 = 語音）
//   transcribe(module, float32, language) -> { text, language, words, ttftMs, decodeTps, ms }
//   MAX_SAMPLES / OUT_CAPACITY：needle.h 的 30 秒上限與輸出緩衝大小

var WhistleEngine = (() => {
  'use strict';

  // needle_transcribe 回傳 JSON（逐字稿＋詞級時間戳）。320 token 的逐字稿加時間戳
  // 實測在 4 KB 以內，64 KB 非常寬裕；逾時也不會截斷，引擎會回錯誤碼。
  const OUT_CAPACITY = 64 * 1024;
  // needle.h：一次最多 30 秒（16 kHz 單聲道）。餵多了引擎直接拒絕，先在這裡裁掉。
  const MAX_SAMPLES = 30 * 16000;

  // 把 JS 字串寫進 WASM 堆積（含結尾 NUL）。不用 Module.stringToUTF8 是因為那是
  // emscripten 的內部符號，minified 建置不保證掛在 Module 上。
  function writeCString(module, text) {
    const bytes = new TextEncoder().encode(text);
    const pointer = module._malloc(bytes.length + 1);
    module.HEAPU8.set(bytes, pointer);
    module.HEAPU8[pointer + bytes.length] = 0;
    return pointer;
  }

  function loadModel(module, buffer) {
    const bytes = new Uint8Array(buffer);
    const pointer = module._malloc(bytes.length);
    module.HEAPU8.set(bytes, pointer);
    // 長度參數是 unsigned long long → wasm 的 i64，一定要 BigInt；
    // 傳 Number 會直接丟 TypeError（實測：Cannot convert 16919407 to a BigInt）
    const rc = module._needle_load(pointer, BigInt(bytes.length));
    const error = rc < 0 ? module.UTF8ToString(module._needle_last_error()) : '';
    module._free(pointer);
    if (rc < 0) throw new Error(`needle_load 失敗（${rc}）：${error}`);
    return module._needle_models();
  }

  function transcribe(module, audio, language) {
    const samples = Math.min(audio.length, MAX_SAMPLES);
    if (!samples) return { text: '', language: '', words: [], ttftMs: 0, decodeTps: 0, ms: 0 };

    const started = Date.now();
    const pcm = module._malloc(samples * 4);
    // Float32 視圖必須在 malloc 之後才建立：malloc 可能讓記憶體成長、舊視圖被 detach
    new Float32Array(module.HEAPU8.buffer, pcm, samples).set(audio.subarray(0, samples));

    // 語言只認 en/de/fr/es/it/nl/pl 或 NULL（自動偵測）；其他代碼不是「猜錯」而是不存在的值
    const languagePointer = language ? writeCString(module, language) : 0;
    const out = module._malloc(OUT_CAPACITY);
    try {
      // keywords 傳 0（不做關鍵詞偏置）、word_timestamps 傳 1（要詞級時間戳）
      module._needle_transcribe(pcm, samples, languagePointer, 0, 1, out, OUT_CAPACITY);
      const parsed = JSON.parse(module.UTF8ToString(out) || '{}');
      return {
        text: String(parsed.text || '').trim(),
        language: String(parsed.language || ''),
        words: Array.isArray(parsed.words) ? parsed.words : [],
        ttftMs: Number(parsed.ttft_ms) || 0,
        decodeTps: Number(parsed.decode_tps) || 0,
        ms: Date.now() - started
      };
    } finally {
      module._free(out);
      if (languagePointer) module._free(languagePointer);
      module._free(pcm);
    }
  }

  return { OUT_CAPACITY, MAX_SAMPLES, writeCString, loadModel, transcribe };
})();
