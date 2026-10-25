# 多國語言即時逐字稿工具

瀏覽器端的語音轉文字工具，提供**七種辨識引擎**（Web Speech、Vosk、sherpa-onnx、Whisper、Whistle、Underdog Bark 3.0、MOSS 會議轉寫）：可即時語音辨識、批次轉寫音檔／影片，並一鍵輸出標準 SRT 字幕。

## 特色

- **七種辨識引擎**：雲端 Web Speech 與 MOSS、本機 Vosk / sherpa-onnx / Whisper / Whistle / Underdog Bark 3.0（WASM / WebGPU），引擎卡片式選擇器標明隱私等級（🔒 本機／☁️ 雲端）並附快速開始引導
- **雙語字幕（本機翻譯）**：翻譯在瀏覽器內跑（transformers.js + `Xenova/opus-mt-en-zh`，約 114 MB），字幕條「譯文大字、原文小字」只留最近兩句，可拉成 Document PiP 浮動視窗浮在投影片上
- **量測 HUD**：處理延遲（last／avg／p95）、RTF、long task，`window.__sttMetrics` 供自動化讀取；預設關閉
- **即時語音辨識**：多語言即時轉文字，搭配音量偵測即時回饋；空白鍵快速開始／停止
- **MOSS 會議轉寫**：拖放音訊／影片檔上傳，自動轉寫並標示說話人（S01、S02…），可一鍵匯出標準 `.srt` 字幕
- **繁體中文輸出**：辨識結果自動簡轉繁（opencc-js）
- **多語言介面**：中文／英文一鍵切換
- **匯出／複製／清空**：逐字稿可複製或匯出 .txt；MOSS 結果可輸出 .srt
- **增量渲染**：長會議逐字稿只增量更新畫面，不整份重建
- **PWA**：可安裝到桌面／主畫面，外殼離線快取（模型檔仍需網路下載），圖示含 maskable 版本

### 為什麼是「理解輔助」而不是「轉錄工具」

這個專案的起點是「出國開會聽力跟不上、需要靠文字抓對話」。因此取捨與一般轉錄工具不同：
**延遲優先於準確度、雙語優先於單語、離線可用優先於雲端品質**。完整的設計理由、
延遲預算、Live／Refine 兩段式架構與後續階段，見 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 效能量測

```sh
node test_speech_perf.js                                        # 量 Vosk 與 Whisper
PERF_ENGINES=vosk,sherpa,whisper,webspeech,moss node test_speech_perf.js
PERF_MAX_BLOCK_MS=200 node test_speech_perf.js                  # 當 CI 門檻
```

把 `say` 產生的中文語音餵進 Chromium 的假麥克風，量每個引擎**阻塞主執行緒多久**
（`PerformanceObserver('longtask')`）。這支量到的關鍵數字：Whisper 在 WASM 後端、Worker 化
之前，單一 chunk 阻塞 **12,295 ms**（占 25 秒串流的 49.6%）；Worker 化之後為 **0 ms**。
模型下載量、來源與後續路線見 [MODELS.md](MODELS.md)。

## Worker 退路測試

```sh
node test_worker_fallback.js
```

Worker 化之後出現過兩個同型 bug，都是「**Worker 掛掉時的處理**」不完整 —— 正常操作下永遠
看不到，所以這支測試刻意模擬：

- **Whisper**：worker 回報載入失敗（例如 worker 內的 CDN import 被擋）→ 必須**退回主執行緒**
  並仍能載入；少了這層退路，這些情況會直接判整個引擎死亡。
- **sherpa**：worker 崩潰（載入中／**載入成功之後**）→ UI 不可謊報「已載入」、載入鈕必須恢復
  可用，且要退回主執行緒。

判斷「有沒有退回主執行緒」用請求的 `resourceType`：worker 路徑用 `fetch` 抓膠水層，
主執行緒路徑用 `<script>` 載入。為了不真的下載 190 MB，sherpa 的案例會先在 Cache Storage
種一份假的 `.data`。

> 對照修正前的版本（`git worktree add /tmp/x 9715e64`）跑同一支測試會紅 4 項，可用來確認
> 這支測試真的有牙齒 —— 不是只有「會過」。

## 引擎列表

| 引擎 | 處理位置 | 用途 |
| ---- | ------- | ---- |
| Web Speech | ☁️ 雲端 | 即時語音辨識 |
| Vosk | 🔒 本機 | 即時辨識（WASM，支援上傳自訂模型） |
| sherpa-onnx | 🔒 本機 | 即時串流辨識（WASM） |
| Whisper | 🔒 本機 | 即時辨識（WebGPU，WASM 退路；tiny/base/small 模型） |
| Whistle | 🔒 本機 | 即時辨識（WASM，16.9 MB 輕量模型；英德法西義荷波） |
| Underdog Bark 3.0 | 🔒 本機 | 英文高準確度（WASM，約 500 MB；比即時慢，RTF ≈ 1.2） |
| MOSS-Transcribe-Diarize | ☁️ 雲端批次 | 音訊／影片批次轉寫＋說話人分離＋SRT 匯出 |

