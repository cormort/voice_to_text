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
| Whistle | **16.9 MB**（模型）＋ 986 KB（引擎，隨站台） | HF（`Cactus-Compute/whistle`） | `WHISTLE_CACHE`（Cache Storage） |
| Underdog Bark 3.0 | **約 500 MB**（q4f16：權重 431.9 MB＋decoder 66.7 MB＋圖 1.2 MB＋tokenizer 1.1 MB；q8 約 908 MB） | HF（`ai-ecoverse/Underdog-Bark-3.0-ONNX`）＋ jsdelivr 的 onnxruntime-web（約 14 MB，只有選它才會抓） | `UNDERDOG_CACHE`（Cache Storage） |
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
| Underdog | ✅ 真實百分比與 MB | 下載與解碼都在 `underdog-worker.js` 裡，逐檔回報（狀態列會顯示 `正在下載模型 encoder_model_q4f16.onnx_data 268.9 / 431.9 MB（62.3%）`） |
| Whistle | ✅ 真實百分比與 MB | 與 sherpa 同一支 `downloadInChunks`（單一 16.9 MB 檔案，狀態列會顯示 `正在下載模型 8.4 / 16.1 MB（52.1%）`），存進 `WHISTLE_CACHE` |

## Whistle（16.9 MB）—— 已納入，數字與取捨都在這裡

