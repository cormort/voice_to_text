// 主程式：UI 接線、引擎載入與辨識流程。
//
// 這支原本是 index.html 裡的一段內嵌 IIFE（2026-10 搬出來）。搬出來的理由：
//   * HTML／CSS 與程式碼分開，改版面不再產生整檔 diff
//   * 之後可以把引擎逐一抽成 src/engines/*，這裡只留接線
// 目前仍是單一檔案，模組（i18n / util / vad …）在下方 import。

  'use strict';

import { T } from './i18n.js';
import { stamp, concat, resample, makeAudioBuffer, isLatinDominated } from './util.js';
import { vadPush, vadFlush } from './vad.js';
import { TRANSCRIPT_KEY, serializeTranscript, restoreTranscript } from './persist.js';
import { createBatchPipeline } from './engines/batch.js';
import { createLiveEngine } from './engines/live.js';
import { decodeSherpa } from './engines/sherpa-decode.js';
import { createWhistleEngine } from './engines/whistle.js';
import { createUnderdogEngine } from './engines/underdog.js';
import { downloadInChunks, formatProgress } from './download.js';
import { collectStorageReport, renderStorageReport } from './storage-debug.js';
import { opfsStore, opfsAvailable } from './opfs.js';
  const CDN = {
    vosk: 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js',
    // 版本已鎖定，順便用 SRI 確認拿到的就是這一份（CDN 或套件被換掉時會直接載入失敗）
    voskIntegrity: 'sha384-nqyY8clHf93uBYFkgkACShMTuvE3U57yXSJaf0Ws+XgzcoUe6OB/1BiOfHqKOWeg',
    transformers: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0'
  };
  const VOSK_MODELS = {
    cn: new URL('models/vosk-model-small-cn-0.22.zip', document.baseURI).href,
    en: new URL('models/vosk-model-small-en-us-0.15.zip', document.baseURI).href
  };
  const WHISPER_MODELS = {
    tiny: 'onnx-community/whisper-tiny',
    base: 'onnx-community/whisper-base',
    small: 'onnx-community/whisper-small'
  };
  // 粵語走 Whisper 的 yue，其餘中文變體走 zh
  const LANG = {
    'zh-TW': 'zh', 'zh-CN': 'zh', 'zh-HK': 'yue',
    'en-US': 'en', 'en-GB': 'en', 'ja-JP': 'ja',
    'ko-KR': 'ko', 'es-ES': 'es', 'fr-FR': 'fr', 'de-DE': 'de'
  };
  // Whistle（Cactus Compute）：16.9 MB 的 .cact 語音模型 + 同源的 needle WASM 引擎。
  // 引擎比模型小兩個數量級（986 KB），所以引擎進 repo、模型留在 HF 讓使用者自己換。




  // needle.h：language 只認這七個字串或 NULL。其他語言（含中文、日文、韓文）
  // 一律送 NULL 讓引擎自己偵測，硬送 'zh' 不是「猜錯」而是「不存在的代碼」。

  const SAMPLE_RATE = 16000;
  // Whistle 的 VAD 分段上限（秒）：實測 10 秒是「首字延遲 vs 總 CPU」的甜蜜點，
  // 詳見 createVad() 的註解

  // Underdog Bark 3.0：模型 repo 的 resolve/main/ 目錄（onnx/ 在它下面），可用「資產位置」換鏡像

  // 只放模型權重與 tokenizer，與 sherpa / whistle 的快取分開，清外殼時不會被一起清掉

  // 這顆模型一次要吃完整段音訊（非串流）。上限取 15 秒：WASM 單執行緒的 RTF 約 1.2，
  // 切太長字幕會很久才出現，切太短又少了長脈絡的準確度。

  const SHERPA_DATA_FILE = 'sherpa-onnx-wasm-main-asr.data';
  const SHERPA_CACHE = 'sherpa-onnx-model-v1';
  // Vosk 的模型也自己抓（才有下載進度，見 fetchVoskPackage）。獨立快取名稱，
  // 不與 service worker 的外殼快取混在一起，清外殼時不會連 42 MB 的模型一起清掉。
  const VOSK_CACHE = 'vosk-model-v1';
  const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const WEB_RESTART_DELAY = IS_MOBILE ? 200 : 500;

  const $ = id => document.getElementById(id);
  const el = {
    pageTitle: $('pageTitle'), title: $('mainTitle'), engine: $('engineSelector'), lang: $('languageSelector'),
    languageField: $('languageField'), engineCards: $('engineCards'), quickstart: $('quickstartText'),
    langNote: $('langNote'),
    control: $('controlBtn'), copy: $('copyBtn'), export: $('exportBtn'), clear: $('clearBtn'),
    placeholder: $('placeholderText'), final: $('finalText'), interim: $('interimText'),
    container: $('transcriptContainer'), volume: $('volumeLevel'), notice: $('privacyNotice'),
    announcer: $('a11yAnnouncer'),
    statusEngine: $('statusEngineValue'), statusRuntime: $('statusRuntimeValue'),
    statusPrivacy: $('statusPrivacyValue'), statusState: $('statusStateValue'), toggle: $('uiLangToggle'),
    voskConfig: $('voskConfig'), voskSource: $('voskModelSource'), voskBuiltinRow: $('voskBuiltinRow'),
    voskFileRow: $('voskFileRow'), voskUrlRow: $('voskUrlRow'), voskLang: $('voskBuiltinLang'),
    voskFile: $('voskModelFile'), voskUrl: $('voskModelUrl'), loadVosk: $('loadVoskBtn'),
    voskProgress: $('voskProgress'), voskBar: $('voskProgressBar'), voskStatus: $('voskStatus'),
    sherpaConfig: $('sherpaConfig'), sherpaBase: $('sherpaBaseUrl'), loadSherpa: $('loadSherpaBtn'),
    clearSherpaCache: $('clearSherpaCacheBtn'),
    sherpaProgress: $('sherpaProgress'), sherpaBar: $('sherpaProgressBar'), sherpaStatus: $('sherpaStatus'),
    whisperConfig: $('whisperConfig'), whisperModel: $('whisperModelSelect'), vad: $('vadSensitivity'),
    loadWhisper: $('loadWhisperBtn'), whisperProgress: $('whisperProgress'), whisperBar: $('whisperProgressBar'),
    whisperStatus: $('whisperStatus'),
    whistleConfig: $('whistleConfig'), whistleUrl: $('whistleModelUrl'),
    loadWhistle: $('loadWhistleBtn'), clearWhistleCache: $('clearWhistleCacheBtn'),
    whistleProgress: $('whistleProgress'), whistleBar: $('whistleProgressBar'),
    whistleStatus: $('whistleStatus'),
    underdogConfig: $('underdogConfig'), underdogBase: $('underdogBaseUrl'), underdogVariant: $('underdogVariant'),
    loadUnderdog: $('loadUnderdogBtn'), clearUnderdogCache: $('clearUnderdogCacheBtn'),
    underdogProgress: $('underdogProgress'), underdogBar: $('underdogProgressBar'),
    underdogStatus: $('underdogStatus'),
    subtitleConfig: $('subtitleConfig'), mtToggle: $('mtToggle'), mtScript: $('mtScript'),
    mtModel: $('mtModel'), subScale: $('subScale'), pipBtn: $('pipBtn'),
    metricsToggle: $('metricsToggle'), mtStatus: $('mtStatus'), metricsHud: $('metricsHud'),
    subtitleBar: $('subtitleBar'), subtitleZh: $('subtitleZh'), subtitleEn: $('subtitleEn'),
    mossConfig: $('mossConfig'), mossSpace: $('mossSpaceSelect'), mossFile: $('mossFile'),
    mossFileZone: $('mossFileZone'), mossFileText: $('mossFileText'),
    mossRun: $('mossRunBtn'), mossSrt: $('mossSrtBtn'),
    mossProgress: $('mossProgress'), mossBar: $('mossProgressBar'),
    mossStatus: $('mossStatus')
  };