## 支援語言

- English (US/UK)
- 中文 (台灣/中國大陸)
- 粵語 (香港)
- 日本語
- 한국어
- Español
- Français
- Deutsch

> ⚠️ **Whistle 只支援英、德、法、西、義、荷、波七種語言，沒有中文、日文、韓文。**
> **Underdog Bark 3.0 只有英文**（它是 NVIDIA parakeet-tdt-0.6b-v3 的英文微調）。
> 需要中文即時字幕請選 sherpa-onnx，需要中文批次高準確度請選 Whisper 或 MOSS。

## 使用說明

1. 選擇辨識引擎（引擎卡片或下拉選單）；本機引擎首次使用會下載模型
2. 即時引擎：允許瀏覽器存取麥克風 → 點「開始辨識」→ 說話後文字即時顯示 → 「停止辨識」→ 複製或匯出
3. MOSS：拖放或點選音訊／影片檔 → 點「批次轉寫」→ 完成後輸出 SRT 字幕

## 儲存空間診斷

網址加 **?debug=storage** 會顯示配額／已用、OPFS 實際可寫測試（寫 1 MiB 再讀回比對）、以及每個 Cache Storage 的佔用。出國前按一次，比看載入時間猜可靠。

## 專案結構

2026-10 之前所有程式都在 `index.html` 裡（單檔約 204 KB）。現在拆成：

```
index.html          版面與 CSS（約 30 KB）＋兩個小段 inline script（GA、SW 註冊）
src/app.js          接線：狀態、DOM、引擎載入、辨識流程、雙語字幕
src/engines/batch.js 批次引擎的共用生命週期（排隊／回壓／啟停／收尾／量測）
src/engines/live.js 串流引擎的共用生命週期（Vosk／sherpa 的啟停、字幕套用）
src/engines/sherpa-decode.js sherpa 一次解碼迴圈（partial／endpoint／reset，可單獨測）
src/engines/whistle.js Whistle：模型下載、worker 膠水、推論（含清除快取）
src/engines/underdog.js Underdog：431 MB 權重下載、worker 膠水、推論
src/i18n.js         中英文案（純資料）
src/download.js     大檔下載：Range 分段、逐段重試、不支援 Range 的退路、進度文字
src/opfs.js         OPFS 可續傳下載（分段寫入＋斷點續傳；尚未接到引擎，見 ARCHITECTURE）
src/util.js         純函式：stamp / concat / resample / makeAudioBuffer / isLatinDominated
src/vad.js          停頓分段：vadPush / vadFlush
underdog-worker.js  Underdog Bark 3.0 的推論 worker（＋ underdog/{frontend,tdt}.js）
mt-worker.js        本機翻譯 worker（transformers.js 3.8.1 + opus-mt-en-zh）
whisper-worker.js / sherpa-worker.js / whistle-worker.js / whistle-engine.js
sw.js               Service Worker 外殼快取（v14 起包含 src/*.js 與 src/engines/*.js）
test_*.js           Node 測試（見下），共用 test_src.js 讀取 index.html + src/*.js
```

沒有建置步驟：瀏覽器直接載入 ES module（`<script type="module" src="src/app.js">`），
GitHub Pages 靜態伺服即可。`test_modules.js` 會擋住「把邏輯寫回 index.html」的退化，
`test_engines.js` 會擋住「又長出第二份排隊邏輯」的退化。

## 技術說明

- **Web Speech**：`webkitSpeechRecognition`
- **Vosk**：`vosk-browser`（WASM）；**sherpa-onnx**：WASM 串流辨識；**Whisper**：transformers.js + WebGPU（npm CDN 載入模型，Cache Storage 快取）
- **Whistle**：Cactus Compute 的 `needle` 引擎（WASM，repo 內 `needle/`，Apache-2.0）+ 16.9 MB 的 `whistle.cact`（Hugging Face，Cache Storage 快取 `whistle-model-v1`）。解碼在 `whistle-worker.js`，呼叫層 `whistle-engine.js` 由 Worker 與主執行緒退路共用一份
- **Underdog Bark 3.0**：Conway Research 對 `parakeet-tdt-0.6b-v3` 的英文微調（ONNX 由 ai-ecoverse
  匯出），在 `underdog-worker.js` 裡用 onnxruntime-web（jsdelivr）跑 mel → encoder → 貪心 TDT →
  SentencePiece；`underdog/frontend.js` 與 `underdog/tdt.js` 是同一份實作的兩個部分。不支援 WebGPU
  （會建出無效 pipeline），固定單執行緒 WASM；權重存於 `UNDERDOG_CACHE`
