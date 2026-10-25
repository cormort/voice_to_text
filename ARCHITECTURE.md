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

**狀態：批次引擎已完成（2026-10）** —— `src/engines/batch.js` 提供 `createBatchPipeline(ctx, spec)`，
Whisper／Whistle／Underdog 三個引擎只填「可不可以開始、要帶什麼參數、怎麼推論、失敗怎麼講」，
排隊、回壓、session 隔離、啟停、收尾、量測都只有一份。介面固定為

```js
{ id, role, engineName, runtime, start(), stop(), enqueue(audio),
  drain(), drainAll(), isBusy(), reset() }
```

`ENGINES` 變成註冊表：批次引擎直接放 pipeline 物件，其餘（vosk／sherpa／webspeech／moss）
先包成 `{ role, start, stop }`。`test_engines.js` 守住三件事：註冊表每一項都有 role、
`drainPromise` 只准出現在 pipeline 裡、回壓與 session 隔離的行為（用假引擎實際跑一次）。

**還沒做**：把模型載入碼也搬進 `src/engines/*.js`（目前仍在 `app.js`，因為它大量讀寫
`el.*` 進度條與狀態文字）；sherpa／vosk 要收斂成同一介面，得先讓它們的串流結果走
`AsyncIterable<Hypothesis>`，那是下一階段。

**串流引擎也收斂了（2026-10）** —— `src/engines/live.js` 的 `createLiveEngine(ctx, spec)`
給串流引擎同一個外殼：

```js
{ id, role, runtime, start(), stop(), isBusy(), reset() }
// spec.attach({ emit, isActive, getContext }) → { push(chunk), flush?() }
// emit({ type: 'partial' | 'final' | 'error', text })
```

於是 Vosk（recognizer 事件）與 sherpa（Worker／主執行緒兩種模式）只剩「怎麼餵、怎麼收尾」
的差異；partial→interim、final→commit、換場就不再寫入，這三件事只有一份實作。
sherpa 的一次解碼迴圈另外抽成 `src/engines/sherpa-decode.js`，`test_sherpa_decode.js`
因此從「刮 HTML 原始碼」改成載入真正的模組。

實測（假麥克風餵英文 fixture，桌機 Chrome）：

| 引擎 | 結果 |
| --- | --- |
| Vosk（en 內建模型 42 MB） | 逐字稿 `the quick brown fox jumps over the lazy dog…`，停止後正常收尾 |
| sherpa（HF 199 MB，Worker 模式） | 逐字流式輸出、endpoint 分段 commit，停止時 flush 出最後一句 |

**下載樣板也收斂了（2026-10）**：`src/download.js` 把 `fetchRange`／`downloadInChunks`／
`streamWhole`／`formatProgress` 收成一支 —— sherpa 的 189.8 MB、Whistle 的 16.9 MB、
Underdog 的 431.9 MB 外部權重都走同一套「分段 + 逐段重試 + 進度」。這同時是 Phase 3
換 OPFS 續傳時唯一要改的地方，也讓 `test_sherpa_download.js` 從「刮原始碼」改成 import 真模組。

**模型載入碼開始搬進引擎模組（2026-10）**：Whistle 已經搬完 ——
`src/engines/whistle.js` 的 `createWhistleEngine(ctx)` 自己負責下載（Cache Storage）、
worker 膠水、主執行緒退路、清除快取與推論，回傳的物件沿用 batch pipeline 的介面再加上
`load()` / `clearCache()` / `isReady()` / `currentUrl()`。app.js 只剩 UI 接線
（按鈕 onclick、`syncModelButtons` 用 `isReady()`）。

Underdog 也搬完了（同一個 recipe）：`src/engines/underdog.js` 自己管 431 MB 權重的下載、
worker 膠水與進度回報，實測載入 27 s、轉寫正常、停止正常。剩下 Whisper。

同一份 recipe 要用在 Whisper 上：把常數、worker 變數、load／clear／transcribe
一起剪進模組，模組內建 pipeline，回傳時多掛 load／clearCache／isReady。實測（真模型、假麥克風）：
Whistle 16.9 MB 模型載入 → 轉寫 → 停止都正常。

**這裡踩到的坑（值得記）**：`makeAudioBuffer` 從 app.js 搬進 `src/util.js` 時漏了模組層的
`SAMPLE_RATE`，瀏覽器直接 `ReferenceError` —— 但呼叫端的 `try/catch` 只印一行 warn，
表現是「有在收音、字幕永遠不出來」。修法除了補常數，還加了 `test_util.js` 直接呼叫它
（用假 AudioContext），讓這類「只有真的跑才會炸」的錯在 CI 就紅。

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

