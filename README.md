# 多國語言即時逐字稿工具

一個使用瀏覽器 Web Speech API 的即時語音轉文字工具。

## 功能

- **即時語音辨識**：支援多種語言的即時語音轉文字
- **多語言介面**：可切換中文/英文介面
- **音量偵測**：即時顯示麥克風音量
- **匯出功能**：可匯出為 .txt 檔案
- **複製功能**：可複製逐字稿內容
- **清空功能**：可一鍵清除逐字稿

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

1. 允許瀏覽器存取麥克風
2. 選擇辨識語言
3. 點擊「開始辨識」按鈕
4. 說話後文字會即時顯示
5. 點擊「停止辨識」結束
6. 可複製或匯出逐字稿

## 技術說明

- 使用 Web Speech API (`webkitSpeechRecognition`)
- 音量偵測使用 Web Audio API (`AudioContext`, `AnalyserNode`)
- 使用 LocalStorage 儲存使用者偏好設定

## 隱私說明

此工具會將語音資料傳送至 Google 伺服器處理，請勿用於敏感性內容。

## 本次修正 (2025-05-16)

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

- 三種模型可選：tiny (~40MB) / base (~74MB，預設) / small (~240MB)，首次下載後快取於瀏覽器
- 滾動視窗轉錄：每 ~2.6 秒對最近 6 秒音訊重新轉錄，以最長共同前綴比對輸出增量，避免重複文字
- 支援語言與 Web Speech 相同（中文／粵語／英日韓西法德），zh-HK 自動映射為粵語 (yue)
- 硬體偵測：有 WebGPU 用 GPU（快），沒有自動退回 WASM（較慢但可用）
- 技術：`@huggingface/transformers@4.2.0` + `Xenova/whisper-*` 量化模型（dtype q8）

## 本次新增 (2026-08-23) — 繁體中文輸出

辨識結果一律輸出**繁體中文**（opencc-js，簡轉繁）。

- Vosk 中文模型與 Whisper 預設輸出簡體中文，現於結果提交前自動轉為繁體
- zh-TW / zh-CN → 台灣繁中用語（例如 软件工程师→軟體工程師、里面→裡面）
- zh-HK → 香港繁中用語（例如 里面→裏面）
- 英文、日文、韓文等其他語言不轉換，原樣輸出
- Vosk 內建 cn 模型強制轉為繁體（該模式下語言下拉是隱藏的）；自訂上傳模型依「辨識語言」下拉判斷
- opencc-js 由 CDN 載入（jsdelivr，約 1MB，瀏覽器快取）；離線時自動略過轉換，不影響辨識