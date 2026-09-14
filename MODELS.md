# 模型交付、下載量與後續路線

這份文件記錄**每個引擎實際要下載多少**、哪些東西現在放在哪裡，以及三條還沒做但值得做的路線。
數字都是在本機實測（Chrome、`test_speech_perf.js`），不是估算。

## 目前的下載量與來源

| 引擎 | 首次下載 | 來源 | 之後 |
| --- | --- | --- | --- |
| Web Speech | 0 | 瀏覽器/Google 雲端 | 不需模型 |
| Vosk | **81 MB**（cn 42 MB + en 40 MB，zip） | **本 repo 的 git**（`models/*.zip`） | Service Worker 外殼快取（上限 64 MB） |
| sherpa-onnx | **約 199 MB**（`.wasm` + `.data`） | Hugging Face（`cormort/sherpa-zh-en-streaming`） | `SHERPA_CACHE`（Cache Storage） |
| Whisper | tiny/base/small × q4（實測 base 載入 10.5–12 s） | HF（transformers.js） | 瀏覽器模型快取 |
| MOSS | 0 | 雲端 HF Space | — |

### 為什麼 Vosk 的 zip 放在 git 裡是個問題
- repo 因此是 **82 MB**：clone、GitHub Pages 部署、CI 都快不起來。
- GitHub Pages 對 `.zip` 只給 `max-age=600`，所以 sw.js 必須自己再包一層外殼快取
  （`MAX_CACHE_BYTES = 64 MB` 就是為它設的）。
- 已經有現成的替代模式：sherpa 的資產放在 HF、用 Cache Storage 管，Vosk 可以照做。

### 搬到 HF 的步驟（需要在你的 HF 帳號操作，我無法代做）
```sh
# 1) 建一個模型 repo（或用現有的），把兩個 zip 傳上去
huggingface-cli upload cormort/vosk-models-zh-en models/vosk-model-small-cn-0.22.zip .
huggingface-cli upload cormort/vosk-models-zh-en models/vosk-model-small-en-us-0.15.zip .

# 2) index.html 的內建模型路徑改成 HF resolve 網址（約 392 行）
#    cn: 'https://huggingface.co/cormort/vosk-models-zh-en/resolve/main/vosk-model-small-cn-0.22.zip'
#    en: 'https://huggingface.co/cormort/vosk-models-zh-en/resolve/main/vosk-model-small-en-us-0.15.zip'

# 3) 確認 CSP 的 connect-src 已含 huggingface.co（目前有）
# 4) 從 git 移除 zip 並加進 .gitignore，repo 由 82 MB 降到 ~0.5 MB
git rm --cached models/*.zip && printf 'models/*.zip\n' >> .gitignore
```
> 注意：搬移後第一次載入仍要抓 81 MB，但那是「使用者端一次」而不是「每次 clone／每次部署」。
> 若希望第一次也更快，得換更小的模型（見下方路線）。

## 下載進度回報的現狀

| 引擎 | 進度 | 說明 |
| --- | --- | --- |
| Whisper | ✅ 真實百分比 | 走 `whisper-worker.js` 的 `progress_callback`，狀態列會顯示 `53%（decoder_model_merged_q4.onnx）` |
| Vosk | ⚠️ 無 | 模型由 `vosk-browser` 在自己的 Worker 內抓取，外部拿不到進度 |
| sherpa | ⚠️ 無 | `.data` 由 App 自己抓，可改用 `fetch` + `ReadableStream` 累計位元組做百分比 |

## 三條還沒做的路線

### 1. SenseVoice（本機批次，準確率大勝 Vosk small）
Tencent 的 AuK 專案內附的本地 ASR 就是 **SenseVoiceSmall**（README：「omit these to use local
SenseVoiceSmall」）。它的價值在**檔案／批次轉寫**：準確率遠高於 `vosk-model-small-*`，而且仍在
本機（可取代或補強 MOSS 雲端那條，保住隱私）。

**但要注意兩件事**：
- SenseVoice **不是串流模型** → 不要放進即時路徑，放批次。
- 現有的 sherpa 路徑是「模型已包進 `.data`」的建置（`sherpa-onnx-wasm-main-asr`），換模型要用
  sherpa-onnx 的 WASM 建置流程把 SenseVoice 的 onnx 用 `--preload-file` 包一份新的 `.data`，
  再上傳到 HF，然後用設定頁既有的「資產位置」欄位指過去。**這一步需要 emscripten 建置環境**，
  不是改幾行 JS 就能完成。

### 2. 更大的 Whisper 模型（現在才可行）
Worker 化之後，模型推論不再阻塞主執行緒 —— 這解鎖了以前不敢用的選項：
`whisper-small`（或多語 turbo 的 ONNX 版本）在 WASM 下會慢，但**不會再讓 UI 凍結**，
適合走「拖檔批次轉寫」而不是即時。WebGPU 可用時差距會更明顯。

### 3. AuK（語音生成與編輯）—— 不是 STT 優化
[Tencent-Hunyuan/AuK](https://github.com/Tencent-Hunyuan/AuK) 是**語音生成與編輯**的基礎模型：
zero-shot TTS、instruct TTS、語音內容編輯、歌詞編輯、音高/語速編輯、whisper 轉換。
全篇沒有 streaming / real-time 字樣 → **它不會讓即時辨識變快或變準**。

它對這個專案真正有用的地方是「反方向」與「後製」：

| AuK 能力 | 可以做成 | 代價 |
| --- | --- | --- |
| zero-shot TTS | 朗讀逐字稿、用你的聲音唸出 SRT | 需 GPU + Python 服務，與「瀏覽器端零安裝」定位衝突 → 只能當**可選後端** |
| speech content editing | 錄音後製：替換／插入／刪除某段內容並保留聲音 | 同上，離線批次工具 |
| whisper conversion | 把氣音／耳語轉成正常語音 | 特殊情境 |
| SenseVoiceSmall | 見上方路線 1 | 需 WASM 建置 |

## 怎麼自己量
```sh
node test_speech_perf.js                       # 量 vosk 與 whisper 的主執行緒阻塞
PERF_ENGINES=vosk,sherpa,whisper,webspeech,moss node test_speech_perf.js
PERF_SECONDS=30 PERF_MAX_BLOCK_MS=200 node test_speech_perf.js   # 可接 CI 的門檻
```
量到的基準（本機 Chrome、`say` 產生的中文語音餵假麥克風）：

| 引擎 | 25 s 串流長任務 | 最長單次 | 主執行緒 heap |
| --- | --- | --- | --- |
| Vosk | 0 個 | 0 ms | 51 MB |
| Whisper（Worker 化之後） | 0 個 | 0 ms | 20 MB |
| Whisper（Worker 化之前） | 2 個 | **12,295 ms** | 202 MB |
