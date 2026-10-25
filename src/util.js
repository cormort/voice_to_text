// 純工具函式：不依賴引擎狀態、不綁事件流程，所以可以單獨測。
// 2026-10 從 src/app.js（原本是 index.html 的 IIFE）抽出來。

function stamp(d = new Date()) {
  return `[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}]`;
}

function concat(parts, n) {
  const out = new Float32Array(n);
  let p = 0;
  for (const x of parts) {
    out.set(x, p);
    p += x.length;
  }
  return out;
}

function resample(input, from, to) {
  if (from === to) return input;

  const factor = Math.floor(from / to);
  if (from > to && factor >= 2) {
    // 長度用 ceil 而不是 floor：floor 會把每一塊尾端的 input.length % factor 個 sample
    // 丟掉，而且是「每一塊都丟」—— 48k→16k、2048 samples 時 factor 是 3，2046 之後那
    // 2 個 sample 每塊都不見，約 0.1% 的音訊、一小時累積約 3.5 秒的細碎缺口。
    // ponytail: 尾端不足一組就用實際有的 sample 取平均，不跨塊接續 —— 接續要多帶一份
    // 狀態與生命週期，為了 0.1% 不值得；邊界那一格平均的樣本較少，影響可忽略。
    const filtered = new Float32Array(Math.ceil(input.length / factor));
    for (let i = 0; i < filtered.length; i++) {
      let sum = 0, n = 0;
      for (let j = 0; j < factor && i * factor + j < input.length; j++, n++) sum += input[i * factor + j];
      filtered[i] = sum / n;
    }
    return resample(filtered, from / factor, to);
  }

  const n = Math.max(1, Math.round(input.length * to / from)),
    out = new Float32Array(n), ratio = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * ratio, a = Math.floor(p), b = Math.min(a + 1, input.length - 1), f = p - a;
    out[i] = input[a] * (1 - f) + input[b] * f;
  }
  return out;
}

// 整條管線的音訊取樣率（Vosk 的 acceptWaveform 要跟這個一致）。
// 這支原本在 app.js 裡，搬出來時漏了這個常數 —— 結果 makeAudioBuffer 在瀏覽器裡
// 直接 ReferenceError，而呼叫端的 try/catch 只印了一行 warn，表現就是
// 「有在收音、字幕永遠不出來」。test_util.js 現在會呼叫它，缺常數會直接紅。
const SAMPLE_RATE = 16000;

function makeAudioBuffer(context, data) {
  const b = context.createBuffer(1, data.length, SAMPLE_RATE);
  b.copyToChannel(data, 0);
  return b;
}

function isLatinDominated(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return latin > 0 && latin >= cjk * 2;
}

export { stamp, concat, resample, makeAudioBuffer, isLatinDominated };