- **MOSS**：Hugging Face Space（官方 Gradio / 社群 LiteRT）批次轉寫，`parseMossGradio` 逐行解析時間戳與說話人
- 辨識結果以 opencc-js 簡轉繁；音量偵測使用 **Web Audio API**（`AudioContext`, `AnalyserNode`）
- 偏好設定存於 LocalStorage；本機模型檔由瀏覽器快取（Cache Storage）
- **安全**：外部程式碼（opencc-js、vosk-browser）以 SRI 驗證完整性，並以 `Content-Security-Policy`
  限制可載入的來源與可連線的端點；逐字稿與伺服器回應一律走 `textContent`，沒有注入面
  （CSP 仍需 `'unsafe-inline'`／`'unsafe-eval'`，因為頁面有內嵌 script、vosk-browser 的 worker
  與 emscripten 系的 WASM 會用到；CSP 在此主要擋的是「來源」，避免被替換的 CDN 檔案注入執行）
- **Google Analytics**：頁面載入 GA4（`G-GHGBM401HN`）統計瀏覽量。它**刻意沒有 SRI**
  （Google 會更新該檔內容，綁 `integrity` 會讓 GA 靜默失效），安全邊界交給 CSP ——
  `script-src` 只放行 `www.googletagmanager.com`、`connect-src`／`img-src` 只放行
  `*.google-analytics.com` 與 `*.analytics.google.com`，其餘指令沒有放寬。頁面只送
  `gtag('config')`，沒有自訂事件，逐字稿與音訊不會進 GA；使用者自行阻擋該網域不影響任何功能。
  這條一致性（CSP 放行 ↔ 聲明揭露）由 `test_ga_csp.js` 守住。
- **Service Worker**：外殼採 network-first（導覽）與 cache-first（其他同源資產），
  只快取成功的完整回應（4xx/5xx 與 206 部分內容不進快取），且不刪除模型快取

## 測試

這幾支 Node 測試不需要瀏覽器或測試框架（`index.html` 的測試直接抽出函式原始碼來跑）：

```bash
node test_vad.js                  # VAD 分段：開頭不重複、短語音丟棄、15 秒上限、flush
node test_sherpa_decode.js        # sherpa 解碼：partial / endpoint / 過期 session（主執行緒路徑）
node test_sherpa_download.js      # 分段下載：Range、單段重試、不支援 Range 的退路
node test_resample.js             # 降取樣：整數倍移動平均、非整數倍內插
node test_sherpa_worker_api.js    # worker 訊息協定（不需要模型，見下）
node test_whistle_worker_api.js   # Whistle：呼叫層參數、worker 協定、UI 接線（不需要模型）
node test_underdog.js             # Underdog Bark 3.0：mel 前處理不變量、TDT 迴圈規則、UI／worker 接線
node test_subtitle.js             # 雙語字幕與量測：該翻／不該翻的判斷、只翻完整句、HUD 與 __sttMetrics
node test_modules.js              # 模組邊界：主程式不得回流 index.html、sw 外殼要含 src/*.js
node test_engines.js              # 引擎介面：註冊表 role、批次與串流引擎共用同一個外殼、回壓與 session 隔離
node test_util.js                 # 純函式：makeAudioBuffer 的 16 kHz、concat／resample／stamp／isLatinDominated
node test_ga_csp.js               # GA 與 CSP／隱私聲明的一致性（放行清單、沒有過度放寬、聲明不實）
node test_opencc_lazy.js          # OpenCC 按需載入：不得回到啟動路徑、單次注入、SRI、中文判斷
```

這 11 支在 CI 上跑（`.github/workflows/test.yml`，約 12 秒、零依賴）。
需要 playwright 的 `test_speech_perf.js`（主執行緒阻塞量測）與 `test_worker_fallback.js`
（Worker 退路）**不在 CI 內** —— 它們要另外準備 `PW_MODULE`，屬於本機手動執行的量測工具。

需要 16.9 MB 模型檔的（沒有模型會自動跳過，不會讓 CI 紅）：

```bash
curl -L -o whistle.cact https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact
node test_whistle_engine.js        # 真模型轉寫：逐字稿、詞級時間戳、RTF
```

需要瀏覽器的（需要 playwright）：

```bash
PW_MODULE=/path/to/playwright/index.js node test_worker_fallback.js   # 引擎的 Worker 退路與狀態清理
```

### 為什麼要有 `test_sherpa_worker_api.js`

