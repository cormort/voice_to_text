# 多國語言即時逐字稿工具

瀏覽器端的語音轉文字工具，提供**五種辨識引擎**（Web Speech、Vosk、sherpa-onnx、Whisper、MOSS 會議轉寫）：可即時語音辨識、批次轉寫音檔／影片，並一鍵輸出標準 SRT 字幕。

## 特色

- **五種辨識引擎**：雲端 Web Speech 與 MOSS、本機 Vosk / sherpa-onnx / Whisper（WASM / WebGPU），引擎卡片式選擇器標明隱私等級（🔒 本機／☁️ 雲端）並附快速開始引導
- **即時語音辨識**：多語言即時轉文字，搭配音量偵測即時回饋；空白鍵快速開始／停止
- **MOSS 會議轉寫**：拖放音訊／影片檔上傳，自動轉寫並標示說話人（S01、S02…），可一鍵匯出標準 `.srt` 字幕
- **繁體中文輸出**：辨識結果自動簡轉繁（opencc-js）
- **多語言介面**：中文／英文一鍵切換
- **匯出／複製／清空**：逐字稿可複製或匯出 .txt；MOSS 結果可輸出 .srt
- **增量渲染**：長會議逐字稿只增量更新畫面，不整份重建
- **PWA**：可安裝到桌面／主畫面，外殼離線快取（模型檔仍需網路下載），圖示含 maskable 版本

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

## 使用說明

1. 選擇辨識引擎（引擎卡片或下拉選單）；本機引擎首次使用會下載模型
2. 即時引擎：允許瀏覽器存取麥克風 → 點「開始辨識」→ 說話後文字即時顯示 → 「停止辨識」→ 複製或匯出
3. MOSS：拖放或點選音訊／影片檔 → 點「批次轉寫」→ 完成後輸出 SRT 字幕

## 技術說明

- **Web Speech**：`webkitSpeechRecognition`
- **Vosk**：`vosk-browser`（WASM）；**sherpa-onnx**：WASM 串流辨識；**Whisper**：transformers.js + WebGPU（npm CDN 載入模型，Cache Storage 快取）
- **MOSS**：Hugging Face Space（官方 Gradio / 社群 LiteRT）批次轉寫，`parseMossGradio` 逐行解析時間戳與說話人
- 辨識結果以 opencc-js 簡轉繁；音量偵測使用 **Web Audio API**（`AudioContext`, `AnalyserNode`）
- 偏好設定存於 LocalStorage；本機模型檔由瀏覽器快取（Cache Storage）
- **安全**：外部程式碼（opencc-js、vosk-browser）以 SRI 驗證完整性，並以 `Content-Security-Policy`
  限制可載入的來源與可連線的端點；逐字稿與伺服器回應一律走 `textContent`，沒有注入面
  （CSP 仍需 `'unsafe-inline'`／`'unsafe-eval'`，因為頁面有內嵌 script、vosk-browser 的 worker
  與 emscripten 系的 WASM 會用到；CSP 在此主要擋的是「來源」，避免被替換的 CDN 檔案注入執行）
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

> ⚠️ **改動 `sherpa-worker.js` 或任何 `sw.js` 的 `ASSETS` 成員時，必須一起升 `sw.js` 的 `CACHE` 版號。**
> worker 檔由 service worker 以 **cache-first** 供應，而瀏覽器只比對 `sw.js` 本身的位元來決定要不要更新 SW ——
> 只改 worker 不改 `sw.js`，`install` 不會重跑、`cache.addAll` 不會重抓，既有使用者會永遠拿到舊 worker。

## 隱私說明

- 🔒 **本機引擎**（Vosk／sherpa／Whisper）：音訊完全不出裝置
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
- 滾動視窗轉錄：每 ~2.6 秒對最近 6 秒音訊重新轉錄，以最長共同前綴比對輸出增量，避免重複文字
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