Cactus Compute 的 [Whistle](https://cactuscompute.com/blog/whistle)（Apache-2.0）是**目前本專案
下載量最小的本機引擎**：一顆 16.9 MB 的 `.cact` 檔 + 同源的 986 KB `needle` WASM 引擎
（`needle/needle.js` + `needle/needle.wasm`，進 Service Worker 外殼快取）。
七種語言：英、德、法、西、義、荷、波。**沒有中文。**

### 實測（本機 Node 26 / Chrome，真模型，`test_whistle_engine.js`）

| 音訊長度 | 一次轉寫耗時 | RTF | time to first token |
| --- | --- | --- | --- |
| 3 s | 0.98 s | 0.33 | 368 ms |
| 5 s | 1.36 s | 0.27 | 497 ms |
| 10 s | 2.92 s | 0.29 | 1,015 ms |
| 15 s | 4.57 s | 0.30 | 1,594 ms |
| 20 s | 6.85 s | 0.34 | 2,131 ms |
| 30 s（引擎上限） | 10.62 s | 0.35 | 3,426 ms |

瀏覽器裡（真的 Worker、真的 Service Worker 快取）：引擎初始化 + 模型載入 **58 ms**、
3.03 秒英文音訊轉寫 **947 ms**，逐字稿與詞級時間戳都正確。

### 為什麼用 VAD 分段，而不是引擎內建的串流 API

`needle.h` 有 `needle_stream_transcribe_process`（可選的即時介面），但實測**跟不上即時**：
它每一輪都把整個緩衝重新轉寫，成本隨緩衝成長。餵 1 秒音訊、緩衝 10 秒時單輪要 3.4 秒，
緩衝 30 秒時單輪 1.4–7 秒；36 秒音訊總共花 **113.7 秒（RTF 3.2）**。這不是接線問題，
是那個 API 的設計（區域一致性合議／local agreement）配上 WASM 速度的必然結果。

所以 Whistle 走**與 Whisper 同一套 VAD 分段**（0.8 秒靜音或滿 15 秒切一段），
每段獨立轉寫：成本線性、RTF 約 0.3，代價是字幕比 sherpa 的真串流慢一到兩秒。
定位上兩者互補：**要真串流低延遲（中英）用 sherpa，要極小下載量（歐語）用 Whistle。**

### 引擎檔不預抓（2026-10-10）

`needle.js`（63 KB 原始／18 KB gzip）與 `needle.wasm`（923 KB／342 KB gzip）**不在 `sw.js`
的 `ASSETS` 裡**。它們只有選 Whistle 的人會用到，預抓等於讓每個訪客多付約 360 KB；
兩者都是同源資產，Service Worker 的 fetch handler 會在第一次使用時寫進快取
（實測：用過一次 Whistle 之後 `stt-shell-v6` 就出現 `/needle/needle.js` 與 `/needle/needle.wasm`）。
代價只有「離線後第一次就選 Whistle」，而那本來就不可能 —— 首次使用一定要連網下載 16.9 MB 模型。

### 一個只有真瀏覽器才抓得到的 bug

這份 `needle.js` 建置**沒有** `Module.locateFile` 入口（整支膠水層只有一個內部
`locateFile(path){return scriptDirectory+path}`），Worker 裡的 `scriptDirectory` 取自
`self.location.href` = 站台根目錄，於是它去抓 `<站台根>/needle.wasm`，抓到 HTML 後炸
`Aborted(CompileError: … expected magic word 00 61 73 6d, found 3c 21 44 4f)`（`<!DO`）。
Node 的假 module 測試不會經過路徑推導，所以是**在瀏覽器裡用真 UI 載入模型時才發現**的
（畫面顯示「模型已就緒（主執行緒）」＝ Worker 失敗、退路接手）。修法：兩條路徑都用
`wasmBinary` 把位元組直接餵給引擎，並在 `test_whistle_worker_api.js` 留下回歸斷言。


## Underdog Bark 3.0（約 500 MB）—— 英文最準，但比即時慢

Conway Research 的 [Underdog Bark 3.0](https://huggingface.co/ConwayResearch/Underdog-Bark-3.0)
是 **NVIDIA `parakeet-tdt-0.6b-v3` 的英文微調**（0.6B 參數、CC-BY-4.0），
[ONNX 版](https://huggingface.co/ai-ecoverse/Underdog-Bark-3.0-ONNX) 由 ai-ecoverse 匯出。

### 為什麼不能接 sherpa

這份匯出**不是** sherpa 的 transducer 介面：encoder 吐 `encoder_outputs` f32 `[B,T',640]` 與
`encoder_lengths`，decoder_joint 一步吃一格、要 `state_h`/`state_c`、吐 `token_logits`（8193）
與 `duration_logits`（5 個 duration 0–4）。sherpa 的 NeMo transducer 期待的是另一組名稱與
權重佈局，所以這裡自己走 onnxruntime-web：`underdog/frontend.js`（mel）→ encoder →
`underdog/tdt.js` 的貪心 TDT → SentencePiece 還原。整條鏈路都在 `underdog-worker.js`。

### 實測（桌機 Chrome 155 / 6 核；音訊是官方 fixture 的 2.67 秒英文）

| 項目 | 數字 | 備註 |
| --- | --- | --- |
| mel 前處理 | **44–61 ms** | 與 `fixture/input_features.npy` 的最大差 **9.6e-5**（tdt.py 自己對 torch 的差也是 ~1e-4） |
| encoder（WASM，1 執行緒） | **3.19 s** | RTF **1.19** |
| encoder（WASM，4 執行緒） | **1.61 s** | RTF **0.60** —— 需要 COOP/COEP；2026-10 起由 sw.js 補標頭後**已採用**（見 ARCHITECTURE「跨來源隔離」） |
| decoder_joint | **65 ms / 19 步**（約 3.8 ms/步） | 每步一次 session.run，權重 66.7 MB |
| 端到端 RTF | **約 1.2** | 比即時慢，定位是高準確度批次／段落，不是即時字幕 |
| 首次載入 | **31.6 s**（432 MB 約 22 s @ ~20 MB/s） | 之後由 `UNDERDOG_CACHE` 命中，約 2 s |
| 記憶體峰值 | **約 900 MB** | JS 端 432 MB（要交給 ORT）＋ WASM 堆 432 MB；手機請勿嘗試 |

**正確性**：q4f16 在瀏覽器跑出來、對 fixture 的 token 串流與官方 parity 表裡的 q4f16 完全一致
（`506,8192,363,1413,4870,…`）；Node 的單執行緒路徑則與 PyTorch **token 與 duration 逐項相同**。
文字 `the quick brown fox jumps over the lazy dog` 在兩邊都一致。
量化越重失真越明顯（官方表：q8 只有 4/20 段與 PyTorch 的 token 完全相同、q4f16 是 0/20，
所以**不要**拿 q8/q4f16 的 token 去對 PyTorch，要比的是文字）。

### WebGPU 與它的坑

ORT 1.30 的 WebGPU EP 對這份 q4f16 圖**建出無效的 compute pipeline**（`Add`/`Cast`/`Sigmoid`
全部 `Invalid ComputePipeline`），`encoder_lengths` 回 0、解碼 0 步、輸出空字串。要吃到 GPU
得改用 fp16（1.29 GB）或 fp32（2.5 GB）權重，對「瀏覽器端下載」不現實，所以這個引擎固定在
WASM EP。

### 一個只有真瀏覽器才抓得到的 CSP 坑

`underdog-worker.js` 是 module worker，import jsdelivr 上的 `ort.wasm.min.mjs` —— 那一步
`script-src` 放行就夠（實測在沒有 CSP 的頁面完全正常）。但 ORT 初始化 WASM 時會**再從自己的
模組網址開一個 proxy worker**，那一步受 `worker-src` 管：只寫 `worker-src 'self' blob:` 會讓
整個 worker 建不起來，而失敗訊息是**空的**（`onerror` 的 `event.message` 是 `''`），只有
`Target.setAutoAttach` 進 worker 才看得到
`Creating a worker from 'https://cdn.jsdelivr.net/…/ort.wasm.min.mjs' violates … worker-src`。
現在 `worker-src` 多了 `https://cdn.jsdelivr.net`（本來就在 `script-src` 裡，等於沒有放寬來源）。

### 分段策略

模型本身非串流，所以沿用 Whisper/Whistle 那套 VAD：**0.8 秒靜音或滿 15 秒**送一段。
15 秒是「字幕延遲 vs 長脈絡準確度」的折衷；RTF 1.2 意味著佇列會慢慢落後，因此
`UNDERDOG_MAX_QUEUED = 2`（超過就丟最舊的一段並提示一次）。

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
