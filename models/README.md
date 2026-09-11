# models/ — 執行時資產（不是備份，請勿刪除）

這裡的 ZIP 是「網站內建模型」功能的資料來源，由 `index.html` 以相對路徑直接載入，
不是暫存檔、也不是備份。刪掉或改名會讓 Vosk 的「網站內建模型」選項直接 404。

## 內容

| 檔案 | 大小 | 用途 | 上游 | 授權 |
| ---- | ---- | ---- | ---- | ---- |
| `vosk-model-small-cn-0.22.zip` | 43,898,754 bytes（約 42 MiB） | Vosk 中文（簡中輸出，前端會轉繁中） | [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models) | Apache 2.0 |
| `vosk-model-small-en-us-0.15.zip` | 41,205,931 bytes（約 39 MiB） | Vosk 英文 | 同上 | Apache 2.0 |

兩份都是上游原始壓縮檔，未經修改。可用下列指令驗證：

```bash
shasum -a 256 models/*.zip
# vosk-model-small-cn-0.22.zip     3af8b0e7e0f835ae9d414ce5df580237a3cfb08d586c9fbbb0f7ff29ad5b14ba
# vosk-model-small-en-us-0.15.zip  30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498
```

## 為什麼放在 repo 裡

站台是 GitHub Pages，只能服務 repo 內的檔案；而且**同源**是這裡的關鍵：

- `sw.js` 會把同源回應放進 `stt-shell-v1` 快取，所以使用者只在第一次載入模型時下載，
  之後由 Service Worker 直接從本機提供（可離線，也省 Pages 流量）。
- GitHub Pages 對 ZIP 只給 `cache-control: max-age=600`（10 分鐘），沒有 SW 快取的話
  每個工作階段都要重抓約 42 MB。
- 跨網域的來源（例如 Hugging Face）不會經過 Service Worker，體積更大的 sherpa 模型
  (199 MB) 因此是在 App 內自己用專屬的 Cache Storage 管理，而不是靠這裡的機制。

Pages 的軟性流量上限是 100 GB/月，42 MB/次大約是 2,200 次；若之後接近上限，
再考慮把這兩個模型搬到 Hugging Face，並同時替 Vosk 加上跟 sherpa 一樣的專屬快取
（否則會失去 SW 快取與離線能力）。

## 程式碼在哪裡用到

- `index.html` 的 `VOSK_MODELS`：`cn` / `en` → 這兩個檔案的相對路徑
- `index.html` 的 `<select id="voskBuiltinLang">`：選項文字含檔案大小，換模型時要一起改
- 實際載入由 `vosk-browser` 的 `Vosk.createModel()` 負責（模型來源可切換成「本機 ZIP」或「自訂 URL」）

## 更新或新增模型

1. 從上游下載新的 ZIP，放進這個目錄。
2. 更新 `index.html` 的 `VOSK_MODELS` 與選項文字（大小）。
3. **檔名請帶版本號（例如 `-0.23`）**：Service Worker 對同源 GET 是 cache-first，
   如果沿用同一個 URL 換掉內容，回訪者會一直拿到舊模型。改了檔名就等於新的 URL，
   自然會重新下載。
4. 替代做法是把 `sw.js` 的 `CACHE` 版本號往上加（`stt-shell-v1` → `v2`），
   新 SW 啟用時會清掉舊的外殼快取（含舊模型）；但這會讓所有外殼檔案重新下載一次。
   模型專屬快取（`sherpa-onnx-model-v1`、`transformers-cache`）不受影響。

> 注意 `sw.js` 的 `MAX_CACHE_BYTES = 64 MB`：超過這個大小的檔案不會進 Service Worker 快取
> （功能仍正常，只是每次都由瀏覽器 HTTP 快取或重新下載）。目前兩個檔案都在上限內。

## 內網／離線部署

程式碼用的是相對 `models/...` 路徑（讀 `document.baseURI`），所以把整個 `models/` 目錄
一起複製到網站根目錄即可，不需要改任何程式碼。
