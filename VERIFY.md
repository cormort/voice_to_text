# 待人工驗證清單

最後更新：2026-10-25

這份文件只放**自動化測不到、必須有人開真的瀏覽器按一次**的項目。
每一項都寫清楚「為什麼測不到、怎麼做、通過標準是什麼、目前狀態」，避免下次有人
以為它已經驗過，或以為它壞了。

> 現在有 19 支 Node 測試在 CI 跑（`node test_*.js`），另外兩支需要 `PW_MODULE`
> 的（`test_speech_perf.js`、`test_worker_fallback.js`）本來就不在 CI。
> 下面這些是連那兩支都蓋不到的部分。

---

## 1. 浮動字幕窗（Document PiP）— **未驗證**

| | |
| --- | --- |
| 為什麼測不到 | `documentPictureInPicture.requestWindow()` 需要**真實使用者手勢**（transient activation）。程式呼叫 `element.click()` 沒有這個授權，會直接丟 `NotAllowedError`。headless Chrome 沒有視窗管理員，in-app browser 完全打不開 PiP 視窗。 |
| 怎麼做 | 用**實機 Chrome**（非 headless、非 in-app）開 <https://cormort.github.io/voice_to_text/>，選一個引擎並載入模型，勾「翻譯」，按「**浮動字幕窗**」。 |
| 通過標準 | ① 彈出一個獨立的小視窗；② 視窗裡有字幕條（譯文大字、原文小字），而且與主視窗同步更新；③ 主視窗的頁內字幕條會收起來；④ 關掉浮動視窗後，主視窗的字幕條**自己回來**（`subtitleTargets()` 的收尾邏輯）。 |
| 目前狀態 | 程式路徑已實作、失敗時的退路（toast + 頁內字幕條）已驗。2026-10-25 實機使用時踩到 ④ 失敗（關過一次浮動窗，主視窗字幕就不見），已修（主字幕條改成只用 `hidden` 控制），並以 popup 代替 PiP 的 headless 腳本驗過開關兩輪；**修正後尚待實機再按一次**。 |
| 已知風險 | 若拿不到 `documentPictureInPicture.window`，`subtitleTargets()` 會把它當成「已關閉」並恢復頁內字幕條（這條有寫在程式裡，但沒有實機走過）。 |

---

## 2. Safari — **未驗證**

| | |
| --- | --- |
| 為什麼測不到 | 手上只有 Windows Chrome；Safari 沒有可用的自動化環境。 |
| 預期行為 | Safari 忽略 `Cross-Origin-Embedder-Policy: credentialless` → **不會**進入 cross-origin isolated → Underdog 固定單執行緒（狀態列會顯示 `×1`，`?debug=storage` 顯示 `❌ 未隔離`）。功能應完全正常，只是 RTF 約 0.85（慢 2–3 倍）。首次載入仍會多一次重整（Safari 有 Service Worker，重整無害）。 |
| 怎麼做 | macOS / iOS Safari 開站台，看三件事：① 頁面正常載入（沒有白畫面）；② 任一引擎（建議 Vosk 或 sherpa）能載入並辨識；③ 狀態列顯示 `×1` 而不是報錯。 |
| 通過標準 | 功能正常、`?debug=storage` 的隔離欄位顯示 ❌（預期如此，不是 bug）。 |
| 目前狀態 | 未測。**不要把 `❌ 未隔離` 當成故障回報。** |

---

## 3. 手機（執行緒數與熱降頻）— **未驗證**

| | |
| --- | --- |
| 為什麼測不到 | 桌面 Chrome 的 6 核心不代表手機；手機核心少、又會熱降頻，11 秒的 clip 看不出來。 |
| 怎麼做 | 用要帶去會場的那支手機開站台 → 載入 Underdog → 播一段 **3–5 分鐘**的英文音檔，看狀態列的 `×N` 與 `__sttMetrics` 的 RTF。 |
| 通過標準 | RTF < 1（追得上即時）；若 > 1，代表該手機不適合跑 Underdog 即時字幕，改用 sherpa 或 Whisper tiny。 |
| 目前狀態 | 完全沒量。`pickThreads()` 會依 `hardwareConcurrency` 降執行緒，但**沒有任何實機數字**。 |

---

## 4. OPFS 續傳的「真的斷一次」— **只在 headless 驗過**

| | |
| --- | --- |
| 為什麼要人工 | `test_opfs.js` 用假 store 驗邏輯；真要確認「關頁／當掉之後還接得回去」，得在實機把下載打斷。 |
| 怎麼做 | 開 `?opfs=1` → 載入 Underdog（431.9 MB）→ 進度到一半時**直接關掉分頁**（或關掉整個 Chrome）→ 重開同一頁、再按載入 → 觀察進度條是否從斷點接下去。 |
| 通過標準 | 進度不是從 0 開始；`?debug=storage` 的「OPFS 模型」看得到半套檔案，完成後是 431.9 MB；警告紀錄裡有一行「從 xxx MB 續傳」。 |
| 目前狀態 | 邏輯與 sync-access-handle 的寫入都已驗（worker 被 terminate 的測試也在 `test_opfs.js`），但**沒有在真的關頁情境走過**。 |

---

## 已經自動化守住、不需要人工做的

以下這些以前需要人看，現在 CI 會紅：

- 隔離標頭、一次重整、執行緒數選擇 → `test_isolation.js`（16 項）
- OPFS 續傳／換來源／損壞重來 → `test_opfs.js`（9 項）
- worker 警告是否進得了 UI、去重與否 → `test_warnings.js`（8 項）
- 診斷頁的配額／OPFS 可寫／快取統計 → `test_storage_debug.js`（8 項）
- 引擎介面一致性（批次／串流共用外殼） → `test_engines.js`
- 逐字稿在重新載入後還在 → `test_persist.js`

## 這份文件什麼時候要改

- 任何一項驗完 → 把狀態改成「已驗證（日期、機器、瀏覽器版本）」。
- 新增一項需要人工的事 → 先寫進來再開工，不要只留在 PR 描述或對話裡。
- 若某一項開始能被 CI 覆蓋 → 移到「已經自動化守住」那個區塊，並把測試名稱寫上。
