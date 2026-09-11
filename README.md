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
- 技術：`@huggingface/transformers@4.2.0` + `Xenova/whisper-*` 量化模型（dtype q8）

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