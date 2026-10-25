// Underdog Bark 3.0（Parakeet-TDT）的 log-mel 前處理，從 transformers 的
// ParakeetFeatureExtractor 逐項搬過來（對照匯出端的 export/tdt.py）。純 JS、無相依、
// 不碰 DOM：Worker 與 Node 測試共用同一份。
//
// 參數全部來自模型 repo 的 preprocessor_config.json：
//   0.25 s 前導靜音、pre-emphasis 0.97（第一個樣本保留）、centred STFT
//   n_fft 512 / hop 160、對稱 Hann(400) 置中於 512、power 2.0、128 個 Slaney mel、
//   log(x + 2^-24)、只對有效框架做 per-feature 正規化（unbiased std，eps 加在 std 上）。

const LOG_GUARD = 5.960464477539063e-8;   // 2^-24

// ---- Slaney mel scale（等同 librosa.filters.mel 的預設）----
const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOGSTEP = Math.log(6.4) / 27;

export function hzToMel(f) {
  return f >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(f / MIN_LOG_HZ) / LOGSTEP : f / F_SP;
}
export function melToHz(m) {
  return m >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOGSTEP * (m - MIN_LOG_MEL)) : m * F_SP;
}

// [nMels][nFft/2+1]，與 fixture/mel_filters.npy 的差 < 4e-9（實測）
export function melFilterbank(sr, nFft, nMels, fmin, fmax) {
  const nBins = nFft / 2 + 1;
  const mel = new Float64Array(nMels + 2);
  const lo = hzToMel(fmin), hi = hzToMel(fmax);
  for (let i = 0; i < nMels + 2; i++) mel[i] = melToHz(lo + (hi - lo) * i / (nMels + 1));
  const diff = new Float64Array(nMels + 1);
  for (let i = 0; i < nMels + 1; i++) diff[i] = mel[i + 1] - mel[i];

  const w = new Float32Array(nMels * nBins);
  for (let i = 0; i < nMels; i++) {
    const enorm = 2 / (mel[i + 2] - mel[i]);      // Slaney 面積正規化
    for (let k = 0; k < nBins; k++) {
      const lower = (k * sr / nFft - mel[i]) / diff[i];
      const upper = (mel[i + 2] - k * sr / nFft) / diff[i + 1];
      const v = Math.min(lower, upper);
      w[i * nBins + k] = v > 0 ? v * enorm : 0;
    }
  }
  return w;
}

// ---- 固定長度的 radix-2 實數 FFT ----
export function makeRfft(n) {
  const bits = Math.round(Math.log2(n));
  const rev = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }

  const re = new Float64Array(n), im = new Float64Array(n);
  const outRe = new Float64Array(n / 2 + 1), outIm = new Float64Array(n / 2 + 1);

  return function rfft(input) {
    for (let i = 0; i < n; i++) { re[i] = input[rev[i]]; im[i] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let k = 0; k <= n / 2; k++) { outRe[k] = re[k]; outIm[k] = im[k]; }
    return [outRe, outIm];
  };
}

// 回傳 extract(wave) -> { features: Float32Array(T*128), T, valid }
// wave 必須是單聲道 16 kHz 的 Float32Array（不要自己補前導靜音，這裡會補）。
export function makeFrontend(pp) {
  const nFft = pp.n_fft, hop = pp.hop_length, win = pp.win_length;
  const nMels = pp.feature_size, sr = pp.sampling_rate;
  const filters = melFilterbank(sr, nFft, nMels, pp.mel_fmin, pp.mel_fmax);
  const nBins = nFft / 2 + 1;
  const rfft = makeRfft(nFft);

  const window = new Float64Array(nFft);       // 對稱 Hann(400) 置中於 512，其餘補 0
  {
    const off = (nFft - win) >> 1;
    for (let i = 0; i < win; i++) window[off + i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (win - 1));
  }
  const lead = new Float32Array(Math.round(pp.leading_silence_seconds * sr));
  const eps = pp.normalize_epsilon;

  return function extract(wave) {
    const L = wave.length + lead.length;
    const x = new Float32Array(L);
    x.set(wave, lead.length);
    for (let i = L - 1; i >= 1; i--) x[i] = x[i] - pp.preemphasis * x[i - 1];

    const T = 1 + Math.floor(L / hop);
    const valid = Math.floor(L / hop);
    const pad = nFft >> 1;
    const frame = new Float64Array(nFft);
    const mel = new Float32Array(T * nMels);

    for (let t = 0; t < T; t++) {
      const start = t * hop - pad;
      for (let i = 0; i < nFft; i++) {
        const s = start + i;
        frame[i] = (s >= 0 && s < L ? x[s] : 0) * window[i];
      }
      const [re, im] = rfft(frame);
      for (let b = 0; b < nMels; b++) {
        let acc = 0;
        const row = b * nBins;
        for (let k = 0; k < nBins; k++) acc += (re[k] * re[k] + im[k] * im[k]) * filters[row + k];
        mel[t * nMels + b] = Math.log(acc + LOG_GUARD);
      }
    }

    const mean = new Float64Array(nMels), std = new Float64Array(nMels);
    for (let t = 0; t < valid; t++) for (let b = 0; b < nMels; b++) mean[b] += mel[t * nMels + b];
    for (let b = 0; b < nMels; b++) mean[b] /= valid;
    for (let t = 0; t < valid; t++) for (let b = 0; b < nMels; b++) {
      const d = mel[t * nMels + b] - mean[b];
      std[b] += d * d;
    }
    for (let b = 0; b < nMels; b++) std[b] = Math.sqrt(std[b] / (valid - 1)) + eps;

    for (let t = 0; t < T; t++) {
      for (let b = 0; b < nMels; b++) {
        const i = t * nMels + b;
        mel[i] = t < valid ? (mel[i] - mean[b]) / std[b] : 0;
      }
    }
    return { features: mel, T, valid };
  };
}