## 七、儲存空間診斷（`?debug=storage`）

`src/storage-debug.js`：配額／已用（`navigator.storage.estimate()`）、是否已申請持久化、
**真的寫 1 MiB 進 OPFS 再讀回比對**（寫得進去不代表寫對了）、每個 Cache Storage 的筆數與位元組。
卡片可複製 JSON，報告同時掛在 `window.__storageReport` 供自動化讀取。

存在的理由：OPFS 那次事故是「配額不足 → 靜靜退回 → 每次重抓 431.9 MB」，畫面上完全看不出來。
與其用載入時間猜，不如出國前打開這頁看一眼。

**實機量測（headless Chrome，2026-10）**：配額 10.00 GB、已用 0、OPFS 可寫 1 MiB／66 ms、cache 空。

**這推翻了「OPFS 配額不足」的假設** —— headless profile 的 OPFS 是寫得進去的。所以 431.9 MB
那次變慢（97.9 s）另有原因，待查兩個方向：

1. worker 內 `opfsAvailable()` 與 Range probe 是否其實失敗了（失敗只送到 console，UI 看不到）；
2. 432 MB 用大量 append 寫入的實際速度，以及「中斷後檔案大小是否如預期可見」——
   若 `store.size()` 回 0，續傳邏輯每次都會從頭寫。

要重接之前，先把這兩點接上 UI 告警，再在真機量「首次／中斷／續傳／第二次載入」四個數字。

### 接回去的結果（2026-10，`?opfs=1`）

上次接 OPFS 只看到「變慢 97.9 s」，查不出原因。這次先做護欄再接，**警告歷史立刻指出真正的 bug**：

```
underdog/opfs: undefined：Error：續傳後的檔案不完整，請重新下載
OPFS-FILES ["undefined:66.7MB"]
```

`fetchBytes(url, cache, onProgress, label)` 有些呼叫端只傳三個參數，`label` 變 undefined，
五個檔案全寫進同一個 key（`underdog/undefined`），所以每次都判定「續傳後不完整」→ 退回 Cache Storage
→ 下次又重抓 431.9 MB。

補上 `label = label || url 的檔名` 之後（真 431.9 MB 實測）：

| 項目 | 結果 |
| --- | --- |
| OPFS 檔案 | 431.9／66.7／1.2／1.1／0.0 MB，五個都正確 |
| 警告 | 空 |
| 第一次載入 | **102 s**（原本 Cache Storage 27 s） |
| 第二次載入（OPFS 命中） | **5.1 s**（原本 3.0 s） |

**首次載入的回歸（27 → 102 s）不能直接上線**，所以預設仍走 Cache Storage，`?opfs=1` 才啟用續傳。
要預設開之前先做兩件事：

1. 分段大小 8 MB → 32 MB（或整段一次寫），把 54 次 OPFS 交易降下來
2. 不要「寫完再從頭組一份 432 MB 的 Uint8Array」——直接讀回 OPFS 那一次就夠

**review 後補的三個修正（2026-10）**：

- **預設路徑不再記假警告**：`?opfs=1` 沒開時，每個檔案都會記一筆「此環境沒有 OPFS」（`else` 掛錯了 if），現在只有「要求了 OPFS 卻拿不到」才記。
- **key 帶網址雜湊、來源帶 ETag**：OPFS key 從 `underdog/<檔名>` 改成 `underdog/<網址雜湊>-<檔名>`，旁邊存一份 `.meta`（網址、總大小、ETag）。
  已寫入的前段只有三項都一致才續傳；HF 換了檔或換了資產位置就從 0 重抓（`restarted`），不會拼出新舊混雜的壞檔。
  HF 的 206 回應有 `ETag`，CORS 也開放讀取（小檔與 CDN 上的大檔都實測過）。舊格式的 key 載入時會順手刪掉。