Worker 化把同一組 sherpa API 變成**兩份實作**（`index.html` 的主執行緒路徑與 `sherpa-worker.js`），
兩邊只要有一個參數對不上就會壞掉，而且壞得很安靜 —— 實際發生過：官方膠水層的簽名是
`getResult(stream)`（內部讀 `stream.handle`），worker 卻寫成 `recognizer.getResult()`，
於是**每一個音訊塊都丟 TypeError**；worker 把錯誤包成 `{type:'error', phase:'feed'}` 傳回主執行緒，
而主執行緒的等待器只認 `ready/final/started`，這個訊息沒有任何人處理 ——
症狀就是「**音量 bar 有動、字幕永遠不出來**」。

這支測試用一個**假膠水層**在 Node 裡跑真正的 `sherpa-worker.js`：假 recognizer 的
`getResult(stream)` 會像真的一樣讀 `stream.handle`（沒帶參數就丟 TypeError），
所以「忘記帶 stream」會直接紅燈，**不必下載 200 MB 的模型**。它同時驗證
`start` 必回 `started`（主執行緒的等待器只認這個）、feed 會回非空 `result`、
flush 會補 0.4 秒靜音並回 `final`、free 會回 `freed`。

### 為什麼要有 `test_whistle_worker_api.js`

Whistle 的解碼細節有一堆「寫錯會安靜壞掉」的地方，測試用**假 module**（不必下載 16.9 MB）
把它們釘住：

- `needle_load` 的長度參數是 `unsigned long long`（wasm 的 i64）→ 傳 Number 直接丟
  `TypeError: Cannot convert 16919407 to a BigInt`，模型永遠載不起來
- `needle_transcribe` 的語言只認 `en/de/fr/es/it/nl/pl` 或 `NULL`，其他代碼要送 `NULL` 自動偵測
- 超過 30 秒要自己裁；`word_timestamps` 不開就沒有詞級時間戳
- worker 的 `error` 一定要帶 `id`，否則主執行緒的 Promise 永遠不 settle（畫面卡在「處理中」）

另外它還守著兩條**實測踩出來的**規則：

1. **解碼只有一份實作**：`needle` 的底層 API 只出現在 `whistle-engine.js`，`index.html`
   與 `whistle-worker.js` 都透過它 —— 直接比對 `index.html` 裡有沒有 `_needle_transcribe(`，
   避免重演 sherpa「兩份實作參數對不上、字幕永遠空白」那個 bug 類型。
2. **wasm 要用 `wasmBinary` 餵，不能靠路徑推導**：這份 `needle.js` 建置**沒有**
   `Module.locateFile` 入口，Worker 裡它會用 `self.location.href`（站台根目錄）去抓
   `needle.wasm`，抓到 HTML 的症狀是啟動時
   `Aborted(CompileError: … expected magic word 00 61 73 6d, found 3c 21 44 4f)` ——
   `3c 21 44 4f` 就是 `<!DO`。這個 bug 是**在瀏覽器裡用真的 UI 載入模型時才發現的**
   （Node 的假 module 測試不會經過路徑推導）。

> ⚠️ **改動 `sherpa-worker.js`、`whistle-worker.js`、`whistle-engine.js`、`needle/` 或任何
> `sw.js` 的 `ASSETS` 成員時，必須一起升 `sw.js` 的 `CACHE` 版號。**
> worker 檔由 service worker 以 **cache-first** 供應，而瀏覽器只比對 `sw.js` 本身的位元來決定要不要更新 SW ——
> 只改 worker 不改 `sw.js`，`install` 不會重跑、`cache.addAll` 不會重抓，既有使用者會永遠拿到舊 worker。

## 隱私說明

- 🔒 **本機引擎**（Vosk／sherpa／Whisper／Whistle）：音訊完全不出裝置
- ☁️ **雲端引擎**（Web Speech／MOSS）：音訊會送至第三方伺服器處理，請勿用於敏感性內容

## 歷史變更

### 2025-05-16

1. **提取常數**：將魔法數字統一放至 `CONFIG` 物件
   - `RESTART_DELAY_MOBILE: 200`
   - `RESTART_DELAY_DESKTOP: 500`
   - `AUDIO_METER_DELAY: 300`
   - `SCROLL_THRESHOLD: 50`
   - `VOLUME_MULTIPLIER: 10`
   - `FEEDBACK_DURATION: 2000`
   - `MIN_SEGMENTS_FOR_EXPORT: 2`

2. **修復 Bug**：`copyTranscript` 函式判斷邏輯與 `canExportOrCopy` 不一致的問題

3. **統一命名**：`final_transcript_this_turn` 改為駝峰式命名 `finalTranscriptThisTurn`

4. **新增功能**：新增「清空」按鈕，可一鍵清除逐字稿內容

5. **UI 優化**：清空按鈕使用紅色渐变样式

## 本次優化 (2026-08-23)

