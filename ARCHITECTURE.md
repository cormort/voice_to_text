# 架構：從「轉錄工具」改成「即時理解輔助」

這份文件是重構的規格書。它記錄**為什麼**要改、改成什麼、以及每一階段的驗收條件。
程式碼可以慢慢跟上，但判斷「該不該加這個功能」的標準只看這裡。

原文（2026-10 之前的版本）解決的是「把語音變成文字」；真正要解決的問題是
**在國外聽演講時聽力跟不上，需要靠文字即時抓到對方在說什麼**。兩者的取捨完全不同：

| | 轉錄工具 | 即時理解輔助 |
| --- | --- | --- |
| 首要指標 | 準確度（WER） | **端到端延遲**（mic → 螢幕） |
| 語言 | 越多越好 | **雙語並行**（中文是主線，原文是佐證） |
| 網路 | 有網路就好 | **出發前下載完，會場可離線** |
| 使用長度 | 單次幾分鐘 | 連續 45–90 分鐘 × 多天 |
| 眼睛在哪 | 這個分頁 | **投影片上**（浮動字幕窗） |

## 一、四個不變的決定

### 1. Live 層與 Refine 層分開（同音訊、兩次過）

串流模型不夠準、準的模型不串流，這件事不會因為換模型消失。

```
麥克風 → AudioWorklet(16 kHz) → VAD 分段
    ├─ Live：sherpa-onnx 串流（真串流）→ 英文 partial 立刻上字幕
    │                                   → 句子結束 → 翻譯 → 中文行
    └─ Refine：會後整段重跑（Whisper / Underdog Bark 3.0）
                → 最終雙語逐字稿、SRT、名詞校正
```

判準：**RTF ≥ 1 的模型不准進 Live 路徑**。Underdog Bark 3.0 實測 RTF ≈ 1.2
（見 [MODELS.md](MODELS.md)），它的位置是 Refine，不是即時。

### 2. 翻譯只翻「已結束的句子」

半句去翻會讓中文一行跳三次，閱讀體驗比延遲更糟。英文 partial 先頂著，句子
endpoint 後才翻。實務代價只有 0.5–1 秒。

### 3. 模型下載是「出發前的事」，不是「用到才下載」

- 模型清單（manifest）驅動，可一鍵「全部下載」。
- 大權重放 **OPFS**（可分段寫、可續傳、可校驗），不放 Cache Storage。
- UI 永遠顯示「這個引擎要多少 MB」，並且在離線時明確說「已就緒／未下載」。

### 4. 延遲要能被量到，否則不算做完

每個引擎、每次提交都記錄 `capture → commit` 的延遲與 RTF，HUD 可開可關，
`window.__sttMetrics` 供自動化測試讀取（見 §3）。

## 二、延遲預算

| 階段 | 預算 | 現況（2026-10 實測） |
| --- | --- | --- |
| 擷取 + worklet | 100–200 ms | 已達成 |
| VAD endpoint | 300–600 ms | RMS 閾值法，會場遠場偏脆 |
| ASR lookahead（串流） | 320–640 ms | sherpa 已達成 |
| UI commit | < 50 ms | 已達成（增量渲染） |
| 翻譯（句子級） | ≤ 800 ms | **opus-mt-en-zh q8：220–562 ms／句（WASM）** |
| 合計（英文 partial） | < 1.2 s | 待 HUD 量測 |
| 合計（中文行） | < 2.0 s | 待 HUD 量測 |

## 三、Phase 0：量測（HUD）

新增 `sttMetrics`（`index.html` 內的小模組）：

- `recordSubmit(engine, audioSeconds)` → 回傳一個 `job` 物件
- `recordCommit(job, text)` → 記一筆「處理延遲」與「輸出字元/秒」，算 RTF
- `recordLongTask(ms)`（`PerformanceObserver('longtask')`）
- `snapshot()` → `{ engine, count, latency: {last, avg, p95}, rtf, longTasks: {count, max}, charsPerSec }`

UI：設定區一個「顯示量測」開關（存 localStorage），開啟後右下角出現小卡：
`處理延遲 1.8 s（p95 2.6）｜RTF 1.19｜長工作 0`。**預設關閉**，不干擾閱讀。

驗收：跑一次真引擎（假麥克風 + 官方 fixture 音訊），HUD 有數字且與 `MODELS.md` 的
實測值同一個量級。

**狀態：已完成（2026-10）。** 實測（Whisper tiny / WebGPU、假麥克風餵英文 fixture，
15 秒分段）：處理延遲 2.73 s、RTF 0.18、long task 0（max 0 ms），HUD 顯示
`處理延遲 2.73s（平均 2.73s／p95 2.73s）／RTF 0.18／long task 0`。
批次引擎（Whisper／Whistle／Underdog）都掛了量測；sherpa 是串流，語意不同，暫不計入。

## 四、Phase 1：雙語字幕

### 元件