- **寫入改用 `createSyncAccessHandle`（worker 內）**：每段寫完就 `flush`，位元組直接落在檔案裡。
  `createWritable` 要等 `close()` 才把暫存檔換上去，所以**關頁、當掉時這一輪寫的全部消失**，宣稱的續傳其實只對「網路錯誤」有效。
  實測（真 HF 檔案、128 KB 分段）：寫到 512 KB 時直接 `terminate()` worker，OPFS 裡留下 524,288 bytes；
  新 worker 從 524,288 續傳，結果與直接下載逐位元組相同；手動改壞 `.meta` 的 ETag 後會從 0 重抓。
  432 MB 首次載入的時間還沒重測 —— 少了 `close()` 時的整份搬移，預期會比 102 s 快，但上面兩個待辦仍然要做。

## 八、跨來源隔離：Underdog 多執行緒（2026-10）

多執行緒 WASM 需要 `SharedArrayBuffer`，而它只在頁面 `crossOriginIsolated` 時存在，也就是要帶
COOP／COEP 標頭。GitHub Pages 不能設標頭，所以改由 **sw.js 在所有同源回應上補**：

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless` —— 不用 `require-corp`：HF、jsDelivr、GA 都沒有
  CORP 標頭，`require-corp` 會把它們全擋掉；`credentialless` 只是讓跨來源 no-cors 請求不帶 cookie。
- 第一次造訪時頁面還沒被 SW 控制，拿不到標頭 → SW 接手後重整一次。只限「載入時沒有 controller」，
  SW 更新時不重整（錄音中不能被打斷）。
- Safari 不認得 `credentialless`，等於沒有 COEP：頁面照常，Underdog 維持 1 執行緒。

`underdog-worker.js` 的 `pickThreads`：隔離時 `min(4, hardwareConcurrency)`，否則 1；`?threads=N` 可覆蓋（量測用）。

實測（桌機 Chrome、6 核、JFK 11 秒英文、q4f16、暖機一次後取三次）：

| | 轉寫 11 秒音訊 | RTF |
| --- | --- | --- |
| 1 執行緒（改前） | 9.3–10.2 s | 0.85–0.93 |
| 4 執行緒（隔離後自動選） | 3.1–4.3 s | **0.28–0.39** |

兩者逐字稿完全相同。Underdog 從「比即時慢」變成「追得上即時」，§一的判準（RTF ≥ 1 不准進 Live）
在桌機上不再擋它；手機核心少、會降頻，要另外量。

隔離後確認過：Vosk（jsDelivr classic script＋SRI）、transformers.js（jsDelivr ESM）、GA 都照常載入，
console 沒有錯誤。**浮動字幕窗（Document PiP）沒驗到**：測試用的內建瀏覽器本來就開不了 PiP 視窗
（未隔離的線上版同樣失敗），要在真的 Chrome 裡確認一次。

### 跨來源隔離的兩個限制（2026-10）

- **Safari 忽略 `credentialless`**：不會進入 cross-origin isolated，因此永遠單執行緒。
  功能正常、只是慢 2–3 倍（RTF 0.85 而非 0.3），不要當成壞掉。
- **首次載入多一次重整**：第一次造訪時頁面還沒被 Service Worker 接管，拿不到 COOP/COEP，
  所以會自動重整一次；只在「載入時沒有 controller」時發生，之後的 SW 更新不會打斷錄音。
- **執行緒數寫進狀態列**（`模型已就緒（WASM / CPU ×4，…）`）與 `?debug=storage`
  （`跨來源隔離｜執行緒 4／核心 6`）：隔離失效時畫面不會報錯、只會變慢，所以必須看得見。
- **PiP 尚未人工驗證**：headless Chrome 與 in-app browser 都打不開浮動視窗
  （需要真實使用者手勢），只能在實機 Chrome 按一次「浮動字幕窗」確認。

### 跨來源隔離的三個限制（2026-10）

- **Safari 忽略 `credentialless`**：不會進入 cross-origin isolated，因此永遠單執行緒。功能正常、只是慢 2–3 倍（RTF 0.85 而非 0.3），不要當成壞掉。
- **首次載入多一次重整**：第一次造訪時頁面還沒被 Service Worker 接管，拿不到 COOP/COEP，所以自動重整一次；只在「載入時沒有 controller」時發生，之後的 SW 更新不會打斷錄音。
- **執行緒數要看得見**：狀態列 `模型已就緒（WASM / CPU ×4，…）`、`?debug=storage` 的 `跨來源隔離｜執行緒 4／核心 6`。隔離失效時畫面不會報錯、只會變慢，所以必須有數字。
- **PiP 尚未人工驗證**：headless Chrome 與 in-app browser 都打不開浮動視窗（需要真實使用者手勢），只能在實機 Chrome 按一次「浮動字幕窗」確認。