1. **修復 Bug**：空白鍵在按鈕停用時（瀏覽器不支援語音／Vosk 模型未載入）仍會觸發辨識 → `state.recognition` 為 null 拋 TypeError 當機 — 已加停用檢查與空值防護

2. **修復 Bug**：麥克風權限被拒或網路錯誤時，Web Speech 引擎會陷入「錯誤 → 自動重啟 → 再錯誤」無限迴圈並連續彈窗 — 致命錯誤改為停止辨識，僅以 toast 提示一次

3. **UX 優化**：`alert()` 全部改為非阻塞 toast 提示

4. **UX 優化**：本機模型上傳列新增下載提示與連結（alphacephei.com/vosk/models），選檔後顯示檔名

5. **UX 優化**：辨識中分頁標題加「●」錄音指示，切分頁也能看到狀態

6. **UX 優化**：點開始後按鈕立即切換為「停止辨識」（不需等瀏覽器回呼），避免快速連點重複啟動；權限詢問途中停止可正確取消

7. **效能**：Vosk 模式音量表不再建立第二個 AudioContext，與辨識共用同一個

8. **程式碼品質**：抽出 `beginNewRecording()` 共用開始錄音邏輯；`updateEngineUI` 改用 `UIElements.langLabel`；`copyTranscript` 判斷與 `MIN_SEGMENTS_FOR_EXPORT` 常數對齊

## 本次新增 (2026-08-23) — Whisper (WebGPU) 離線引擎

新增第三個辨識引擎：**Whisper**（transformers.js + WebGPU / WASM fallback），完全在瀏覽器本機 GPU 執行，音訊不出裝置，不受 Google 不穩／延遲影響。

- 三種模型可選：tiny (~40MB) / base (~74MB) / small (~240MB，預設)，首次下載後快取於瀏覽器
- 預設 small 是為了中英混雜語音的正確率：實測同一段「我用 React 寫前端，遇到 API 的問題」，
  base 會把「前端」聽成「前段」、「JavaScript」聽成「漢字」，small 則 100% 正確
- 分句轉錄：用與其他本機引擎同一套 VAD 切段（0.8 秒靜音或滿 15 秒），每段獨立送進
  `whisper-worker.js` 解碼（`chunk_length_s: 15`／`stride_length_s: 2`），佇列最多排 3 段
  > 📌 這裡原本寫「滾動視窗：每 2.6 秒重新轉錄最近 6 秒」，那是早期實作；程式碼後來改成
  > VAD 分句，文件沒跟著改（2026-10-10 修正）。
- 支援語言與 Web Speech 相同（中文／粵語／英日韓西法德），zh-HK 自動映射為粵語 (yue)
- 硬體偵測：有 WebGPU 用 GPU（快），沒有自動退回 WASM（較慢但可用；WASM 用 q4 量化，
  transformers.js 4.2.0 的 WASM+q8 會因 decoder 量化錯誤崩潰，且失敗載入會毒化模型快取）
- 技術：`@huggingface/transformers@4.2.0` + `onnx-community/whisper-*` 量化模型（dtype q4；
  WASM 退路同樣用 q4，因為 4.2.0 在 WASM + q8 會出現 decoder 量化錯誤）

## 本次新增 (2026-08-23) — 繁體中文輸出

辨識結果一律輸出**繁體中文**（opencc-js，簡轉繁）。

- Vosk 中文模型與 Whisper 預設輸出簡體中文，現於結果提交前自動轉為繁體
- zh-TW / zh-CN → 台灣繁中用語（例如 软件工程师→軟體工程師、里面→裡面）
- zh-HK → 香港繁中用語（例如 里面→裏面）
- 英文、日文、韓文等其他語言不轉換，原樣輸出
- Vosk 內建 cn 模型強制轉為繁體（該模式下語言下拉是隱藏的）；自訂上傳模型依「辨識語言」下拉判斷
- opencc-js 由 CDN 載入（jsdelivr，約 1MB，瀏覽器快取）；離線時自動略過轉換，不影響辨識

## 本次優化 (2026-09-11) — 介面與優勢強化

1. **引擎卡片式選擇器**：五種引擎改為情境卡片，每張標明隱私等級（🔒 本機／☁️ 雲端）與一句話定位，並依所選引擎顯示「快速開始」引導步驟，降低上手門檻
2. **MOSS 拖放上傳**：音訊／影片檔可直接拖放進面板，自動顯示檔名與大小
3. **SRT 字幕匯出**：MOSS 轉寫結果（含時間戳與說話人標籤）可一鍵輸出標準 `.srt` 字幕檔，適合直接餵給剪輯軟體
4. **隱私／狀態視覺化**：notice、狀態列與引擎卡片統一以 🔒／☁️ 區分本機處理與雲端處理，音訊處理位置一目了然
5. **修正 Bug**：MOSS 模式下按空白鍵不再誤觸發 Web Speech；Whisper WASM 退回路徑改回 q4 量化（避免 transformers.js 4.2.0 的 decoder 崩潰）
6. **效能**：逐字稿渲染改為增量 append，只更新新段落，長會議不再逐次重建整份文字

