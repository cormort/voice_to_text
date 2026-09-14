# 模型交付、下載量與後續路線

這份文件記錄**每個引擎實際要下載多少**、哪些東西現在放在哪裡，以及三條還沒做但值得做的路線。
數字都是在本機實測（Chrome、`test_speech_perf.js`），不是估算。

## 目前的下載量與來源

| 引擎 | 首次下載 | 來源 | 之後 |
| --- | --- | --- | --- |
| Web Speech | 0 | 瀏覽器/Google 雲端 | 不需模型 |
| Vosk | **81 MB**（cn 42 MB + en 40 MB，zip） | **本 repo 的 git**（`models/*.zip`） | `VOSK_CACHE`（Cache Storage） |
| sherpa-onnx | **約 199 MB**（`.wasm` + `.data`） | Hugging Face（`cormort/sherpa-zh-en-streaming`） | `SHERPA_CACHE`（Cache Storage） |
| Whisper | tiny/base/small × q4（實測 base 載入 10.5–12 s） | HF（transformers.js） | 瀏覽器模型快取 |
| MOSS | 0 | 雲端 HF Space | — |

### 把 Vosk 的 zip 搬到 HF —— 目前評估是「先不要做」

搬走唯一買到的東西是 **clone / CI / Pages 部署變快**；使用者端一毛都沒省（還是要抓 81 MB）。
而要真的省到，代價比想像中大，所以這條先擱著，等 clone 或部署真的慢到有感再說。

**代價：`git rm --cached` 不會讓 repo 變小。** 兩個 blob 是在 `6bb5145` 進來的，之後永遠留在
歷史裡：

```
41.9 MB  models/vosk-model-small-cn-0.22.zip
39.3 MB  models/vosk-model-small-en-us-0.15.zip
```

`git rm --cached` 只是讓「之後的 commit」不再帶它們，`.git` 仍是 82 MB，每次 clone 照抓。
要降到 ~0.5 MB 必須用 `git filter-repo` 改寫歷史再 force-push —— 那會弄壞所有既有的 clone
與未合併的 PR，是另一個層級的決定，不是收尾步驟。

**另外，原本寫的「sw.js 靠 64 MB 外殼快取硬扛」是誤解。** `MAX_CACHE_BYTES`（`sw.js:11`）是
「超過就不要快取」的上限保護，不是為 zip 設的機制；而且單顆 zip 是 42/40 MB，本來就在上限內。
自從 `48e98e5` 之後，Vosk 的 zip 改由 `fetchVoskPackage` 用 Range 分段抓、存進自己的
`VOSK_CACHE`，根本不會經過外殼快取。

### 真的要搬的時候，步驟是（需要在你的 HF 帳號操作）
```sh
# 1) 建一個模型 repo（或用現有的），把兩個 zip 傳上去
huggingface-cli upload cormort/vosk-models-zh-en models/vosk-model-small-cn-0.22.zip .
huggingface-cli upload cormort/vosk-models-zh-en models/vosk-model-small-en-us-0.15.zip .

# 2) index.html 的 VOSK_MODELS 路徑改成 HF resolve 網址
#    cn: 'https://huggingface.co/cormort/vosk-models-zh-en/resolve/main/vosk-model-small-cn-0.22.zip'
#    en: 'https://huggingface.co/cormort/vosk-models-zh-en/resolve/main/vosk-model-small-en-us-0.15.zip'

# 3) 確認 CSP 的 connect-src 已含 huggingface.co（目前有）

# 4) 停止追蹤（注意：這一步「不會」讓 repo 變小，只是不再新增）
git rm --cached models/*.zip && printf 'models/*.zip\n' >> .gitignore

# 5) 真正要省空間才做這步 —— 改寫歷史並 force-push，會弄壞所有既有 clone
#    pip install git-filter-repo
git filter-repo --path models/vosk-model-small-cn-0.22.zip \
                --path models/vosk-model-small-en-us-0.15.zip --invert-paths
git push --force origin main
```

## 下載進度回報的現狀

| 引擎 | 進度 | 說明 |
| --- | --- | --- |
| Whisper | ✅ 真實百分比 | 走 `whisper-worker.js` 的 `progress_callback`，狀態列會顯示 `53%（decoder_model_merged_q4.onnx）` |
| Vosk | ✅ 真實百分比與 MB | `48e98e5` 起改由 `fetchVoskPackage` 自行分段下載（狀態列會顯示 `21.4 / 41.9 MB（51%）`），抓完用 blob: URL 交給 `createModel` |
| sherpa | ✅ 真實百分比與 MB | 自行 `fetch` 190 MB 的 `.data` 並累計位元組（狀態列會顯示 `Downloading 64.0 / 189.8 MB（33.7%）`） |

## 三條還沒做的路線

### 1. SenseVoice（本機批次）—— 評估後決定不做
Tencent 的 AuK 專案內附的本地 ASR 就是 **SenseVoiceSmall**（README：「omit these to use local
SenseVoiceSmall」）。它的價值在**檔案／批次轉寫**：準確率遠高於 `vosk-model-small-*`，而且仍在
本機（可取代或補強 MOSS 雲端那條，保住隱私）。

**但要注意兩件事**：
- SenseVoice **不是串流模型** → 不要放進即時路徑，放批次。
- 現有的 sherpa 路徑是「模型已包進 `.data`」的建置（`sherpa-onnx-wasm-main-asr`），換模型要用
  sherpa-onnx 的 WASM 建置流程把 SenseVoice 的 onnx 用 `--preload-file` 包一份新的 `.data`，
  再上傳到 HF，然後用設定頁既有的「資產位置」欄位指過去。**這一步需要 emscripten 建置環境**，
  不是改幾行 JS 就能完成。

**結論：不做。** 代價是要長期養一套 C++／emscripten 建置流程，外加另一份約 200 MB 的 HF 資產
要託管與維護；買到的是一個**非串流的批次引擎**。但批次這格已經有 MOSS（雲端），而「本機、準確率
勝過 Vosk small」這格 Whisper small 已經站著了。它唯一補的洞其實沒有空著，投入與回報不成比例。
哪天 Whisper 在批次品質上真的不夠用，再回來看這條。

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