- `mt-worker.js`（module worker）
  - `load`：`transformers.js@3.8.1` + `pipeline('translation', modelId)`，`device:'wasm'`、`dtype:'q8'`
  - `translate`：句子進、句子出；同一句有快取（正規化後當 key）
  - 進度與失敗都回報（模型 114 MB，首次載入 7.8 s 實測）
- 主執行緒
  - `commit(text)` 之後，若「翻譯開啟」且該句是拉丁字母為主 → 送 MT，回來的譯文附加在
    segment 上（`segment.zh`），不動原文
  - 中文輸出經既有的 OpenCC 轉繁（MT 輸出是簡體）；使用者選「簡體」時跳過
  - 翻譯失敗 → 只顯示原文 + 一次性 toast，不擋辨識

### 顯示

三種模式，同一個資料來源（最近 N 句）：

| 模式 | 用途 |
| --- | --- |
| 逐字稿（預設） | 現在的整份逐字稿 |
| 雙語字幕條 | 固定在頁面底部，兩行：譯文大字、原文小字，只留最近 2 句 |
| 浮動字幕窗（Document PiP） | 浮在投影片上，always-on-top，可拖可縮 |

PiP 不支援時（Safari／舊 Chrome）退回「雙語字幕條」並提示一次。

### 為什麼是 opus-mt-en-zh

已實測（`Xenova/opus-mt-en-zh`，q8，WASM）：encoder 50.4 MB + decoder 57.4 MB +
tokenizer 6.1 MB ≈ **114 MB**，載入 7.8 s，每句 220–562 ms。品質**明顯不足於術語**
（"state space model" → 「国家空间模型」、"ablation study" → 「通热研究」），
定位是「看得懂大意」，不是「可引用的翻譯」。模型 id 可在面板更換
（例如 `Xenova/nllb-200-distilled-600M` 品質較好但約 600 MB，尚未實測）。

**狀態：已完成（2026-10）。** 端到端驗收（Whisper tiny + 假麥克風餵英文 fixture）：
字幕條同時出現中文與原文（`棕狐從懶狗上跳過` ／ `The quick brown fox jumps over the lazy dog`），
逐字稿多一行 `↳ 譯文`，`__sttMetrics` 有延遲與 RTF。踩到的兩個坑：

1. **transformers.js 4.x 跑不動這顆模型**：merged decoder 會炸
   `TransposeDQWeightsForMatMulNBits Missing required scale`（q8/fp16/q4 都一樣）。
   MT worker 因此固定在 **3.8.1**，與 Whisper 用的 4.2.0 併存（不同 worker，互不干擾）。
2. **Document PiP 需要真實使用者手勢**：程式呼叫 `click()` 沒有 transient activation，
   `requestWindow()` 直接丟 `NotAllowedError`；用真的滑鼠事件才會成功。
   headless 沒有視窗管理員，因此「浮動視窗長什麼樣」還沒有人工確認過 —— 只驗到
   請求成功、失敗時的退路（toast）正常、主視窗字幕條會被收起。

## 五、還沒做（Phase 2／3）

### Phase 2：`AsrEngine` 介面與 Live/Refine 分流

```ts
interface AsrEngine {
  readonly id: string;
  readonly role: 'live' | 'refine' | 'fallback';
  load(opts: { manifest: ModelManifest }): Promise<void>;
  start(opts: { language: string; hotwords?: string[] }): Promise<AsrStream>;
}
interface AsrStream extends AsyncIterable<Hypothesis> {  // partial | final | error
  stop(): Promise<void>;
}
```

收斂後 `index.html` 不該再出現 `if (engine === 'whistle')` 這種分支（目前 400+ 行），
而 `whisper`／`whistle`／`underdog` 三條批次管線應該共用同一個
`makeBatchPipeline({ transcribe, maxQueued, onText })`。

### Phase 3：外殼重寫

Vite + TypeScript + Svelte、OPFS 模型管理、IndexedDB session 儲存、
Playwright 假麥克風 e2e（現在只有本機手動腳本）。

**判準**：Phase 1 之後如果出國開會就夠用，Phase 3 可以永遠不做。

**已先做的一半（2026-10）**：不再堅持單檔 HTML —— 主程式搬到 `src/app.js`，
`i18n`／`util`／`vad` 抽成獨立模組，`index.html` 只剩版面（204 KB → 30 KB）。
沒有引入建置步驟（瀏覽器直接載 ES module），因為 GitHub Pages 是靜態託管，
多一層 bundle 只換到 TypeScript，代價是每次改動都要 build + 驗證產物。
`test_modules.js` 會擋住「邏輯又長回 index.html」。

## 六、明確不做

- **Web Speech 不當主力**：延遲與隱私都不確定，只留作 fallback。
- **引擎不再「等權並列」**：每個引擎有角色（live／refine／fallback），使用者不必在會議前選模型。
- **不用 VAD 分段硬套非串流模型做即時**：這是 Underdog 接線時最勉強的一段。
- **不在 Cache Storage 存大權重**：改用 OPFS（現況 900 MB 峰值就是這樣來的）。