## 本次修正 (2026-09-11) — 程式碼審查

1. **修正 Bug（明顯影響辨識品質）**：VAD 的前置緩衝把「當前音訊塊」算進去後又 push 一次，
   每一句開頭都會餵給 Whisper 一段重複的 128 ms 音訊 — 已修正並加上 `test_vad.js` 回歸測試
2. **修正 Bug（Service Worker）**：`activate` 原本會刪掉「除了外殼以外的所有快取」，
   連 `transformers-cache`（Whisper 模型）與 `sherpa-onnx-model-v1`（199 MB）都被清掉，
   等於每次改版就讓使用者重新下載數百 MB — 現在只清理 `stt-shell-*` 自己的舊版本
3. **修正 Bug（Service Worker）**：同源請求原本連 4xx/5xx 與 206 部分內容都寫進快取
   （`Cache.put` 對 206 一定 reject，留下未處理的 rejection；Range 請求還可能拿到整份的
   200 而讓 sherpa 分段下載誤判失敗）— 現在只快取成功的完整回應，且大於 64 MB 的二進位檔
   （模型）不進外殼快取，並把寫入交給 `event.waitUntil`
4. **修正 Bug（MOSS）**：批次轉寫沒有逾時、沒有取消、也沒有 abort — 現在有 3 分鐘停滯偵測、
   30 分鐘絕對上限、可中途取消，且轉寫中關頁會跳出警告
5. **修正 Bug**：換檔後「輸出 SRT」會把上一個檔案的內容寫成新檔名 — 換檔即作廢上次結果
6. **修正 Bug**：Web Speech 致命錯誤（權限被拒、網路錯誤）只依賴 `onend` 收尾，
   若瀏覽器沒回呼就會卡在「辨識中」且一直擋關頁 — 加上 1.5 秒逾時收尾
7. **修正 Bug**：Vosk 內建英文模型仍會被送進 OpenCC（語言選單是隱藏的，判斷只看選單）
8. **修正 Bug**：LocalStorage 的舊值未經驗證就套用，會讓 `state.engine` 變成空字串，
   狀態卡與引擎卡片對不起來 — 現在會驗證；同時補上模型來源、收音靈敏度、MOSS 運算位置的記憶
9. **安全**：新增 CSP（限制 script/connect/worker 來源）並對 opencc-js、vosk-browser 加上 SRI
   （gtag 因為 Google 會更新檔案內容，無法使用 SRI）
10. **效能**：逐字稿的 `copy/export` 可用性判斷改成快取，不再每個音訊塊都對整份逐字稿做
    filter + trim；MOSS 整批結果改成一次 commit，不再每段觸發一次重排與捲動
11. **音訊品質**：降取樣（48k → 16k）先做整數倍移動平均低通，避免高頻折疊回語音頻帶
12. **無障礙**：逐字稿不再整個當成 live region（interim 每秒更新多次會灌爆螢幕閱讀器），
    改成段落確定後送進隱藏 announcer 並合併播報；引擎卡片改用 `role="group"` + `aria-pressed`
13. **PWA**：補上 maskable 圖示（原圖示的安全區只剩 2% 邊界），manifest 移除 portrait 限制
14. **清理**：移除寫入後沒人讀的狀態（`whisper.busy`、`state.end`）、永遠不會成立的
    `loadGeneration` 檢查、沒有 CSS 規則的 `.locked` class 與未使用的翻譯字串
15. **修正 Bug（測試時發現，影響沒有 WebGPU 的機器）**：transformers.js 4.2.0 只要試過
    `device: 'webgpu'` 失敗，同一個模組實例之後連 `device: 'wasm'` 都會沿用同一個失敗結果
    （實測一律回 `no available backend found ... [webgpu]`），也就是 README 寫的「WebGPU 不可用
    時自動退回 WASM」其實是壞的。現在改成先用 `requestAdapter()` 確認有 adapter 才試 WebGPU，
    真的失敗時再換一份全新的模組實例重試 WASM（headless Chrome 實測 WASM 退路可正常載入）
## 本次新增 (2026-10-10) — Whistle：16.9 MB 的本機輕量引擎

