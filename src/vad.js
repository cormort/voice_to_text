// 停頓偵測（energy VAD）的兩支純函式：餵音塊、吐完整段。
// 2026-10 從 src/app.js 抽出來，這裡不碰 DOM 也不讀 el —— 門檻放在 v.threshold，
// 由 createVad()（還在 app.js，因為它要讀使用者的靈敏度設定）決定。
import { concat } from './util.js';

// 整條管線都是 16 kHz；抽樣率改變時這裡也要改
const SAMPLE_RATE = 16000;

function vadPush(v, chunk, rms) {
  const ms = chunk.length / SAMPLE_RATE * 1000;

  // 前置緩衝只取「這一塊之前」的音訊：先複製再更新 pre，否則同一塊會先被算進 pre、
  // 又被 push 進 audio，每句開頭都會多出一段重複音訊（2048 samples ≈ 128 ms）
  const preRoll = v.pre.slice();
  v.pre.push(chunk);
  let preN = v.pre.reduce((n, x) => n + x.length, 0);
  while (preN > SAMPLE_RATE * .4 && v.pre.length > 1) {
    preN -= v.pre[0].length;
    v.pre.shift();
  }

  if (rms >= v.threshold) {
    if (!v.speaking) {
      v.speaking = true;
      v.audio = preRoll;
      v.samples = preRoll.reduce((n, x) => n + x.length, 0);
    }
    v.silence = 0;
    v.speech += ms;
    v.audio.push(chunk);
    v.samples += chunk.length;
  } else if (v.speaking) {
    v.silence += ms;
    v.audio.push(chunk);
    v.samples += chunk.length;
  }

  // 收段條件必須在兩條分支「之後」判斷。原本 15 秒上限只寫在靜音分支裡，所以只有
  // 「說完停下來」才會被檢查；一路說不停（每塊都過門檻）時它永遠輪不到 —— 實測
  // 60 秒連續語音切出 0 段、60 秒音訊全積在 v.audio，Whisper 那邊等於完全沒有輸出。
  // 從上限切出來時 v.speaking 會歸零，下一塊若仍在說話會帶 0.4 秒 preRoll 重新起段，
  // 剛好給切點一點重疊，不會把字切一半。
  if (v.speaking && (v.silence >= 800 || v.samples >= (v.maxSamples || SAMPLE_RATE * 15))) {
    const audio = concat(v.audio, v.samples);
    const valid = v.speech >= 800;
    v.speaking = false;
    v.silence = v.speech = v.samples = 0;
    v.audio = [];
    return valid ? audio : null;
  }
  return null;
}

function vadFlush(v) {
  if (v.speaking && v.speech >= 800) {
    const x = concat(v.audio, v.samples);
    v.speaking = false;
    v.audio = [];
    v.samples = 0;
    return x;
  }
  return null;
}

export { vadPush, vadFlush };