;
  const state = {
    ui: 'zh', engine: 'webspeech', running: false, stopping: false,
    start: null, segments: [], interim: '',
    recognition: null, restartTimer: null, webErrorTimer: null, manualStop: false,
    webGeneration: 0, webRecognitionActive: false
  };
  const t = () => T[state.ui];
  const vosk = {
    loaded: false, model: null, recognizer: null, session: null, loadPromise: null
  };
  const sherpa = {
    module: null, recognizer: null, stream: null, session: null,
    loaded: false, loadPromise: null, sessionId: 0, base: null
  };
  // 每個引擎只宣告「自己專屬」的狀態。**佇列、目前 session、VAD、dropWarned 由
  // src/engines/batch.js 的 pipeline 初始化並管理**（Phase 2 收斂），不要在下面加回來。
  const whisper = {
    module: null, pipe: null, model: null, device: null, loadPromise: null
  };

  // Underdog Bark 3.0：0.6B 的 parakeet-TDT，模型留在 Worker 裡（主執行緒只收進度與文字）

  let toastTimer;
  const openccConverters = new Map();
  let pcmWorkletModuleUrl = null;
  const scriptLoadPromises = new Map();

  // ==================== Audio capture and resampling ====================
  class AudioCapture {
    constructor(onChunk, onLevel) {
      this.onChunk = onChunk;
      this.onLevel = onLevel;
      this.stream = null;
      this.context = null;
      this.source = null;
      this.node = null;
      this.silent = null;
    }
    async start() {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
      this.context = new (window.AudioContext || window.webkitAudioContext)();
      await this.context.resume();

      const code = `class PCMProcessor extends AudioWorkletProcessor{
        constructor(){
          super();
          this.bufSize=2048;
          this.buf=new Float32Array(this.bufSize);
          this.idx=0;
        }
        process(inputs){
          const ch=inputs[0]&&inputs[0][0];
          if(!ch) return true;
          for(let i=0;i<ch.length;i++){
            this.buf[this.idx++]=ch[i];
            if(this.idx>=this.bufSize){
              this.port.postMessage(this.buf,[this.buf.buffer]);
              this.buf=new Float32Array(this.bufSize);
              this.idx=0;
            }
          }
          return true;
        }
      }
      registerProcessor('pcm-processor',PCMProcessor);`;

      if (!pcmWorkletModuleUrl) {
        pcmWorkletModuleUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      }

      await this.context.audioWorklet.addModule(pcmWorkletModuleUrl);
      this.source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, 'pcm-processor');
      this.silent = this.context.createGain();
      this.silent.gain.value = 0;

      this.source.connect(this.node);
      this.node.connect(this.silent);
      this.silent.connect(this.context.destination);

      this.node.port.onmessage = e => {
        // 收尾競態：stop() 會把 this.context 設回 null，但 worklet 可能還有一則訊息在路上
        // （實測在「停止後立刻關閉頁面」時會炸 Cannot read properties of null (reading
        // 'sampleRate')）。這一則直接丟掉即可，音訊已經沒有意義了。
        if (!this.context) return;
        const input = e.data;
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);
        this.onLevel?.(rms);
        const output = resample(input, this.context.sampleRate, SAMPLE_RATE);
        this.onChunk?.(output, rms);
      };
    }
    async stop() {
      const contextToClose = this.context;
      const streamToStop = this.stream;

      try {
        try { this.node?.disconnect(); } catch (e) { console.warn(e); }
        try { this.source?.disconnect(); } catch (e) { console.warn(e); }
        try { this.silent?.disconnect(); } catch (e) { console.warn(e); }
        try { streamToStop?.getTracks().forEach(track => track.stop()); } catch (e) { console.warn(e); }

        if (contextToClose && contextToClose.state !== 'closed') {
          try {
            await contextToClose.close();
          } catch (error) {
            console.warn('AudioContext close failed:', error);
          }
        }
      } finally {
        this.stream = null;
        this.context = null;
        this.source = null;
        this.node = null;
        this.silent = null;
        this.onLevel?.(0);
      }
    }
  }

  // 降取樣（例如 48k → 16k）先做整數倍的移動平均當低通濾波，否則 8 kHz 以上的
  // 頻率會折疊回語音頻帶；非整數倍（44.1k → 16k）仍走線性內插。

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  // ── OpenCC（簡→繁）────────────────────────────────────────────────────────
  // cn2t = 簡→繁 preset（含 hk/tw/twp 目標）。這個 App 只用 from:'cn'，用 preset 在語意上
  // 比 full.js 精確；實測檔案只小 59 KB（1035 vs 1094 KB，gzip 後差距更小），
  // 所以這是「意圖清楚」而不是顯著的體積優化。
  //
  // **為什麼不放在啟動路徑上**：這支檔案實測 1.04 MB（br 505 KB），是整個 App 本體
  // gzip（44.6 KB）的 11 倍，而且它是 parser-blocking 的 classic script —— 放在主 inline
  // script 之前，等於整頁的 UI 接線（卡片文字、按鈕事件）都要等它下載完。
  // 實測（Chromium、Slow 3G 400 kbps／400 ms RTT）：有它在 critical path 時
  // 「UI 可用」是 14,111 ms，擋掉之後是 59 ms。只有「會產出中文」的組合需要它，
  // 所以改成按需下載：開始辨識、選中文語言、或切到會輸出中文的引擎時才抓。
  const OPENCC_URL = 'https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/cn2t.js';
  // 版本鎖定 + SRI：CDN 或套件被換掉時直接載入失敗；失敗時 traditional() 原樣回傳，不會壞
  const OPENCC_SRI = 'sha384-9JmxkgxoKE5gP14V/eBemUAwCKh8QSb5IFEJje/JNxxh8cn9hKsIs/q5Ho+mfVau';
  let openccPromise = null;

  function ensureOpencc() {
    if (window.OpenCC) return Promise.resolve(true);
    openccPromise ||= new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = OPENCC_URL;
      script.integrity = OPENCC_SRI;
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve(true);
      // 離線／被擋／SRI 不符：回 false，之後 traditional() 一律原樣輸出（與舊行為相同）
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
    return openccPromise;
  }

  // 回傳要用的繁體變體（'twp' / 'hk'），「不需要轉換」時回 null。
  // Vosk 內建模型與 sherpa / MOSS 的輸出語言由模型決定，語言選單對它們無效：
  // 內建 cn 必定是簡中要轉，內建 en 必定是英文（不能因為選單停在 zh-TW 就送進 OpenCC）
  function chineseVariant() {
    const builtinVoskLang = state.engine === 'vosk' && el.voskSource.value === 'builtin'
      ? el.voskLang.value : null;
    const forcedChinese =
      state.engine === 'moss' ||
      state.engine === 'sherpa' ||
      builtinVoskLang === 'cn';
    const chineseSource = builtinVoskLang ? builtinVoskLang === 'cn' : el.lang.value.startsWith('zh');
    if (!forcedChinese && !chineseSource) return null;
    return (!forcedChinese && el.lang.value === 'zh-HK') ? 'hk' : 'twp';
  }

  // 會產出中文就先抓，不阻塞任何東西（失敗也只是這次不轉）
  function prefetchOpencc() {
    if (chineseVariant()) void ensureOpencc();
  }

  function getOpenccConverter(variant) {
    if (!window.OpenCC) return null;
    if (!openccConverters.has(variant)) {
      openccConverters.set(variant, window.OpenCC.Converter({ from: 'cn', to: variant }));
    }
    return openccConverters.get(variant);
  }

  function traditional(value) {
    if (!value) return value;
    const variant = chineseVariant();
    if (!variant) return value;
    // 還沒載到（剛開始辨識的前幾秒）就先原樣輸出，並順手補上載入 —— 之後的段落就會轉
    if (!window.OpenCC) { void ensureOpencc(); return value; }

    try {
      const converter = getOpenccConverter(variant);
      return converter ? converter(value) : value;
    } catch (error) {
      console.warn('OpenCC conversion failed:', error);
      return value;
    }
  }

  let announceTimer = null;
  let pendingAnnouncement = '';

  // 逐字稿區本身不是 live region（interim 每秒更新多次會灌爆螢幕閱讀器），
  // 改成段落確定後才送進隱藏的 announcer，並把短時間內的多段合併成一次播報。
  function announce(text) {
    if (!text) return;
    pendingAnnouncement = pendingAnnouncement ? `${pendingAnnouncement} ${text}` : text;
    if (announceTimer) return;
    announceTimer = setTimeout(() => {
      announceTimer = null;
      el.announcer.textContent = pendingAnnouncement.slice(-400);
      pendingAnnouncement = '';
    }, 1500);
  }

  function commit(s) {
    s = traditional((s || '').trim());
    if (!s) return;
    const segment = { time: new Date(), text: s };
    state.segments.push(segment);
    state.interim = '';
    render();
    announce(s);
    queueTranslation(segment);
    persistTranscript();
  }

  // 一次寫入多段（例如 MOSS 的整份逐字稿）：只 render 一次，避免每段都重排與捲動。
  // OpenCC 是按需載入的，MOSS 這種「一次寫一整份」的路徑值得等它一下（而不是整份留簡體）
  async function commitBatch(lines) {
    if (chineseVariant()) await ensureOpencc();
    const written = [];
    for (const line of lines) {
      const text = traditional((line || '').trim());
      if (!text) continue;
      state.segments.push({ time: new Date(), text });
      written.push(text);
    }
    if (!written.length) return;
    state.interim = '';
    render();
    persistTranscript();
    // 整批只播報最後一段，否則螢幕閱讀器會把整場會議唸一遍
    announce(written[written.length - 1]);
  }

  function getEffectiveSegments() {
    return state.segments.filter(segment => {
      const content = String(segment.text || '').trim();
      return content && !content.startsWith('--- Recording Start');
    });
  }

  function getEffectiveTranscriptText(lineSeparator = '\n') {
    return getEffectiveSegments()
      .map(segment => `${stamp(segment.time)} ${String(segment.text).trim()}`)
      .join(lineSeparator);
  }

  let renderedSegments = 0;
  let renderedText = '';
  let effectiveCount = 0;
  let effectiveCountRef = null;
  let effectiveCountLen = -1;

  // render() 每個音訊塊都會被呼叫（約每秒 8 次），不該每次都對整份逐字稿做 filter + trim。
  // segments 只會被 append 或整個換掉（begin / clear 會換成新陣列），所以用「陣列本身 +
  // 長度」當快取鍵：只看長度的話，新的一場錄音回到 1 段時會沿用上一場的快取結果。
  function effectiveSegmentCount() {
    if (effectiveCountRef !== state.segments || effectiveCountLen !== state.segments.length) {
      effectiveCount = getEffectiveSegments().length;
      effectiveCountRef = state.segments;
      effectiveCountLen = state.segments.length;
    }
    return effectiveCount;
  }

  // 一段話在逐字稿裡長什麼樣。開了雙語字幕時，譯文以縮排的第二行附在原文下面
  // （逐字稿仍然是「記錄」，原文一定在；譯文只是附加資訊）。
  function segmentLine(segment) {
    const base = `${stamp(segment.time)} ${segment.text}`;
    return segment.zh && mt.inTranscript ? `${base}\n   ↳ ${segment.zh}` : base;
  }

  // full=true 用在「譯文後到」與清空／換場：整份重建（段落數多時會被呼叫端擋掉）
  function renderTranscript(full = false) {
    if (full || state.segments.length < renderedSegments) {
      renderedText = state.segments.map(segmentLine).join('\n');
      renderedSegments = state.segments.length;
      el.final.textContent = renderedText;
      return;
    }
    if (state.segments.length > renderedSegments) {
      const delta = state.segments.slice(renderedSegments).map(segmentLine).join('\n');
      renderedText += (renderedText ? '\n' : '') + delta;
      renderedSegments = state.segments.length;
      el.final.textContent = renderedText;
    }
  }

  function render() {
    el.placeholder.hidden = !!(state.segments.length || state.interim);
    renderTranscript();
    renderSubtitles();

    const interimText = state.interim ? `\n${state.interim}` : '';
    if (el.interim.textContent !== interimText) el.interim.textContent = interimText;

    const hasContent = effectiveSegmentCount() > 0;
    el.copy.disabled = !hasContent;
    el.export.disabled = !hasContent;

    // 只在接近底部時才自動捲動，避免打斷閱讀舊內容
    const nearBottom = el.container.scrollHeight - el.container.scrollTop - el.container.clientHeight < 48;
    if (nearBottom) {
      requestAnimationFrame(() => {
        el.container.scrollTop = el.container.scrollHeight;
      });
    }
  }

  function setLevel(rms) {
    el.volume.style.transform = `scaleX(${Math.min(1, rms * 12)})`;
  }

  function begin() {
    prefetchOpencc();       // 會產出中文的組合先把 OpenCC 抓下來（不阻塞收錄音）
    // 不清掉前面的段落：中場停下來再按開始，上半場的逐字稿必須還在
    // （以前這裡會 state.segments = []，而且沒有任何提示）。只有「清空」按鈕會清。
    // 每次開始仍寫一行標記，看得出是第幾段錄音；複製／輸出時標記會被濾掉。
    if (!state.start) state.start = new Date();
    commit('--- Recording Start / 錄音開始 ---');
  }

  // ==================== 逐字稿保存（重新整理／當掉後還原）====================
  // 每次有新段落就排一次寫入（1 秒節流），切到背景或離開頁面時立刻寫，
  // 所以最壞只會掉最後一秒。純序列化邏輯在 src/persist.js。
  let persistTimer = null;
  let persistWarned = false;

  function persistTranscript(now = false) {
    if (!now) {
      persistTimer ||= setTimeout(() => persistTranscript(true), 1000);
      return;
    }
    clearTimeout(persistTimer);
    persistTimer = null;
    try {
      if (!getEffectiveSegments().length) localStorage.removeItem(TRANSCRIPT_KEY);
      else localStorage.setItem(TRANSCRIPT_KEY, serializeTranscript(state.start, state.segments));
    } catch (error) {
      // 配額滿或隱私模式：辨識照常進行，只是不保證能還原 —— 講一次就好
      console.warn('Saving the transcript failed:', error);
      if (!persistWarned) {
        persistWarned = true;
        showToast(t().persistFailed);
      }
    }
  }

  function restoreSavedTranscript() {
    let saved = null;
    try {
      saved = restoreTranscript(localStorage.getItem(TRANSCRIPT_KEY));
    } catch (error) {
      console.warn('Reading the saved transcript failed:', error);
    }
    if (!saved) return 0;
    state.start = saved.start;
    state.segments = saved.segments;
    return getEffectiveSegments().length;
  }

  // ==================== 錄音中保持螢幕常亮（Screen Wake Lock）====================
  // 手機螢幕一關，麥克風或 Web Speech 就可能被系統停掉，畫面卻還寫著「辨識中」。
  // 錄音期間持有 wake lock；切到背景時瀏覽器會自動釋放，回到前景再要一次。
  let wakeLock = null;
  let wakeLockPending = false;

  async function syncWakeLock() {
    if (!('wakeLock' in navigator)) return;
    const want = state.running && document.visibilityState === 'visible';
    if (!want) {
      if (wakeLock && !state.running) {
        const lock = wakeLock;
        wakeLock = null;
        lock.release().catch(() => {});
      }
      return;
    }
    if (wakeLock || wakeLockPending) return;
    wakeLockPending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      wakeLock = lock;
    } catch (error) {
      // 省電模式、權限政策或非安全環境：拿不到就算了，不影響辨識
      console.warn('Screen Wake Lock unavailable:', error);
    } finally {
      wakeLockPending = false;
    }
    if (wakeLock && !state.running) void syncWakeLock();   // 等待期間就已經停止了
  }

  function finish() {
    state.running = false;
    state.stopping = false;
    state.interim = '';
    el.engine.disabled = false;
    el.lang.disabled = false;
    updateButtons();
    render();
    setLevel(0);
  }

  function updateButtons() {
    const batch = state.engine === 'moss';
    el.control.textContent = batch ? t().mossBatchMode
      : (state.stopping ? t().stopping : (state.running ? t().stop : t().start));
    el.control.classList.toggle('listening', state.running && !batch);
    el.control.disabled = batch || state.stopping;
    el.statusState.textContent = state.stopping ? t().processing : (state.running ? t().listening : t().idle);
    document.title = (state.running ? '● ' : '') + t().pageTitle;
    void syncWakeLock();
    syncEngineCards();
    syncModelButtons();
  }

  // 模型按鈕要能一眼看出「還沒按過」與「已載入成功」，狀態直接對應各引擎目前的載入結果；
  // 換模型／換來源、載入失敗或裝置掉線時會自動退回未載入的外觀
  function syncModelButtons() {
    for (const [button, done] of [
      [el.loadVosk, vosk.loaded],
      [el.loadSherpa, sherpaBaseMatches()],
      [el.loadWhisper, !!whisper.pipe && whisper.model === WHISPER_MODELS[el.whisperModel.value]],
      [el.loadWhistle, whistleEngine.isReady()],
      [el.loadUnderdog, underdogEngine.isReady()]
    ]) {
      button.classList.toggle('done', done);
      button.textContent = done ? `✓ ${t().loadModel}` : t().loadModel;
      if (done) button.title = t().loaded;
      else button.removeAttribute('title');
    }
  }

  // 跟 loadSherpa 判斷「資產位置是否與已載入的一致」用同一套規則
  function sherpaBaseMatches() {
    if (!sherpa.loaded || !sherpa.base) return false;
    try {
      const dir = new URL(el.sherpaBase.value.trim().replace(/\/?$/, '/'), document.baseURI).href;
      return dir === sherpa.base;
    } catch (error) {
      return false;
    }
  }

  function syncEngineCards() {
    const lock = el.engine.disabled || state.running || state.stopping || moss.running;
    for (const card of el.engineCards.querySelectorAll('.engine-card')) {
      const active = card.dataset.engine === state.engine;
      card.classList.toggle('active', active);
      card.setAttribute('aria-pressed', active ? 'true' : 'false');
      card.disabled = lock;
    }
  }

  function updateEngine() {
    state.engine = el.engine.value;
    el.voskConfig.classList.toggle('visible', state.engine === 'vosk');
    el.sherpaConfig.classList.toggle('visible', state.engine === 'sherpa');
    el.whisperConfig.classList.toggle('visible', state.engine === 'whisper');
    el.whistleConfig.classList.toggle('visible', state.engine === 'whistle');
    el.underdogConfig.classList.toggle('visible', state.engine === 'underdog');
    el.mossConfig.classList.toggle('visible', state.engine === 'moss');
    // Vosk 與 sherpa 的語言由模型決定，隱藏語言選單
    el.languageField.style.display = (state.engine === 'vosk' || state.engine === 'sherpa' || state.engine === 'moss') ? 'none' : '';

    const local = state.engine !== 'webspeech' && state.engine !== 'moss';
    const icon = local ? '🔒 ' : '☁️ ';
    el.notice.textContent = icon + (state.engine === 'moss' ? t().mossNotice : (local ? t().localNotice : t().webNotice));
    el.notice.className = 'notice ' + (local ? 'local' : 'partial');
    el.statusEngine.textContent = { webspeech: 'Web Speech API', vosk: 'Vosk', sherpa: 'sherpa-onnx', whisper: 'Whisper', whistle: 'Whistle (Cactus)', underdog: 'Underdog Bark 3.0', moss: 'MOSS-Transcribe-Diarize' }[state.engine];
    el.statusRuntime.textContent = {
      webspeech: t().browserService, vosk: 'WASM / CPU', sherpa: 'WASM / CPU',
      whisper: whisper.device || 'WebGPU / WASM',
      whistle: 'WASM / CPU',
      underdog: 'WASM / CPU',
      moss: el.mossSpace.value === 'litert' ? 'HF Space / LiteRT' : 'HF Space / CPU'
    }[state.engine];
    el.statusPrivacy.textContent = icon + (local ? t().localProcessing : t().cloudProcessing);
    el.quickstart.innerHTML = t().quickstart[state.engine] || '';

    // Whistle 只認七種歐洲語言，其他選項一律自動偵測 —— 選單不動，但要講清楚，
    // 否則使用者會以為自己選錯了（行為是對的，只是沒有說明）
    el.langNote.hidden = state.engine !== 'whistle' && state.engine !== 'underdog';
    if (!el.langNote.hidden) el.langNote.textContent = state.engine === 'underdog' ? t().langNoteUnderdog : t().langNoteWhistle;

    prefetchOpencc();       // 這個引擎／語言組合會產出中文就先抓 OpenCC
    updateButtons();
    save();
  }

  async function loadScript(src, globalName, integrity) {
    if (globalName && window[globalName]) return window[globalName];
    if (scriptLoadPromises.has(src)) return scriptLoadPromises.get(src);

    const loadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.dataset.dynamicSrc = src;
      if (integrity) {
        script.integrity = integrity;
        script.crossOrigin = 'anonymous';
      }
      script.onload = () => {
        if (globalName && !window[globalName]) {
          script.remove();
          reject(new Error(`Script loaded, but window.${globalName} is unavailable.`));
          return;
        }
        resolve(globalName ? window[globalName] : true);
      };
      script.onerror = () => {
        script.remove();
        reject(new Error(`Script load failed: ${src}`));
      };
      document.head.appendChild(script);
    });

    scriptLoadPromises.set(src, loadPromise);
    try {
      return await loadPromise;
    } catch (error) {
      scriptLoadPromises.delete(src);
      throw error;
    }
  }

  async function disposeWhisperPipeline(pipeline) {
    if (!pipeline || typeof pipeline.dispose !== 'function') return;
    try {
      await pipeline.dispose();
    } catch (error) {
      console.warn('Whisper pipeline disposal failed:', error);
    }
  }

  // fresh=true 會用不同的 query string 取得另一份模組實例（見 loadWhisper 的退路說明）
  async function loadTransformers(fresh = false) {
    const module = await import(fresh ? `${CDN.transformers}?fallback=1` : CDN.transformers);
    module.env.allowLocalModels = false;
    module.env.useBrowserCache = true;
    return module;
  }

  // 先確認真的拿得到 adapter 才值得試 webgpu：失敗的那一次會污染模組狀態（見上）
  async function hasWebGpuAdapter() {
    if (!navigator.gpu) return false;
    try {
      return !!(await navigator.gpu.requestAdapter());
    } catch (error) {
      console.warn('WebGPU adapter probe failed:', error);
      return false;
    }
  }

  // ==================== sherpa-onnx Worker（把串流解碼移出主執行緒）====================
  // 為什麼：原本同步解碼在主執行緒，實測 15 秒串流有 44 個長任務、最長 111 ms（占 18.9%），
  // 會有可見掉幀。下載與快取仍留在主執行緒（進度條與 Cache Storage 行為不變），
  // 位元組以 transferable 交給 Worker（零拷貝）。
  let sherpaWorker = null;
  let sherpaWorkerPending = null;      // load/flush 這種「一次一答」的等待
  const sherpaWorkerHandlers = new Set();

  function ensureSherpaWorker() {
    if (sherpaWorker) return sherpaWorker;
    try {
      sherpaWorker = new Worker('sherpa-worker.js');   // classic worker：要用 importScripts 載入膠水層
    } catch (error) {
      console.warn('sherpa worker unavailable; staying on the main thread:', error);
      sherpaWorker = null;
      return null;
    }
    sherpaWorker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'status') { el.sherpaStatus.textContent = msg.status; return; }
      if (msg.type === 'error') {
        console.warn('[sherpa-worker]', msg.phase, msg.message);
        // 餵音階段的錯誤過去只印 console.warn，UI 上一點線索都沒有 ——
        // 使用者看到的就只是「音量 bar 有動、字幕永遠不出來」（實測踩過：
        // worker 的 getResult 少帶 stream，每個音塊都丟 TypeError，全程靜默）。
        // 連續幾次就出聲並收掉 session，不要讓 UI 繼續假裝在聽。
        if (msg.phase === 'feed' || msg.phase === 'flush') {
          sherpa.feedErrors = (sherpa.feedErrors || 0) + 1;
          if (sherpa.feedErrors === 5) {
            showToast(t().sherpaFeedFailed);
            void sherpaEngine.stop();
          }
        }
        if (sherpaWorkerPending) { const p = sherpaWorkerPending; sherpaWorkerPending = null; p.reject(new Error(msg.message)); }
        for (const handler of sherpaWorkerHandlers) handler(msg);
        return;
      }
      if (sherpaWorkerPending && (msg.type === 'ready' || msg.type === 'final' || msg.type === 'started')) {
        const p = sherpaWorkerPending;
        sherpaWorkerPending = null;
        p.resolve(msg);
        if (msg.type !== 'final') return;      // ready/started 不必再轉給結果處理器
      }
      for (const handler of sherpaWorkerHandlers) handler(msg);
    };
    sherpaWorker.onerror = (event) => {
      console.warn('sherpa worker crashed:', event.message || event);
      if (sherpaWorkerPending) { const p = sherpaWorkerPending; sherpaWorkerPending = null; p.reject(new Error(event.message || 'worker crash')); }
      try { sherpaWorker.terminate(); } catch (error) { /* 已經死了 */ }
      sherpaWorker = null;
      // Worker 死了 = 那份 199 MB 的模型也沒了。若不把 loaded 清掉，UI 還寫著「已載入」，
      // 下一次 start 會對著一個全新的、沒有 recognizer 的 Worker 發 start，錯誤訊息完全看不懂。
      if (sherpa.workerMode) {
        sherpa.workerMode = false;
        sherpa.loaded = false;
        sherpa.stream = null;
        if (sherpa.workerHandler) { sherpaWorkerHandlers.delete(sherpa.workerHandler); sherpa.workerHandler = null; }
        el.sherpaStatus.textContent = t().loadFailed + (event.message || 'worker crash');
        el.sherpaStatus.className = 'model-status error';
        syncModelButtons();
      }
    };
    return sherpaWorker;
  }

  function sherpaWorkerAsk(payload, transfer) {
    const worker = ensureSherpaWorker();
    if (!worker) return Promise.reject(new Error('worker unavailable'));
    if (sherpaWorkerPending) return Promise.reject(new Error('worker busy'));
    return new Promise((resolve, reject) => {
      sherpaWorkerPending = { resolve, reject };
      try {
        worker.postMessage(payload, transfer || []);
      } catch (error) {
        sherpaWorkerPending = null;
        reject(error);
      }
    });
  }

  function sherpaWorkerSend(payload, transfer) {
    const worker = ensureSherpaWorker();
    if (!worker) return false;
    try {
      worker.postMessage(payload, transfer || []);
      return true;
    } catch (error) {
      console.warn('sherpa worker postMessage failed:', error);
      return false;
    }
  }

  // ==================== Whisper Worker（把推論移出主執行緒）====================
  // 為什麼：pipeline 在主執行緒跑時，單一 chunk（chunk_length_s: 15）在 WASM 後端
  // 實測阻塞主執行緒 12,295 ms、占串流時間 49.6% —— 整頁凍結、按鈕沒反應。
  // Worker 版本讓主執行緒只做訊息搬運；音訊用 transferable 傳（零拷貝）。
  // 若 Worker 建不起來（舊瀏覽器／CSP／檔案缺失），自動退回原本的主執行緒路徑。
  const whisperWorkerPipeline = {
    dispose: () => whisperWorkerRequest({ type: 'dispose' }).catch(() => {})
  };
  let whisperWorker = null;
  let whisperWorkerSeq = 0;
  const whisperWorkerPending = new Map();

  function ensureWhisperWorker() {
    if (whisperWorker) return whisperWorker;
    try {
      whisperWorker = new Worker('whisper-worker.js', { type: 'module' });
    } catch (error) {
      console.warn('Whisper worker unavailable; falling back to main thread:', error);
      whisperWorker = null;
      return null;
    }
    whisperWorker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'progress') { updateWhisperProgress(msg); return; }
      const pending = whisperWorkerPending.get(msg.id);
      if (!pending) return;
      whisperWorkerPending.delete(msg.id);
      if (msg.type === 'error') {
        const error = new Error(msg.message || 'whisper worker error');
        error.phase = msg.phase;
        error.deviceLost = !!msg.deviceLost;
        pending.reject(error);
      } else {
        pending.resolve(msg);
      }
    };
    whisperWorker.onerror = (event) => {
      // Worker 自己掛掉（例如 CDN import 失敗）：讓等待中的請求失敗，
      // 下一輪會自動退回主執行緒路徑
      console.warn('Whisper worker crashed:', event.message || event);
      for (const [, pending] of whisperWorkerPending) pending.reject(new Error(event.message || 'worker crash'));
      whisperWorkerPending.clear();
      try { whisperWorker.terminate(); } catch (error) { /* 已經死了 */ }
      whisperWorker = null;
    };
    return whisperWorker;
  }

  function whisperWorkerRequest(payload, transfer) {
    const worker = ensureWhisperWorker();
    if (!worker) return Promise.reject(new Error('worker unavailable'));
    const id = ++whisperWorkerSeq;
    return new Promise((resolve, reject) => {
      whisperWorkerPending.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...payload, id, libUrl: CDN.transformers }, transfer || []);
      } catch (error) {
        whisperWorkerPending.delete(id);
        reject(error);
      }
    });
  }

  // 真實下載進度：把 indeterminate 動畫換成百分比（模型檔大時差很多）
  function updateWhisperProgress(msg) {
    if (msg.pct == null) return;
    const file = String(msg.file || '').split('/').pop();
    el.whisperBar.classList.remove('indeterminate');
    el.whisperBar.style.width = `${msg.pct}%`;
    el.whisperStatus.textContent = `${t().whisperLoading} ${msg.pct}%${file ? '（' + file + '）' : ''}`;
  }

  async function whisperWorkerTranscribe(audio, language) {
    const copy = audio.slice();   // 原陣列留給主執行緒，transfer 的是這份副本
    return whisperWorkerRequest(
      { type: 'transcribe', audio: copy, language: LANG[language], chunkLength: 15, stride: 2 },
      [copy.buffer]);
  }

  function removeVoskRecognizer() {
    const recognizerToRemove = vosk.recognizer;
    vosk.recognizer = null;
    if (!recognizerToRemove) return;
    try {
      recognizerToRemove.remove?.();
    } catch (error) {
      console.warn('Vosk recognizer cleanup failed:', error);
    }
  }

  async function terminateVoskModel(model) {
    if (!model) return;
    try {
      const result = model.terminate?.();
      if (result && typeof result.then === 'function') await result;
    } catch (error) {
      console.warn('Vosk model termination failed:', error);
    }
  }

  // ==================== Vosk offline engine ====================
  // vosk-browser 的 createModel 會在自己的 Worker 內抓模型，外部拿不到任何進度 ——
  // 42 MB 的內建模型只看到一個轉圈動畫。這裡改成自己抓（有 MB 與百分比、可進 Cache
  // Storage），再用 blob: URL 交給 createModel —— 使用者自選檔案那條路徑本來就是傳
  // blob: URL，所以這是它既有支援的形式。
  async function fetchVoskPackage(url) {
    let cache = null;
    try {
      cache = await caches.open(VOSK_CACHE);
    } catch (error) {
      console.warn('Cache Storage unavailable:', error);
    }

    if (cache) {
      const hit = await cache.match(url);
      if (hit) {
        el.voskBar.classList.remove('indeterminate');
        el.voskBar.style.width = '100%';
        el.voskStatus.textContent = `${t().voskLoading}（本地快取）`;
        return hit.arrayBuffer();
      }
    }

    const bytes = await downloadInChunks(url, (loaded, total) => {
      const pct = Math.round((loaded / total) * 100);
      el.voskBar.classList.remove('indeterminate');
      el.voskBar.style.width = `${pct}%`;
      el.voskStatus.textContent =
        `${t().voskLoading} ${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB（${pct}%）`;
    });

    if (cache) {
      try {
        await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/zip' } }));
      } catch (error) {
        console.warn('Caching the Vosk model failed:', error);
      }
    }

    return bytes.buffer;
  }

  async function loadVosk() {
    if (vosk.loadPromise) return vosk.loadPromise;

    vosk.loadPromise = (async () => {
      el.loadVosk.disabled = true;
      el.voskProgress.classList.add('visible');
      el.voskBar.classList.add('indeterminate');
      el.voskStatus.textContent = t().voskLoading;
      el.voskStatus.className = 'model-status';

      let modelUrl = null;
      let revokeModelUrl = false;
      let newlyCreatedModel = null;

      try {
        await loadScript(CDN.vosk, 'Vosk', CDN.voskIntegrity);

        const source = el.voskSource.value;
        if (source === 'builtin' || source === 'url') {
          let target;
          if (source === 'builtin') {
            if (window.location.protocol === 'file:') throw new Error(t().voskFileProtocol);
            target = VOSK_MODELS[el.voskLang.value];
          } else {
            target = el.voskUrl.value.trim();
            if (!target) throw new Error(t().voskNoUrl);
          }
          // 自己抓才有進度；抓完用 blob: URL 交給 vosk-browser
          const packageData = await fetchVoskPackage(target);
          modelUrl = URL.createObjectURL(new Blob([packageData]));
          revokeModelUrl = true;
        } else {
          const file = el.voskFile.files[0];
          if (!file) throw new Error(t().voskNoFile);
          modelUrl = URL.createObjectURL(file);
          revokeModelUrl = true;
        }

        removeVoskRecognizer();

        const previousModel = vosk.model;
        vosk.model = null;
        vosk.loaded = false;
        await terminateVoskModel(previousModel);

        newlyCreatedModel = await Vosk.createModel(modelUrl);

        vosk.model = newlyCreatedModel;
        newlyCreatedModel = null;
        vosk.loaded = true;
        el.voskStatus.textContent = t().loaded;
        el.voskStatus.className = 'model-status success';
      } catch (error) {
        console.error('Vosk model load failed:', error);
        await terminateVoskModel(newlyCreatedModel);

        vosk.loaded = false;
        vosk.model = null;
        el.voskStatus.textContent = t().loadFailed + (error.message || error);
        el.voskStatus.className = 'model-status error';
      } finally {
        if (revokeModelUrl && modelUrl) URL.revokeObjectURL(modelUrl);
        el.voskBar.classList.remove('indeterminate');
        el.voskBar.style.width = vosk.loaded ? '100%' : '0';
        el.loadVosk.disabled = false;
        syncModelButtons();
      }
    })();

    try {
      await vosk.loadPromise;
    } finally {
      vosk.loadPromise = null;
    }
  }





  // ==================== sherpa-onnx streaming engine ====================
  function setSherpaProgress(loaded, total) {
    if (total) el.sherpaBar.classList.remove('indeterminate');
    el.sherpaBar.style.width = total ? `${(loaded / total * 100).toFixed(1)}%` : '';
    el.sherpaStatus.textContent = `${t().sherpaDownloading} ${formatProgress(loaded, total)}`;
  }








  // 回傳 .data 的 ArrayBuffer：優先讀 Cache Storage，沒有才下載並存起來。
  // ponytail: 快取失敗（配額不足、非安全環境）就退回純下載，功能不受影響。
  async function fetchSherpaPackage(url) {
    let cache = null;
    try {
      cache = await caches.open(SHERPA_CACHE);
    } catch (error) {
      console.warn('Cache Storage unavailable:', error);
    }

    if (cache) {
      const hit = await cache.match(url);
      if (hit) {
        el.sherpaStatus.textContent = t().sherpaFromCache;
        el.sherpaBar.classList.remove('indeterminate');
        el.sherpaBar.style.width = '100%';
        return hit.arrayBuffer();
      }
    }

    const bytes = await downloadInChunks(url);

    if (cache) {
      try {
        await cache.put(url, new Response(bytes, {
          headers: { 'Content-Type': 'application/octet-stream' }
        }));
      } catch (error) {
        console.warn('Caching the sherpa package failed:', error);
        showToast(t().sherpaCacheFailed);
      }
    }

    return bytes.buffer;
  }

  async function clearSherpaCache() {
    try {
      const deleted = await caches.delete(SHERPA_CACHE);
      showToast(deleted ? t().sherpaCacheCleared : t().sherpaCacheEmpty);
    } catch (error) {
      console.error('Clearing the sherpa cache failed:', error);
      showToast(t().sherpaCacheFailed);
    }
  }

  // ponytail: emscripten 的 Module 是單例，WASM 只能載入一次；換資產位置需重新整理頁面。
  async function loadSherpa() {
    if (sherpa.loadPromise) return sherpa.loadPromise;

    const base = el.sherpaBase.value.trim();
    if (!base) {
      el.sherpaStatus.textContent = t().sherpaNoBase;
      el.sherpaStatus.className = 'model-status error';
      return;
    }
    if (sherpa.loaded) {
      if (sherpa.base !== base.replace(/\/?$/, '/')) {
        el.sherpaStatus.textContent = t().sherpaReloadNeeded;
        el.sherpaStatus.className = 'model-status error';
        return;
      }
      el.sherpaStatus.textContent = t().loaded;
      el.sherpaStatus.className = 'model-status success';
      return;
    }

    const dir = new URL(base.replace(/\/?$/, '/'), document.baseURI).href;

    sherpa.loadPromise = (async () => {
      el.loadSherpa.disabled = true;
      el.sherpaProgress.classList.add('visible');
      el.sherpaBar.classList.add('indeterminate');
      el.sherpaStatus.textContent = t().sherpaLoading;
      el.sherpaStatus.className = 'model-status';

      try {
        // 首選：Worker。190 MB 的下載與快取仍走 fetchSherpaPackage（進度條不變），
        // 下載完的位元組用 transferable 交進去。
        if (ensureSherpaWorker()) {
          let glueUrls = null;
          try {
            // 兩支膠水層由頁面抓成文字再建立 blob: URL —— 跨網域的 importScripts 會失敗
            // （實測 HF 的 .js 用 importScripts 載不起來），blob: 則在 CSP 允許清單內。
            const glue = await Promise.all([
              fetch(dir + 'sherpa-onnx-asr.js').then(r => { if (!r.ok) throw new Error('glue1 HTTP ' + r.status); return r.text(); }),
              fetch(dir + 'sherpa-onnx-wasm-main-asr.js').then(r => { if (!r.ok) throw new Error('glue2 HTTP ' + r.status); return r.text(); })
            ]);
            glueUrls = glue.map(src => URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));

            const packageData = await fetchSherpaPackage(dir + SHERPA_DATA_FILE);
            el.sherpaStatus.textContent = t().sherpaLoading;
            await sherpaWorkerAsk({
              type: 'load', dir, glueUrls, package: packageData, sampleRate: SAMPLE_RATE
            }, [packageData]);
            sherpa.workerMode = true;
            sherpa.recognizer = null;
            sherpa.module = null;
            sherpa.loaded = true;
            sherpa.base = dir;
            el.sherpaStatus.textContent = t().loaded;
            el.sherpaStatus.className = 'model-status success';
            return;
          } catch (workerError) {
            console.warn('sherpa worker path failed; falling back to the main thread:', workerError);
            try { sherpaWorker?.terminate(); } catch (error) { /* 已經死了 */ }
            sherpaWorker = null;
            sherpa.workerMode = false;
          } finally {
            // Worker 在 load 階段就同步 importScripts 完兩支膠水層，之後可以安全撤銷
            for (const url of glueUrls || []) { try { URL.revokeObjectURL(url); } catch (error) { /* 已撤銷 */ } }
          }
        }

        await loadScript(dir + 'sherpa-onnx-asr.js', 'createOnlineRecognizer');

        // 自行取得 199 MB 的 .data 並存進 Cache Storage，再用 getPreloadedPackage
        // 交給 emscripten，避免每次開頁面重抓（HF 沒給 Cache-Control，
        // 這個預建包也沒開 --use-preload-cache）
        const packageData = await fetchSherpaPackage(dir + SHERPA_DATA_FILE);

        // sherpa 的 emscripten glue 讀取全域 Module，必須在載入 wasm 主檔前設定好
        const ready = new Promise((resolve, reject) => {
          window.Module = {
            locateFile: path => dir + path,
            getPreloadedPackage: () => packageData,
            setStatus: status => {
              if (status) el.sherpaStatus.textContent = status;
            },
            onRuntimeInitialized: () => resolve(window.Module),
            onAbort: reason => reject(new Error(String(reason)))
          };
        });

        await loadScript(dir + 'sherpa-onnx-wasm-main-asr.js');
        sherpa.module = await ready;

        sherpa.recognizer = window.createOnlineRecognizer(sherpa.module);
        sherpa.loaded = true;
        sherpa.base = dir;
        el.sherpaStatus.textContent = t().loaded;
        el.sherpaStatus.className = 'model-status success';
      } catch (error) {
        console.error('sherpa-onnx load failed:', error);
        sherpa.loaded = false;
        sherpa.recognizer = null;
        sherpa.module = null;
        el.sherpaStatus.textContent = t().loadFailed + (error.message || error);
        el.sherpaStatus.className = 'model-status error';
      } finally {
        el.sherpaBar.classList.remove('indeterminate');
        el.sherpaBar.style.width = sherpa.loaded ? '100%' : '0';
        el.loadSherpa.disabled = false;
        sherpa.loadPromise = null;
        syncModelButtons();
      }
    })();

    return sherpa.loadPromise;
  }

  // 在音訊回呼中同步解碼。串流 Zipformer 的 RTF 遠低於 1，主執行緒吃得下。
  // ponytail: 單執行緒同步解碼；若在低階機器上卡住 UI，再搬進 Worker。






  // ==================== VAD（Whisper 與 Whistle 共用的分句）====================
  // maxSeconds 是「一路說不停」時強制切段的上限。預設 15 秒（Whisper 的
  // chunk_length_s 也是 15）；Whistle 用 10 秒 —— 實測（真模型、30 秒連續語音）：
  //   上限 15 s：第一段文字 4,255 ms，全部 13,067 ms（RTF 0.44）
  //   上限 10 s：第一段文字 2,749 ms，全部 14,733 ms（RTF 0.49）
  //   上限  8 s：第一段文字 2,255 ms，全部 15,559 ms（RTF 0.52）
  // 也就是「首字延遲 −35%、總 CPU +13%」，而且 RTF 仍在 0.5 上下、追得上即時。
  // 0.4 秒的前置緩衝本來就會讓切點有重疊，所以切短不會把字切掉。
  function createVad(maxSeconds = 15) {
    return {
      speaking: false, silence: 0, speech: 0, maxSamples: SAMPLE_RATE * maxSeconds,
      pre: [], audio: [], samples: 0, threshold: +el.vad.value
    };
  }

  async function loadWhisper() {
    if (whisper.loadPromise) return whisper.loadPromise;

    whisper.loadPromise = (async () => {
      el.loadWhisper.disabled = true;
      el.whisperProgress.classList.add('visible');
      el.whisperBar.classList.add('indeterminate');
      el.whisperStatus.textContent = t().whisperLoading;
      el.whisperStatus.className = 'model-status';

      let candidatePipeline = null;
      let candidateDevice = null;

      try {
        const modelName = WHISPER_MODELS[el.whisperModel.value];
        if (whisper.pipe && whisper.model === modelName) {
          el.whisperStatus.textContent = `${t().loaded}（${whisper.device}）`;
          el.whisperStatus.className = 'model-status success';
          return;
        }

        if (whisperEngine.isBusy()) await whisperEngine.drainAll();

        const previousPipeline = whisper.pipe;
        whisper.pipe = null;
        whisper.model = null;
        whisper.device = null;
        await disposeWhisperPipeline(previousPipeline);

        // 首選：Worker。WebGPU/WASM 的選擇與退路都在 Worker 內（見 whisper-worker.js）
        // 失敗要能退回主執行緒：Worker 建得起來不代表它載得動（CDN 被擋、import 失敗、
        // 舊瀏覽器不支援 module worker）。沒有這層 try/catch 的話，這些情況會直接判整個
        // 引擎死亡，而主執行緒路徑（這個 commit 之前唯一的路徑）其實還有機會成功。
        if (ensureWhisperWorker()) {
          try {
            const ready = await whisperWorkerRequest({
              type: 'load', model: modelName, preferWebGpu: await hasWebGpuAdapter()
            });
            whisper.pipe = whisperWorkerPipeline;
            whisper.model = modelName;
            whisper.device = ready.device;
            el.whisperStatus.textContent = `${t().loaded}（${whisper.device}）`;
            el.whisperStatus.className = 'model-status success';
            if (state.engine === 'whisper') el.statusRuntime.textContent = whisper.device;
            return;
          } catch (workerError) {
            console.warn('Whisper worker path failed; falling back to the main thread:', workerError);
            try { whisperWorker?.terminate(); } catch (error) { /* 已經死了 */ }
            whisperWorker = null;
            whisperWorkerPending.clear();
            whisper.pipe = null;
            el.whisperBar.classList.add('indeterminate');
            el.whisperBar.style.width = '';
          }
        }

        // 後備：主執行緒（Worker 不可用或載入失敗時的原本路徑）
        whisper.module ||= await loadTransformers();

        if (await hasWebGpuAdapter()) {
          try {
            candidatePipeline = await whisper.module.pipeline(
              'automatic-speech-recognition', modelName, { device: 'webgpu', dtype: 'q4' });
            candidateDevice = 'WebGPU';
          } catch (error) {
            console.warn('WebGPU pipeline failed; falling back to WASM:', error);
            // transformers.js 4.2.0 會把「webgpu 失敗」記在模組實例裡，之後同一個實例
            // 連 wasm 都載不起來（實測一律回 no available backend found / [webgpu]），
            // 所以退路必須換一份全新的模組實例，否則 WebGPU 失敗等於整個引擎不能用
            whisper.module = await loadTransformers(true);
          }
        }

        if (!candidatePipeline) {
          // wasm 上 q8 的 decoder 量化在 transformers.js 4.2.0 會崩（Missing required scale），
          // 且失敗載入會毒化瀏覽器模型快取；退回路徑必須用 q4
          candidatePipeline = await whisper.module.pipeline(
            'automatic-speech-recognition', modelName, { device: 'wasm', dtype: 'q4' });
          candidateDevice = 'WASM';
        }

        whisper.pipe = candidatePipeline;
        candidatePipeline = null;
        whisper.model = modelName;
        whisper.device = candidateDevice;
        el.whisperStatus.textContent = `${t().loaded}（${whisper.device}）`;
        el.whisperStatus.className = 'model-status success';
        if (state.engine === 'whisper') el.statusRuntime.textContent = whisper.device;
      } catch (error) {
        console.error('Whisper model load failed:', error);
        await disposeWhisperPipeline(candidatePipeline);

        whisper.pipe = null;
        whisper.model = null;
        whisper.device = null;
        el.whisperStatus.textContent = t().loadFailed + (error.message || error);
        el.whisperStatus.className = 'model-status error';
      } finally {
        el.whisperBar.classList.remove('indeterminate');
        el.whisperBar.style.width = whisper.pipe ? '100%' : '0';
        el.loadWhisper.disabled = false;
        syncModelButtons();
      }
    })();

    try {
      await whisper.loadPromise;
    } finally {
      whisper.loadPromise = null;
    }
  }

  const WHISPER_MAX_QUEUED = 3;

  // ==================== Whistle（Cactus Compute，16.9 MB 本機模型）====================
  // 定位：首次下載量只有 sherpa 的 1/12（16.9 MB vs 199 MB）、Whisper small 的 1/14，
  // 支援英德法西義荷波七種語言，不支援中文。解碼走 Worker（WASM RTF 約 0.3）。
  //
  // 為什麼用「停頓分句」而不是引擎內建的 needle_stream_transcribe_process：
  // 那支 API 每一輪都會把整個緩衝重新轉寫一次，成本隨緩衝長度成長 —— 本機實測
  // 餵 1 秒音訊、緩衝 10 秒時單輪要 3.4 秒，30 秒時要 1.4–7 秒，也就是跟不上即時
  // （36 秒音訊共花 113 秒，RTF 3.2）。分段後每段獨立轉寫，總成本是線性的（RTF 0.3），
  // 代價是字幕比真串流慢一到兩秒。既有的 sherpa 才是真串流，兩者定位互補。







  // 回傳 .cact 的 ArrayBuffer：優先讀 Cache Storage，沒有才下載並存起來。
  // 快取鍵就是模型網址 —— 換網址等於換模型，自然會重新下載。












  // ==================== Underdog Bark 3.0 engine ====================
  // 為什麼借不到 sherpa：這份匯出是 parakeet-TDT 的自訂圖（encoder 輸出 640 維、
  // decoder_joint 帶 state_h/state_c 與 5 個 duration logits），不是 sherpa 的
  // transducer 介面，所以自己用 onnxruntime-web 走 mel → encoder → greedy TDT。
  // 整個推論（含 432 MB 權重的下載與解碼）都在 Worker 裡，主執行緒只收進度與文字。




















  // ==================== 量測（Phase 0）====================
  // 目的：把「延遲」變成看得到的數字，而不是感覺。只記錄、不影響流程。
  // HUD 預設關閉；window.__sttMetrics 永遠可讀，瀏覽器端測試靠它斷言。
  const metrics = { jobs: [], engine: '', longTasks: { count: 0, max: 0 } };

  function metricsSubmit(engine, samples) {
    return { engine, audioSec: samples / SAMPLE_RATE, at: performance.now() };
  }

  function metricsCommit(job, text) {
    if (!job) return null;
    const latency = (performance.now() - job.at) / 1000;
    const entry = {
      engine: job.engine,
      audioSec: Number(job.audioSec.toFixed(2)),
      latency: Number(latency.toFixed(2)),
      rtf: job.audioSec > 0 ? Number((latency / job.audioSec).toFixed(2)) : null,
      chars: (text || '').length,
      charsPerSec: latency > 0 ? Math.round((text || '').length / latency) : null,
    };
    metrics.jobs.push(entry);
    if (metrics.jobs.length > 200) metrics.jobs.shift();
    metrics.engine = job.engine;
    if (!el.metricsHud.hidden) renderMetricsHud();
    return entry;
  }

  function metricsSnapshot() {
    const latencies = metrics.jobs.map(j => j.latency).sort((a, b) => a - b);
    const rtfs = metrics.jobs.map(j => j.rtf).filter(v => v != null);
    const pick = q => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] : null);
    const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const round = v => (v == null ? null : Number(v.toFixed(2)));
    return {
      engine: metrics.engine,
      count: metrics.jobs.length,
      latency: {
        last: metrics.jobs.length ? metrics.jobs[metrics.jobs.length - 1].latency : null,
        avg: round(mean(latencies)),
        p95: pick(0.95),
      },
      rtf: round(mean(rtfs)),
      longTasks: { ...metrics.longTasks },
      jobs: metrics.jobs.slice(-10),
    };
  }

  function renderMetricsHud() {
    const s = metricsSnapshot();
    if (!s.count) {
      el.metricsHud.textContent = t().metricsNothing;
      return;
    }
    el.metricsHud.textContent = [
      `${t().metricsLatency} ${s.latency.last}s（${t().metricsAvg} ${s.latency.avg}s／p95 ${s.latency.p95}s）`,
      `RTF ${s.rtf ?? '-'}｜long task ${s.longTasks.count}（max ${s.longTasks.max} ms）`,
      `${s.engine} × ${s.count}`,
    ].join('\n');
  }

  window.__sttMetrics = { snapshot: metricsSnapshot, reset: () => { metrics.jobs = []; metrics.longTasks = { count: 0, max: 0 }; if (!el.metricsHud.hidden) renderMetricsHud(); } };

  if ('PerformanceObserver' in window) {
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          metrics.longTasks.count += 1;
          metrics.longTasks.max = Math.max(metrics.longTasks.max, Math.round(entry.duration));
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch (error) {
      console.warn('longtask observer unavailable:', error);
    }
  }

  // ==================== 本機翻譯層（Phase 1）====================
  // 只翻「已結束的句子」；模型（約 114 MB）跑在 mt-worker.js，首次載入 7.8 s。
  // 失敗只降級成「只有原文」，不影響辨識本身。
  const MT_DEFAULT_MODEL = 'Xenova/opus-mt-en-zh';
  const MT_CACHE_LIMIT = 500;
  const mt = {
    enabled: false, model: MT_DEFAULT_MODEL, script: 'zh-Hant', inTranscript: true,
    worker: null, seq: 0, pending: new Map(), loadPromise: null, loadedModel: null,
    queue: [], busy: false, cache: new Map(), warningShown: false, translated: 0,
  };
  let pipWindow = null;

  function ensureMtWorker() {
    if (mt.worker) return mt.worker;
    try {
      mt.worker = new Worker('mt-worker.js', { type: 'module' });
    } catch (error) {
      console.warn('Translation worker unavailable:', error);
      mt.worker = null;
      return null;
    }
    mt.worker.onmessage = event => {
      const msg = event.data || {};
      if (msg.type === 'progress') {
        if (msg.phase === 'download' && msg.progress >= 100) el.mtStatus.textContent = `${t().mtDownloading} ${msg.file}`;
        return;
      }
      const key = msg.id || 'load';
      const pending = mt.pending.get(key);
      if (!pending) return;
      mt.pending.delete(key);
      if (msg.type === 'error') pending.reject(new Error(msg.message));
      else pending.resolve(msg);
    };
    mt.worker.onerror = event => {
      console.warn('Translation worker crashed:', event.message || event);
      for (const [, p] of mt.pending) p.reject(new Error(event.message || 'worker crash'));
      mt.pending.clear();
      try { mt.worker.terminate(); } catch (error) { /* 已經死了 */ }
      mt.worker = null;
      mt.loadedModel = null;
    };
    return mt.worker;
  }

  function mtRequest(payload) {
    const worker = ensureMtWorker();
    if (!worker) return Promise.reject(new Error('worker unavailable'));
    const key = payload.type === 'load' ? 'load' : payload.id;
    return new Promise((resolve, reject) => {
      mt.pending.set(key, { resolve, reject });
      try {
        worker.postMessage(payload);
      } catch (error) {
        mt.pending.delete(key);
        reject(error);
      }
    });
  }

  async function ensureMtLoaded() {
    if (mt.loadedModel === mt.model) return;
    if (mt.loadPromise) return mt.loadPromise;
    mt.loadPromise = (async () => {
      el.mtStatus.textContent = t().mtLoading;
      el.mtStatus.className = 'model-status';
      await mtRequest({ type: 'load', model: mt.model });
      mt.loadedModel = mt.model;
      el.mtStatus.textContent = t().mtReady;
      el.mtStatus.className = 'model-status success';
    })();
    try {
      await mt.loadPromise;
    } finally {
      mt.loadPromise = null;
    }
  }

  // 拉丁字母為主才翻：中文引擎的輸出丟進 en→zh 只會被翻壞

  async function toTraditional(text) {
    if (mt.script !== 'zh-Hant') return text;
    try { await ensureOpencc(); } catch (error) { /* 沒有 OpenCC 就原樣輸出 */ }
    const convert = getOpenccConverter('twp');
    try {
      return convert ? convert(text) : text;
    } catch (error) {
      console.warn('OpenCC conversion failed for translation:', error);
      return text;
    }
  }

  function queueTranslation(segment) {
    if (!mt.enabled || !segment || !segment.text) return;
    if (segment.zh || !isLatinDominated(segment.text)) return;
    if (/^--- .* ---$/.test(segment.text)) return;      // 「錄音開始」這種標記不是語音
    mt.queue.push(segment);
    void processMtQueue();
  }

  function applyTranslation(segment, zh) {
    segment.zh = zh;
    persistTranscript();
    renderSubtitles();
    // 逐字稿要顯示譯文時，只有「譯文後到」的段落需要重畫；整份重建在段落數少時才划算
    if (mt.inTranscript && state.segments.length <= 800) {
      renderTranscript(true);
    }
  }

  function processMtQueue() {
    if (mt.busy || !mt.enabled) return;
    const segment = mt.queue.shift();
    if (!segment) return;
    mt.busy = true;
    (async () => {
      try {
        if (state.segments.indexOf(segment) === -1) return;   // 已經被清空
        const key = segment.text.trim().toLowerCase();
        if (mt.cache.has(key)) {
          applyTranslation(segment, mt.cache.get(key));
          return;
        }
        await ensureMtLoaded();
        if (!mt.enabled) return;
        const out = await mtRequest({ type: 'translate', id: ++mt.seq, text: segment.text });
        const zh = await toTraditional(String(out.text || '').trim());
        if (!zh) return;
        mt.cache.set(key, zh);
        if (mt.cache.size > MT_CACHE_LIMIT) mt.cache.delete(mt.cache.keys().next().value);
        mt.translated += 1;
        applyTranslation(segment, zh);
        el.mtStatus.textContent = `${t().mtReady}（${mt.translated}）`;
      } catch (error) {
        console.warn('Translation failed:', error);
        el.mtStatus.textContent = t().mtFailed + (error.message || error);
        el.mtStatus.className = 'model-status error';
        if (!mt.warningShown) {
          mt.warningShown = true;
          showToast(t().mtFailed + (error.message || error));
        }
      } finally {
        mt.busy = false;
        if (mt.queue.length) void processMtQueue();
      }
    })();
  }

  async function setMtEnabled(on) {
    mt.enabled = !!on;
    el.mtToggle.checked = mt.enabled;
    if (!mt.enabled) {
      mt.queue = [];
      el.mtStatus.textContent = t().mtOff;
      el.mtStatus.className = 'model-status';
      renderSubtitles();
      return;
    }
    try {
      await ensureMtLoaded();
      el.subtitleBar.hidden = false;
      // 開啟前的段落也補翻（會後才想到要中文也用得到）
      for (const segment of state.segments) queueTranslation(segment);
      renderSubtitles();
    } catch (error) {
      console.warn('Translation model failed to load:', error);
      mt.enabled = false;
      el.mtToggle.checked = false;
      el.mtStatus.textContent = t().mtFailed + (error.message || error);
      el.mtStatus.className = 'model-status error';
      showToast(t().mtFailed + (error.message || error));
    }
  }

  // ==================== 雙語字幕條與浮動字幕窗 ====================
  function recentSubtitleSegments(n = 2) {
    const out = [];
    for (let i = state.segments.length - 1; i >= 0 && out.length < n; i--) {
      const segment = state.segments[i];
      if (!segment.text) continue;
      if (/^--- .* ---$/.test(segment.text)) continue;
      out.unshift(segment);
    }
    return out;
  }

  function subtitleTargets() {
    const targets = [];
    let pipBar = null;
    if (pipWindow) {
      // 視窗被關掉、或拿不到裡面的字幕條（headless／視窗還沒掛上 DOM）都算關閉：
      // 不這樣收尾的話，主視窗的字幕條會一直維持隱藏，看起來像「字幕不見了」
      pipBar = pipWindow.closed ? null : pipWindow.document.getElementById('subtitleBarPip');
      if (!pipBar) {
        pipWindow = null;
        el.subtitleBar.style.display = '';
      }
    }
    const show = mt.enabled || !!pipBar;
    el.subtitleBar.hidden = !show || !!pipBar;
    if (!el.subtitleBar.hidden) targets.push(el.subtitleBar);
    if (pipBar) targets.push(pipBar);
    return targets;
  }

  function renderSubtitles() {
    const targets = subtitleTargets();
    const segments = recentSubtitleSegments(2);
    if (!segments.length) {
      for (const bar of targets) {
        const zh = bar.querySelector('.subtitle-zh');
        const en = bar.querySelector('.subtitle-en');
        if (zh) zh.textContent = t().subtitleWaiting;
        if (en) en.textContent = '';
      }
      return;
    }
    const translated = segments.map(s => s.zh).filter(Boolean);
    const primary = translated.length ? translated.join(' ') : segments.map(s => s.text).join(' ');
    const secondary = translated.length ? segments.map(s => s.text).join(' ') : '';
    for (const bar of targets) {
      const zh = bar.querySelector('.subtitle-zh');
      const en = bar.querySelector('.subtitle-en');
      if (zh) zh.textContent = primary;
      if (en) en.textContent = secondary;
    }
  }

  async function openSubtitleWindow() {
    if (!('documentPictureInPicture' in window)) {
      showToast(t().pipUnsupported);
      return;
    }
    if (pipWindow && !pipWindow.closed) {
      pipWindow.focus();
      return;
    }
    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({ width: 960, height: 220 });
      for (const sheet of document.querySelectorAll('style, link[rel="stylesheet"]')) {
        pipWindow.document.head.appendChild(sheet.cloneNode(true));
      }
      pipWindow.document.body.classList.add('subtitle-pip-mode');
      pipWindow.document.body.dataset.subScale = document.body.dataset.subScale || 'm';
      pipWindow.document.title = t().subtitleTitle;
      const bar = el.subtitleBar.cloneNode(true);
      bar.id = 'subtitleBarPip';
      bar.hidden = false;
      bar.removeAttribute('hidden');
      pipWindow.document.body.appendChild(bar);
      pipWindow.addEventListener('pagehide', () => {
        pipWindow = null;
        renderSubtitles();
      });
      el.subtitleBar.style.display = 'none';
      renderSubtitles();
    } catch (error) {
      console.warn('Document PiP failed:', error);
      showToast(t().pipFailed);
    }
  }

  function applySubScale(value) {
    const scale = ['s', 'm', 'l'].includes(value) ? value : 'm';
    document.body.dataset.subScale = scale;
    if (pipWindow && !pipWindow.closed) pipWindow.document.body.dataset.subScale = scale;
  }

  // ==================== Web Speech API engine ====================
  function clearWebRestartTimer() {
    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
  }

  function clearWebErrorTimer() {
    if (state.webErrorTimer) {
      clearTimeout(state.webErrorTimer);
      state.webErrorTimer = null;
    }
  }

  function initWebSpeech() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => { state.webRecognitionActive = true; };

    recognition.onresult = event => {
      state.interim = '';
      let finalText = '';

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0].transcript;
        if (event.results[index].isFinal) finalText += transcript + ' ';
        else state.interim += transcript;
      }

      if (finalText.trim()) commit(finalText);
      else render();
    };

    recognition.onerror = event => {
      console.error('Web Speech error:', event);
      state.webRecognitionActive = false;

      if (['not-allowed', 'service-not-allowed', 'network', 'audio-capture'].includes(event.error)) {
        state.manualStop = true;
        clearWebRestartTimer();
        setLevel(0);

        if (event.error === 'network') showToast(t().netError);
        else if (event.error === 'audio-capture') showToast(t().micBusy);
        else showToast(t().mic);

        // onend 不一定會跟著致命錯誤來（各家瀏覽器行為不一）；逾時就自己收尾，
        // 否則畫面會一直停在「辨識中」，beforeunload 也會一直擋關頁
        clearWebErrorTimer();
        state.webErrorTimer = setTimeout(() => {
          state.webErrorTimer = null;
          if (!state.running) return;
          state.manualStop = true;
          clearWebRestartTimer();
          setLevel(0);
          finish();
        }, 1500);
      }
    };

    recognition.onend = () => {
      state.webRecognitionActive = false;
      clearWebRestartTimer();
      clearWebErrorTimer();

      if (state.running && !state.manualStop) {
        const scheduledGeneration = state.webGeneration;

        state.restartTimer = setTimeout(() => {
          state.restartTimer = null;
          const isCurrentGeneration = scheduledGeneration === state.webGeneration;
          const shouldRestart = state.running && !state.manualStop && !state.webRecognitionActive;
          if (!isCurrentGeneration || !shouldRestart) return;

          try {
            recognition.start();
          } catch (error) {
            if (error?.name !== 'InvalidStateError') console.error('Web Speech restart failed:', error);
          }
        }, WEB_RESTART_DELAY);
      } else {
        setLevel(0);
        finish();
      }
    };

    state.recognition = recognition;
  }

  function startWeb() {
    if (!state.recognition) return showToast(t().noWebSpeech);

    clearWebRestartTimer();
    clearWebErrorTimer();
    state.webGeneration += 1;
    state.webRecognitionActive = false;

    begin();
    state.running = true;
    state.manualStop = false;
    state.recognition.lang = el.lang.value;
    el.engine.disabled = el.lang.disabled = true;
    updateButtons();
    setLevel(0);

    try {
      state.recognition.start();
    } catch (error) {
      console.error('Web Speech start failed:', error);
      state.manualStop = true;
      setLevel(0);
      finish();
    }
  }

  function stopWeb() {
    state.manualStop = true;
    state.stopping = true;
    state.webGeneration += 1;
    clearWebRestartTimer();
    clearWebErrorTimer();
    updateButtons();

    try {
      if (state.webRecognitionActive) state.recognition.stop();
      else { setLevel(0); finish(); }
    } catch (error) {
      console.warn('Web Speech stop failed:', error);
      setLevel(0);
      finish();
    }
  }

  // ==================== 引擎介面收斂（Phase 2）====================
  // Whisper / Whistle / Underdog 三個批次引擎的「排隊 → 推論 → commit → 等收尾」現在只有
  // 一份實作（src/engines/batch.js），這裡只填三份差異：可不可以開始、要帶什麼參數、
  // 怎麼推論、失敗怎麼講。runtime 直接傳引擎自己的狀態物件，所以 `whistle.queue`
  // 這類既有讀取方式仍然成立。
  const engineCtx = {
    el, t, state, commit, showToast, AudioCapture, createVad, vadPush, vadFlush,
    setLevel, render, begin, finish, updateButtons, metricsSubmit, metricsCommit,
  };

  const liveCtx = { ...engineCtx, traditional };

  const whisperEngine = createBatchPipeline(engineCtx, {
    id: 'whisper',
    role: 'refine',
    runtime: whisper,
    segmentSeconds: 15,
    maxQueued: WHISPER_MAX_QUEUED,
    queueFullMessage: () => t().whisperQueueFull,
    canStart: () => !!whisper.pipe && whisper.model === WHISPER_MODELS[el.whisperModel.value],
    describe: () => ({ language: el.lang.value }),
    transcribe: async job => {
      // Worker 路徑：推論不在主執行緒，UI 不會被長時間的 chunk 卡住
      const output = whisper.pipe === whisperWorkerPipeline
        ? await whisperWorkerTranscribe(job.audio, job.language)
        : await whisper.pipe(job.audio, {
            language: LANG[job.language],
            task: 'transcribe',
            chunk_length_s: 15,
            stride_length_s: 2,
          });
      return output?.text || '';
    },
    onInferenceError: error => {
      showToast(t().whisperFailed + (error.message || error));
      // Worker 路徑會直接帶 deviceLost 旗標；主執行緒路徑只能看訊息內容
      const msg = String(error?.message || '').toLowerCase();
      if (error?.deviceLost || msg.includes('device lost') || msg.includes('webgpu') || msg.includes('oom')) {
        whisper.pipe = null;
        whisper.model = null;
        whisper.device = null;
        el.whisperStatus.textContent = t().whisperDeviceLost;
        el.whisperStatus.className = 'model-status error';
      }
    },
  });

  const whistleEngine = createWhistleEngine({
    ...engineCtx,
    loadScript,
    downloadInChunks,
    syncModelButtons,
  });

  const underdogEngine = createUnderdogEngine({
    ...engineCtx,
    syncModelButtons,
  });


  // ==================== 串流引擎（Phase 2）====================
  // Vosk 與 sherpa 都是「邊餵邊吐字」，差別只在怎麼餵、停止時怎麼收尾。
  // 啟停、字幕套用、錯誤計數由 src/engines/live.js 統一，這裡只留兩份 spec。
  const voskEngine = createLiveEngine(liveCtx, {
    id: 'vosk',
    role: 'live',
    canStart: () => vosk.loaded,
    attach: ({ emit, isActive, getContext }) => {
      vosk.recognizer = new vosk.model.KaldiRecognizer(SAMPLE_RATE);
      vosk.recognizer.setWords(false);
      vosk.recognizer.on('result', m => emit({ type: 'final', text: m.result?.text }));
      vosk.recognizer.on('partialresult', m => emit({ type: 'partial', text: m.result?.partial }));
      const active = vosk.recognizer;
      return {
        push: chunk => {
          if (!isActive() || active !== vosk.recognizer) return;
          // 用 getContext()：AudioContext 要到 AudioCapture.start() 之後才存在
          active.acceptWaveform(makeAudioBuffer(getContext(), chunk));
        },
        flush: () => removeVoskRecognizer(),
      };
    },
  });

  const sherpaEngine = createLiveEngine(liveCtx, {
    id: 'sherpa',
    role: 'live',
    canStart: () => sherpa.loaded && (!!sherpa.recognizer || sherpa.workerMode),
    attach: async ({ emit, isActive }) => {
      sherpa.sessionId += 1;
      const sessionId = sherpa.sessionId;
      sherpa.feedErrors = 0;

      if (sherpa.workerMode) {
        // Worker 模式：結果由 Worker 推回來，endpoint 就當成 final
        const handler = msg => {
          if (msg.sessionId !== sessionId || !isActive()) return;
          if (msg.type === 'result' && !msg.started) {
            emit({ type: msg.endpoint ? 'final' : 'partial', text: msg.text || '' });
          }
        };
        sherpaWorkerHandlers.add(handler);
        sherpa.workerHandler = handler;
        sherpa.stream = { worker: true };          // 只作為「已在錄音」的旗標
        await sherpaWorkerAsk({ type: 'start', sessionId });
        return {
          push: chunk => {
            const copy = chunk.slice();
            sherpaWorkerSend({ type: 'feed', sessionId, audio: copy }, [copy.buffer]);
          },
          flush: async () => {
            try {
              // 請 Worker 補靜音收尾並回傳最後結果（0.4 秒靜音那段邏輯在 Worker 內）
              const final = await sherpaWorkerAsk({ type: 'flush', sessionId });
              if (sessionId === sherpa.sessionId) emit({ type: 'final', text: final?.text || '' });
            } finally {
              if (sherpa.workerHandler) { sherpaWorkerHandlers.delete(sherpa.workerHandler); sherpa.workerHandler = null; }
              sherpaWorkerSend({ type: 'free' });
              sherpa.stream = null;
            }
          },
        };
      }

      // 主執行緒模式：自己 decode
      sherpa.stream = sherpa.recognizer.createStream();
      const stream = sherpa.stream;
      // 一次解碼迴圈（partial／endpoint／reset 的細節在 src/engines/sherpa-decode.js，
      // 那裡有獨立的測試，不必再從 HTML 刮原始碼）
      const decode = () => decodeSherpa({
        recognizer: sherpa.recognizer,
        stream,
        emit,
        isActive,
      });
      return {
        push: chunk => {
          stream.acceptWaveform(SAMPLE_RATE, chunk);
          decode();
        },
        flush: () => {
          try {
            // 補 0.4 秒靜音，讓模型吐出最後一段尚未收尾的語音
            stream.acceptWaveform(SAMPLE_RATE, new Float32Array(Math.round(SAMPLE_RATE * 0.4)));
            stream.inputFinished();
            const recognizer = sherpa.recognizer;
            while (recognizer && recognizer.isReady(stream)) recognizer.decode(stream);
            emit({ type: 'final', text: recognizer?.getResult(stream)?.text || '' });
          } finally {
            try { stream.free(); } catch (error) { console.warn(error); }
            sherpa.stream = null;
          }
        },
      };
    },
  });

  // 引擎註冊表：`toggle()` 與 UI 只認這個介面。
  // 還沒收斂的四個引擎形狀本來就不同（sherpa 是真串流、vosk 有自己的 recognizer、
  // moss 是雲端批次、webspeech 是瀏覽器 API），所以先包成 { start, stop, role }。
  const ENGINES = {
    vosk: voskEngine,
    sherpa: sherpaEngine,
    whisper: whisperEngine,
    whistle: whistleEngine,
    underdog: underdogEngine,
    webspeech: { role: 'fallback', start: startWeb, stop: stopWeb },
    moss: { role: 'cloud', start: () => showToast(t().mossBatchMode), stop: () => {} },
  };

  async function toggle() {
    if (state.stopping) return;
    const engine = ENGINES[state.engine] || ENGINES.webspeech;
    await (state.running ? engine.stop() : engine.start());
  }

  // ==================== UI, preferences, export ====================
  // ==================== MOSS-Transcribe-Diarize（雲端 Hugging Face Space）====================
  // 批次轉寫：整段音訊／影片上傳後，一次取回含時間戳與說話人標籤的逐字稿。
  // 音訊會離開瀏覽器送到第三方 Space，因此隱私等級與 Web Speech API 同級（雲端），
  // 不列入 privacyConclusion 的「敏感內容請改用」清單。
  const moss = { running: false, segments: [], controller: null, watchdog: null, maxTimer: null, timedOut: false };
  let mossProgressTimer = null;
  // 串流超過 3 分鐘沒有新資料就中止（Space 冷啟動可能很久，所以不能抓太緊）；
  // 另外設一個單次執行的絕對上限，避免上傳卡死時按鈕永遠停不下來。
  const MOSS_STALL_MS = 180000;
  const MOSS_MAX_MS = 30 * 60 * 1000;

  const MOSS_SPACES = {
    official: { host: 'https://openmoss-team-moss-transcribe-diarize.hf.space', apiName: 'run_transcription', mode: 'gradio' },
    litert: { host: 'https://luigi-moss-transcribe-diarize-litert.hf.space', mode: 'rest' }
  };

  function mediaClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  // 官方 Space 回傳純文字，每段一行："[0.07-4.89] [S01] 文字"
  // 逐行解析，文字內含 [ 也不截斷
  function parseMossGradio(text) {
    const out = [];
    const linePattern = /^\[\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\]\s*\[(S\d+)\]\s*(.*)$/;
    for (const line of String(text || '').split(/\r?\n/)) {
      const hit = linePattern.exec(line);
      if (!hit) continue;
      const body = hit[4].trim();
      if (body) out.push({ start: +hit[1], end: +hit[2], spk: hit[3], text: body });
    }
    return out;
  }

  // LiteRT Space 的 REST 路由已回傳解析好的 segments
  function parseMossSegments(segments) {
    return (segments || [])
      .map(x => ({ start: x.start, end: x.end, spk: x.spk || 'S01', text: String(x.text || '').trim() }))
      .filter(x => x.text);
  }

  function mossLine(seg) {
    const range = seg.end == null ? mediaClock(seg.start) : `${mediaClock(seg.start)}-${mediaClock(seg.end)}`;
    return `[${range}] [${seg.spk}] ${seg.text}`;
  }

  function setMossProgress(ratio) {
    if (ratio === null) {
      el.mossBar.classList.add('indeterminate');
      el.mossBar.style.width = '';
      return;
    }
    el.mossBar.classList.remove('indeterminate');
    el.mossBar.style.width = `${ratio}%`;
  }

  function hideMossProgressLater() {
    clearTimeout(mossProgressTimer);
    mossProgressTimer = setTimeout(() => {
      el.mossProgress.classList.remove('visible');
      setMossProgress(0);
      mossProgressTimer = null;
    }, 800);
  }

  function updateMossFileText() {
    const file = el.mossFile.files && el.mossFile.files[0];
    el.mossFileText.textContent = file ? `${file.name} (${(file.size / 1048576).toFixed(1)} MB)` : t().mossPickHint;
  }

  // 換檔就作廢上一次的結果，否則「輸出 SRT」會把上一個檔案的內容寫成新檔名
  function resetMossResult() {
    moss.segments = [];
    el.mossSrt.disabled = true;
    el.mossStatus.textContent = '';
    el.mossStatus.className = 'model-status';
  }

  function updateMossButton() {
    el.mossRun.textContent = moss.running ? t().mossCancel : t().mossRun;
    el.mossRun.disabled = false;
  }

  function clearMossTimers() {
    clearTimeout(moss.watchdog);
    clearTimeout(moss.maxTimer);
    moss.watchdog = null;
    moss.maxTimer = null;
  }

  // 每讀到新資料就把停滯計時器往後推；真的卡住時 abort，讓 runMoss 能收尾
  function feedMossWatchdog() {
    clearTimeout(moss.watchdog);
    moss.watchdog = setTimeout(() => {
      moss.timedOut = true;
      moss.controller?.abort();
    }, MOSS_STALL_MS);
  }

  function cancelMoss() {
    if (!moss.running) return;
    moss.controller?.abort();
  }

  function mossSrtTime(seconds) {
    const raw = Math.max(0, Number(seconds) || 0);
    const totalMs = Math.round(raw * 1000);
    const h = Math.floor(totalMs / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    const s = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  function exportMossSrt() {
    if (!moss.segments.length) return;
    const body = moss.segments.map((seg, i) => {
      const end = Number(seg.end) > 0 ? Number(seg.end) : seg.start;
      return `${i + 1}\n${mossSrtTime(seg.start)} --> ${mossSrtTime(end)}\n[${seg.spk}] ${seg.text}\n`;
    }).join('\n');
    const base = String((el.mossFile.files && el.mossFile.files[0]?.name) || 'transcript').replace(/\.[^.]+$/, '') || 'transcript';
    const blob = new Blob(['\uFEFF' + body], { type: 'text/plain;charset=utf-8' });
    const anchor = document.createElement('a');
    const objectUrl = URL.createObjectURL(blob);
    anchor.href = objectUrl;
    anchor.download = `${base}.srt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
  }

  async function runMoss() {
    const file = el.mossFile.files && el.mossFile.files[0];
    if (!file) { showToast(t().mossPickFile); return; }
    if (moss.running) return;

    const space = MOSS_SPACES[el.mossSpace.value] || MOSS_SPACES.official;
    const startedAt = Date.now();
    const controller = new AbortController();
    moss.controller = controller;
    moss.timedOut = false;
    moss.running = true;
    moss.segments = [];
    el.mossSrt.disabled = true;
    clearTimeout(mossProgressTimer);
    el.mossSpace.disabled = true;
    el.mossFile.disabled = true;
    el.engine.disabled = true;
    el.control.disabled = true;
    updateMossButton();
    syncEngineCards();
    el.mossProgress.classList.add('visible');
    el.mossStatus.className = 'model-status';
    el.mossStatus.textContent = t().mossUploading;
    setMossProgress(null);
    clearMossTimers();
    // 上傳與 REST 轉寫都可能合法地跑很久，所以只用「絕對上限」；串流階段另外加停滯偵測
    moss.maxTimer = setTimeout(() => {
      moss.timedOut = true;
      controller.abort();
    }, MOSS_MAX_MS);

    try {
      let segments = [];
      let rawText = '';

      if (space.mode === 'rest') {
        const res = await fetch(`${space.host}/api/transcribe?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
          signal: controller.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        segments = parseMossSegments(data.segments);
        rawText = data.rawTraditional || data.raw || '';
      } else {
        const form = new FormData();
        form.append('files', file);
        const upload = await fetch(`${space.host}/gradio_api/upload`, {
          method: 'POST', body: form, signal: controller.signal
        });
        if (!upload.ok) throw new Error(`upload HTTP ${upload.status}`);
        const uploaded = await upload.json();
        const path = Array.isArray(uploaded) ? uploaded[0] : uploaded;
        setMossProgress(20);
        el.mossStatus.textContent = t().mossRunning;

        feedMossWatchdog();
        const call = await fetch(`${space.host}/gradio_api/call/${space.apiName}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: [{ path, meta: { _type: 'gradio.FileData' }, orig_name: file.name }, null] }),
          signal: controller.signal
        });
        if (!call.ok) throw new Error(`call HTTP ${call.status}`);
        const { event_id: eventId } = await call.json();
        setMossProgress(55);

        feedMossWatchdog();
        const stream = await fetch(`${space.host}/gradio_api/call/${space.apiName}/${eventId}`, {
          signal: controller.signal
        });
        if (!stream.ok || !stream.body) throw new Error(`stream HTTP ${stream.status}`);
        const reader = stream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          feedMossWatchdog();
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const parsed = JSON.parse(payload);
              // Gradio 的 data 幀形如 ["<逐字稿>"]；官方 Space 的值就是整份逐字稿字串
              const value = Array.isArray(parsed) ? parsed[0] : parsed;
              if (typeof value === 'string' && value.trim()) rawText = value;
            } catch (error) { /* 心跳或非 JSON 事件，忽略 */ }
          }
        }
        segments = parseMossGradio(rawText);
      }

      clearTimeout(moss.watchdog);
      moss.watchdog = null;
      setMossProgress(100);
      if (!segments.length) {
        el.mossStatus.className = 'model-status error';
        el.mossStatus.textContent = rawText ? t().mossNoSegments : t().mossEmpty;
        if (rawText) commit(rawText);
        hideMossProgressLater();
        return;
      }

      const seconds = Math.round((Date.now() - startedAt) / 1000);
      moss.segments = segments;
      el.mossSrt.disabled = false;
      // 一次寫入整批：逐段 commit 會每段都 render 並排一次 rAF 捲動
      await commitBatch([
        `--- MOSS 轉寫：${file.name}（${segments.length} 段，耗時 ${seconds} 秒）---`,
        ...segments.map(mossLine)
      ]);
      el.mossStatus.className = 'model-status success';
      el.mossStatus.textContent = `${t().mossDone}（${segments.length} 段，${seconds} 秒）`;
      showToast(t().mossDone);
      hideMossProgressLater();
    } catch (error) {
      if (error && error.name === 'AbortError') {
        el.mossStatus.className = 'model-status';
        setMossProgress(0);
        el.mossStatus.textContent = moss.timedOut ? t().mossTimeout : t().mossCancelled;
      } else {
        console.warn('MOSS transcription failed:', error);
        el.mossStatus.className = 'model-status error';
        setMossProgress(0);
        el.mossStatus.textContent = `${t().mossFailed}：${error.message}｜${t().mossColdHint}`;
      }
      hideMossProgressLater();
    } finally {
      clearMossTimers();
      moss.controller = null;
      moss.running = false;
      el.mossSpace.disabled = false;
      el.mossFile.disabled = false;
      el.engine.disabled = false;
      updateMossButton();
      updateButtons();
    }
  }

  function setUi(lang) {
    state.ui = lang;
    const d = T[lang];
    document.documentElement.lang = lang === 'zh' ? 'zh-TW' : 'en';
    el.title.textContent = d.title;
    el.toggle.textContent = d.toggleBtn;
    el.placeholder.textContent = d.placeholder;
    el.copy.textContent = d.copy;
    el.export.textContent = d.export;
    el.clear.textContent = d.clear;
    el.loadVosk.textContent = el.loadSherpa.textContent = el.loadWhisper.textContent = el.loadWhistle.textContent = d.loadModel;
    el.loadUnderdog.textContent = d.loadModel;
    el.clearSherpaCache.textContent = d.sherpaClearCache;
    el.clearWhistleCache.textContent = d.whistleClearCache;
    el.clearUnderdogCache.textContent = d.underdogClearCache;
    el.pipBtn.textContent = d.pipBtn;
    updateMossButton();
    el.mossSrt.textContent = d.mossSrt;

    for (const key of [
      'engineLabel', 'langLabel', 'optWebspeech', 'optVosk', 'optSherpa', 'optWhisper', 'optWhistle', 'optMoss',
      'optUnderdog', 'underdogBaseLabel', 'underdogVariantLabel', 'optUnderdogQ4', 'optUnderdogQ8',
      'subtitleTitle', 'mtToggleLabel', 'mtScriptLabel', 'mtModelLabel', 'subScaleLabel',
      'optMtHant', 'optMtHans', 'optSubS', 'optSubM', 'optSubL', 'metricsToggleLabel',
      'mossSpaceLabel', 'optMossOfficial', 'optMossLitert', 'mossFileLabel',
      'voskSourceLabel', 'voskModelLabel', 'voskFileLabel', 'optVoskBuiltin', 'optVoskFile',
      'optVoskUrl', 'sherpaBaseLabel', 'whisperModelLabel', 'vadLabel', 'optVadHigh',
      'optVadMid', 'optVadLow', 'statusEngineLabel', 'statusRuntimeLabel',
      'statusPrivacyLabel', 'statusStateLabel', 'privacySummary',
      'whistleUrlLabel', 'enginesTitle', 'riskTitle', 'privacyConclusion'
    ]) {
      $(key).textContent = d[key];
    }
    $('howItWorksText').textContent = d.howItWorks;
    $('voskHint').innerHTML = d.voskHint;
    $('sherpaHint').innerHTML = d.sherpaHint;
    $('whisperHint').innerHTML = d.whisperHint;
    $('whistleHint').innerHTML = d.whistleHint;
    $('underdogHint').innerHTML = d.underdogHint;
    $('subtitleHint').innerHTML = d.subtitleHint;
    $('mossHint').innerHTML = d.mossHint;
    $('enginesList').innerHTML = d.engines.map(x => `<li>${x}</li>`).join('');
    $('riskList').innerHTML = d.risks.map(x => `<li>${x}</li>`).join('');

    for (const [engine, cfg] of Object.entries(d.ecards)) {
      const card = el.engineCards.querySelector(`.engine-card[data-engine="${engine}"]`);
      if (!card) continue;
      card.querySelector('.ecard-name').textContent = cfg.name;
      card.querySelector('.ecard-tag').textContent = cfg.tag;
      card.querySelector('.ecard-desc').textContent = cfg.desc;
    }
    updateMossFileText();

    // updateEngine() 內部已呼叫 updateButtons() 與 save()
    updateEngine();
  }

  function save() {
    try {
      localStorage.setItem('stt-pref', JSON.stringify({
        ui: state.ui,
        engine: el.engine.value,
        lang: el.lang.value,
        whisper: el.whisperModel.value,
        sherpaBase: el.sherpaBase.value.trim(),
        whistleUrl: el.whistleUrl.value.trim(),
        underdogBase: el.underdogBase.value.trim(),
        underdogVariant: el.underdogVariant.value,
        mtEnabled: mt.enabled,
        mtScript: el.mtScript.value,
        mtModel: el.mtModel.value.trim(),
        subScale: document.body.dataset.subScale || 'm',
        metrics: !el.metricsHud.hidden,
        voskSource: el.voskSource.value,
        vad: el.vad.value,
        mossSpace: el.mossSpace.value
      }));
    } catch {}
  }

  const KNOWN_ENGINES = ['webspeech', 'vosk', 'sherpa', 'whisper', 'whistle', 'underdog', 'moss'];
  const hasOption = (select, value) => Array.from(select.options).some(o => o.value === value);

  function load() {
    try {
      const p = JSON.parse(localStorage.getItem('stt-pref') || '{}');
      // localStorage 可能留著舊版的值；不驗證會讓 state.engine 變成空字串，
      // 狀態卡、引擎卡片與 quickstart 就全部對不起來
      if (KNOWN_ENGINES.includes(p.engine)) el.engine.value = p.engine;
      if (p.lang && hasOption(el.lang, p.lang)) el.lang.value = p.lang;
      if (p.whisper && hasOption(el.whisperModel, p.whisper)) el.whisperModel.value = p.whisper;
      if (p.voskSource && hasOption(el.voskSource, p.voskSource)) el.voskSource.value = p.voskSource;
      if (p.vad && hasOption(el.vad, p.vad)) el.vad.value = p.vad;
      if (p.mossSpace && hasOption(el.mossSpace, p.mossSpace)) el.mossSpace.value = p.mossSpace;
      if (p.sherpaBase) el.sherpaBase.value = p.sherpaBase;
      if (p.whistleUrl) el.whistleUrl.value = p.whistleUrl;
      if (p.underdogBase) el.underdogBase.value = p.underdogBase;
      if (p.underdogVariant && hasOption(el.underdogVariant, p.underdogVariant)) el.underdogVariant.value = p.underdogVariant;
      if (p.mtModel) el.mtModel.value = p.mtModel;
      if (p.mtScript && hasOption(el.mtScript, p.mtScript)) el.mtScript.value = p.mtScript;
      if (p.subScale && ['s', 'm', 'l'].includes(p.subScale)) el.subScale.value = p.subScale;
      if (p.metrics) {
        el.metricsToggle.checked = true;
        el.metricsHud.hidden = false;
      }
      // 翻譯設定會保留，但模型「不」在載入頁面時下載 —— 等第一次真的需要翻時才抓（114 MB）
      if (p.mtEnabled) {
        mt.enabled = true;
        el.mtToggle.checked = true;
      }
      state.ui = (p.ui === 'zh' || p.ui === 'en')
        ? p.ui
        : ((navigator.language || '').startsWith('zh') ? 'zh' : 'en');
    } catch {}
  }

  function syncVoskSourceRows() {
    const source = el.voskSource.value;
    el.voskBuiltinRow.hidden = source !== 'builtin';
    el.voskFileRow.hidden = source !== 'file';
    el.voskUrlRow.hidden = source !== 'url';
  }

  el.engine.onchange = updateEngine;
  el.engineCards.addEventListener('click', e => {
    const card = e.target.closest('.engine-card');
    if (!card || card.disabled) return;
    el.engine.value = card.dataset.engine;
    updateEngine();
  });
  el.lang.onchange = () => {
    prefetchOpencc();       // 切到中文（或切離）時順手預抓
    save();
  };
  el.vad.onchange = save;
  el.sherpaBase.onchange = () => {
    save();
    syncModelButtons();
  };
  // 運算位置會影響狀態卡的「執行環境」，切換時要一起更新
  el.mossSpace.onchange = updateEngine;
  el.whisperModel.onchange = () => {
    el.whisperStatus.textContent = t().modelChanged;
    el.whisperStatus.className = 'model-status';
    save();
    syncModelButtons();
  };
  el.voskLang.onchange = () => {
    vosk.loaded = false;
    el.voskStatus.textContent = t().modelChanged;
    el.voskStatus.className = 'model-status';
    syncModelButtons();
  };
  el.voskSource.onchange = () => {
    vosk.loaded = false;
    el.voskStatus.textContent = t().sourceChanged;
    el.voskStatus.className = 'model-status';
    syncVoskSourceRows();
    syncModelButtons();
    save();   // save() 有存 voskSource，但少了這行就只有「之後又改了別的設定」時才會寫進去
  };
  el.control.onclick = toggle;
  el.loadVosk.onclick = loadVosk;
  el.loadSherpa.onclick = loadSherpa;
  el.clearSherpaCache.onclick = clearSherpaCache;
  el.loadWhisper.onclick = loadWhisper;
  el.loadWhistle.onclick = () => whistleEngine.load();
  el.clearWhistleCache.onclick = () => whistleEngine.clearCache();
  el.loadUnderdog.onclick = () => underdogEngine.load();
  el.clearUnderdogCache.onclick = () => underdogEngine.clearCache();
  el.underdogBase.onchange = () => {
    if (underdogEngine.state().loaded && underdogEngine.state().base !== underdogEngine.baseResolved()) {
      el.underdogStatus.textContent = t().sourceChanged;
      el.underdogStatus.className = 'model-status';
    }
    save();
    syncModelButtons();
  };
  el.underdogVariant.onchange = () => {
    if (underdogEngine.state().loaded && underdogEngine.state().variant !== el.underdogVariant.value) {
      el.underdogStatus.textContent = t().modelChanged;
      el.underdogStatus.className = 'model-status';
    }
    save();
    syncModelButtons();
  };
  el.mtToggle.onchange = () => setMtEnabled(el.mtToggle.checked);
  el.mtScript.onchange = () => {
    mt.script = el.mtScript.value;
    // 換譯文體裁要重翻：快取裡的譯文是另一種字形的，直接清掉最省事
    mt.cache.clear();
    for (const segment of state.segments) delete segment.zh;
    persistTranscript();
    renderTranscript(true);
    for (const segment of state.segments) queueTranslation(segment);
    renderSubtitles();
    save();
  };
  el.mtModel.onchange = () => {
    const model = el.mtModel.value.trim() || MT_DEFAULT_MODEL;
    if (model === mt.model) return;
    mt.model = model;
    mt.loadedModel = null;
    mt.cache.clear();
    if (mt.enabled) void ensureMtLoaded().catch(error => {
      el.mtStatus.textContent = t().mtFailed + (error.message || error);
      el.mtStatus.className = 'model-status error';
    });
    save();
  };
  el.subScale.onchange = () => applySubScale(el.subScale.value);
  el.pipBtn.onclick = openSubtitleWindow;
  el.metricsToggle.onchange = () => {
    el.metricsHud.hidden = !el.metricsToggle.checked;
    if (!el.metricsHud.hidden) renderMetricsHud();
    save();
  };
  el.whistleUrl.onchange = () => {
    // 換模型網址等於換模型：只更新按鈕狀態，實際重新載入由「載入模型」按鈕負責
    if (whistleEngine.isReady() === false && whistleEngine.currentUrl() !== el.whistleUrl.value.trim()) {
      el.whistleStatus.textContent = t().sourceChanged;
      el.whistleStatus.className = 'model-status';
    }
    save();
    syncModelButtons();
  };
  el.mossRun.onclick = () => (moss.running ? cancelMoss() : runMoss());  el.mossSrt.onclick = exportMossSrt;
  el.mossFile.addEventListener('change', () => {
    updateMossFileText();
    resetMossResult();
  });
  el.mossFileZone.addEventListener('dragover', e => {
    e.preventDefault();
    el.mossFileZone.classList.add('over');
  });
  el.mossFileZone.addEventListener('dragleave', () => el.mossFileZone.classList.remove('over'));
  el.mossFileZone.addEventListener('drop', e => {
    e.preventDefault();
    el.mossFileZone.classList.remove('over');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (moss.running) return;
    if (/^(audio|video)\//.test(file.type) || /\.(mp3|wav|m4a|aac|ogg|flac|opus|mp4|mov|mkv|webm|amr|wma)$/i.test(file.name)) {
      const dt = new DataTransfer();
      dt.items.add(file);
      el.mossFile.files = dt.files;
      updateMossFileText();
      resetMossResult();
    } else {
      showToast(t().mossPickFile);
    }
  });
  el.toggle.onclick = () => setUi(state.ui === 'zh' ? 'en' : 'zh');

  el.clear.onclick = () => {
    if (state.running || state.stopping || whisperEngine.isBusy() || moss.running) return showToast(t().busyClear);
    // 逐字稿現在會被保存，清空等於真的刪掉整場會議 —— 有內容時先確認
    if (effectiveSegmentCount() && !confirm(t().confirmClear)) return;

    clearWebRestartTimer();
    clearWebErrorTimer();
    removeVoskRecognizer();
    state.segments = [];
    state.interim = '';
    state.start = null;
    state.manualStop = false;
    state.webRecognitionActive = false;
    whisperEngine.reset();
    underdogEngine.reset();
    moss.segments = [];
    el.mossSrt.disabled = true;
    persistTranscript(true);

    el.placeholder.textContent = t().placeholder;
    setLevel(0);
    render();
    requestAnimationFrame(() => { el.container.scrollTop = 0; });
    updateButtons();
  };

  el.copy.onclick = async () => {
    const transcriptText = getEffectiveTranscriptText('\n');
    if (!transcriptText) return showToast(t().nothingToCopy);
    try {
      await navigator.clipboard.writeText(transcriptText);
      showToast(t().copied);
    } catch (error) {
      console.error('Clipboard write failed:', error);
      showToast(t().copyFailed);
    }
  };

  el.export.onclick = () => {
    const transcriptText = getEffectiveTranscriptText('\r\n');
    if (!transcriptText) return showToast(t().nothingToExport);

    const blob = new Blob(['﻿' + transcriptText], { type: 'text/plain;charset=utf-8' });
    const anchor = document.createElement('a');
    const startedAt = state.start || new Date();
    const objectUrl = URL.createObjectURL(blob);

    anchor.href = objectUrl;
    anchor.download = `transcript_${startedAt.toISOString().slice(0, 10)}_${stamp(startedAt).slice(1, -1).replaceAll(':', '-')}.txt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
  };

  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      toggle();
    }
  });

  // 切到背景／關頁前立刻寫一次（節流中的那一秒不能丟）；回到前景時補回 wake lock
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistTranscript(true);
    else void syncWakeLock();
  });
  window.addEventListener('pagehide', () => persistTranscript(true));

  window.addEventListener('beforeunload', event => {
    // MOSS 是批次上傳／轉寫，跑掉就得整份重來，所以也要擋
    if (state.running || moss.running) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  load();
  const restoredCount = restoreSavedTranscript();
  syncVoskSourceRows();
  initWebSpeech();
  setUi(state.ui);
  // 翻譯層的初始化：只把設定接上，模型等真的要翻再下載（114 MB 不該在開頁時就抓）
  mt.model = el.mtModel.value.trim() || MT_DEFAULT_MODEL;
  mt.script = el.mtScript.value;
  applySubScale(el.subScale.value);
  if (mt.enabled) {
    el.mtStatus.textContent = t().mtPending;
    el.subtitleBar.hidden = false;
  }
  render();
  if (restoredCount) showToast(`${t().transcriptRestored}（${restoredCount}）`);

// ?debug=storage：儲存空間診斷（配額、OPFS 可寫性、各 cache 佔用）。
// 這頁存在的理由：OPFS 那次事故「配額不足 → 靜靜退回 → 每次重抓 431.9 MB」，
// 畫面上完全看不出來。與其用載入時間猜，不如出國前打開這頁看一眼。
{
  const debug = new URLSearchParams(location.search).get('debug') || '';
  if (debug.split(',').includes('storage')) {
    void (async () => {
      const report = await collectStorageReport({
        opfs: (await opfsAvailable()) ? opfsStore : null,
      });
      window.__storageReport = report;
      renderStorageReport(report, {
        title: t().storageDebugTitle,
        close: t().storageDebugClose,
        copy: t().storageDebugCopy,
        quota: t().storageQuota,
        usage: t().storageUsage,
        available: t().storageAvailable,
        persisted: t().storagePersisted,
        opfs: t().storageOpfs,
        models: t().storageModels,
        caches: t().storageCaches,
        none: t().storageNone,
      });
    })();
  }
}