參考 Cactus Compute 的 [Whistle: Speech to Text in 16.9 MB](https://cactuscompute.com/blog/whistle)，
把第六個引擎接進本專案。**它是本專案第一個「下載量只有兩位數 MB」的本機引擎**
（Vosk 81 MB、sherpa 199 MB、Whisper small 240 MB），但**不支援中文**、也不是真串流。

- 模型：`whistle.cact` 16.9 MB（Hugging Face `Cactus-Compute/whistle`，Apache-2.0），
  首次載入後存進 Cache Storage（`whistle-model-v1`），可自訂模型網址或清除快取
- 引擎：Cactus 的 `needle` WASM（`needle/needle.js` 63 KB + `needle/needle.wasm` 923 KB，
  同源、進 Service Worker 外殼快取），解碼在 `whistle-worker.js`，主執行緒只做訊息搬運
- 辨識：英、德、法、西、義、荷、波七種語言（自動偵測或用語言選單指定），
  附**詞級時間戳**（start／end／probability，目前 UI 只顯示文字，資料已從引擎取回）
- 分段方式：與 Whisper 同一套 VAD（0.8 秒靜音或滿 15 秒切一段），每段獨立轉寫
- 為什麼不用引擎內建的串流 API（`needle_stream_transcribe_process`）：它每一輪都把整個
  緩衝重新轉寫，成本隨緩衝成長 —— 本機實測 36 秒音訊共花 113 秒（RTF 3.2），跟不上即時。
  分段後是線性成本（RTF 0.3）。詳細數字見 [MODELS.md](MODELS.md)

### 實測（本機 Chrome / Node，真模型）

| 項目 | 數字 |
| --- | --- |
| 模型下載 | 16,919,407 bytes（16.9 MB） |
| 引擎初始化 + 模型載入 | 58 ms（瀏覽器 Worker） |
| 3 秒英文音訊轉寫 | 947 ms（RTF 0.31，ttft 363 ms） |
| 30 秒英文音訊轉寫 | 10.6 s（RTF 0.35） |
| 逐字稿正確性 | 「Turn off the kitchen lights and set a timer for ten minutes.」→ 完全正確（`10` 數字化） |

### 這個功能在瀏覽器裡抓到的一個 bug（Node 測試抓不到）

第一次用真的 UI 載入模型時，狀態顯示的是「模型已就緒（**主執行緒**）」——
Worker 路徑其實失敗了，退路接手。原因：這份 `needle.js` 建置沒有 `Module.locateFile` 入口，
Worker 裡它用 `self.location.href`（站台根目錄）去抓 `needle.wasm`，抓到 HTML，
啟動時炸 `expected magic word 00 61 73 6d, found 3c 21 44 4f`（`3c 21 44 4f` = `<!DO`）。
修法是兩條路徑都把 wasm 位元組用 `wasmBinary` 直接餵進去，並且在
`test_whistle_worker_api.js` 加上回歸斷言。

### 同一天：開通 Google Analytics 並更正隱私聲明（與 Whistle 同一個 PR）

`main` 上的 `348c0fb` 加了 GA4 追蹤碼，但**它從來沒有生效**：頁面的 CSP 沒有放行
`www.googletagmanager.com`，gtag.js 被自己的 CSP 擋掉。實測證據
（Chromium、`securitypolicyviolation`）：

```
{"blocked":"https://www.googletagmanager.com/gtag/js?id=G-GHGBM401HN",
 "directive":"script-src-elem"}
資源紀錄 transferSize = 0（檔案從頭到尾沒下載）
```

修法與取捨：

1. **只放行 GA 真正需要的三個來源**，其餘不放寬：
   - `script-src` 加 `https://www.googletagmanager.com`（gtag.js 本體）
   - `connect-src` 加 `https://*.google-analytics.com`、`https://*.analytics.google.com`（GA4 beacon）
   - `img-src` 加 `https://*.google-analytics.com`（不能用 `sendBeacon`／`fetch` 時的 pixel 退路）
   `default-src`／`object-src`／`base-uri` 全部維持原樣。
2. **`integrity`（SRI）刻意不加**：Google 會更新 gtag.js 的內容，綁上去會在某天讓 GA
   靜默失效，而且失敗沒有任何畫面提示。這一條寫進 index.html 的註解，避免以後有人「順手補上」。
3. **隱私聲明同步更正**：原本寫「本頁不含任何分析或追蹤程式」——裝了 GA 之後這句話就是不實陳述。
   中英文都改成明示揭露：GA 只用來看瀏覽量與一般流量資訊（來源、裝置、大致地區），
   逐字稿、麥克風音訊與辨識結果不會上傳、也不會送進 GA，並且說明「自行阻擋
   googletagmanager.com 不影響任何功能」。
4. **新增 `test_ga_csp.js`**：把「CSP 有放行 ↔ 沒有過度放寬 ↔ 聲明與事實一致」三件事釘在一起。
   這個坑兩個方向都會踩：CSP 收緊時忘了 GA（GA 無聲失效），或為了 GA 放寬成 `*`（來源限制形同虛設）。

驗證（Chromium，本機 server）：`securitypolicyviolation` 事件 0 筆、gtag.js 有實際下載、
GA4 `/g/collect` beacon 有送出、六個引擎切換與 Whistle 載入不受影響。

## 本次優化 (2026-10-10) — 啟動路徑、預抓量與 CI

整體檢視（量測方法與完整數據見 `voice_to_text-優化檢視-2026-10-10.md`）後修的六件事。
原則：**只修量得出來、且幅度對得起風險的地方**；量完發現不是問題的就不動（見文末）。

### 1. OpenCC 改成按需載入（最大的一項）

`opencc-js/cn2t.js` 實測 **1.04 MB（br 505 KB）**，是整個 App 本體 gzip（44.6 KB）的 **11 倍**，
而且它是 parser-blocking 的 `<script src>`，擺在主 inline script 之前 ——
等於全頁的 UI 接線（卡片文字、按鈕事件）都要排隊等它。

實測（Chromium、Slow 3G 400 kbps／400 ms RTT）：

| | UI 可用（卡片有字、按鈕能按） |
| --- | --- |
| 修正前（opencc 在 critical path） | **14,111 ms** |
| 擋掉 jsdelivr（模擬不載入） | **59 ms** |

現在改成 `ensureOpencc()` 動態注入（保留版本鎖定與 SRI），觸發點有三個：
`begin()`（開始辨識前）、語言選單切到中文、`updateEngine()` 遇到會輸出中文的引擎
（sherpa／MOSS／Vosk 內建 cn）。`traditional()` 在 OpenCC 還沒到時**原樣輸出並順手補抓**
（與舊行為相同的優雅降級），MOSS 的整批寫入則 `await ensureOpencc()`，不會整份留簡體。
由 `test_opencc_lazy.js` 守住：靜態標籤不得回來、單次注入、SRI、各種語言組合的判斷。

### 2. Service Worker 不再預抓 needle 引擎（−360 KB）

`install` 的 `cache.addAll` 原本包含 `needle/needle.wasm`（923 KB 原始／342 KB gzip）與
`needle/needle.js`（63 KB／18 KB gzip）—— 佔預抓傳輸量的 **81%**，但只有選 Whistle 的人會用到。
兩者都是同源資產，`fetch` handler 本來就會在第一次使用時寫進快取；
唯一犧牲的是「離線後第一次就選 Whistle」，而那個情境本來就不成立（首次一定要連網下載 16.9 MB 模型）。
`CACHE` 依規則升為 `stt-shell-v6`。

### 3. Google Analytics 延後到閒置才下載（−181 KB）

gtag.js 實測 **181 KB（br）**，是 App 本體的 4 倍。改成 `load` 之後用 `requestIdleCallback`
（最多等 3 秒；沒有 `requestIdleCallback` 的瀏覽器退固定 1.2 秒）才注入。
**取捨：`page_view` 會晚 1–3 秒送出，極短命的工作階段可能漏記**；
要恢復「一進來就載」，把 `scheduleAnalytics()` 換成 `loadAnalytics()` 即可。

### 4. `preconnect` 到 Hugging Face 與 jsDelivr

首次下載模型／引擎前先建好連線（DNS + TCP + TLS 在手機上 200–400 ms，HF 還會再 302 到 CDN）。
代價是一次閒置連線。

### 5. Whistle 的語言選單加上說明

Whistle 只支援七種歐洲語言，選 zh／ja／ko 時會自動偵測（行為正確），
但 UI 沒有任何說明，使用者會以為自己選錯。現在選 Whistle 時語言欄下方會多一行提示
（中英文皆有）。同時修掉 README 裡與程式碼不符的 Whisper 描述。

### 6. CI

`.github/workflows/test.yml`：push 到 main 與 PR 時跑 9 支純 Node 測試（約 10 秒、零依賴）。
需要 playwright 的兩支量測工具刻意不進 CI（要另外準備 `PW_MODULE`）。

### 量測後「決定不要動」的（避免以後重做）

| 懷疑的地方 | 實測 | 結論 |
| --- | --- | --- |
| 每 128 ms 音塊的「降取樣 + VAD」 | 960 塊（120 秒音訊）共 **19.4 ms** → 0.020 ms/塊，佔預算 **0.02%** | 不是瓶頸 |
| `render()` 每次重寫整份逐字稿 | 3000 段（176 KB）共 **1.8 ms** | 可忽略 |
| 把 `index.html` 拆成 CSS/JS | 本體 gzip 只有 44.6 KB | 純可維護性，非效能 |
| Vosk 的 81 MB 模型放 git | 使用者端省不到（`MODELS.md` 已評估） | 維持原結論 |
