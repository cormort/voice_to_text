# needle/ —— Whistle 的 WASM 引擎（第三方檔案，未修改）

這裡放的是 **Cactus Compute 的 needle 引擎**，用來跑 Whistle 語音模型（`.cact`）。
兩支檔案都是官方發佈的原始檔，沒有改過任何一個位元組。

| 檔案 | 大小 | 來源 |
| --- | --- | --- |
| `needle.js` | 63 KB | <https://huggingface.co/Cactus-Compute/needle3/resolve/main/wasm/needle.js> |
| `needle.wasm` | 923 KB | <https://huggingface.co/Cactus-Compute/needle3/resolve/main/wasm/needle.wasm> |

- 引擎原始碼：<https://github.com/cactus-compute/needle>（Apache-2.0）
- 模型（`whistle.cact`，16.9 MB，Apache-2.0）**沒有**放進 repo，由瀏覽器在首次使用時
  從 <https://huggingface.co/Cactus-Compute/whistle> 下載並存進 Cache Storage。

## 為什麼自己託管引擎、卻把模型留在 HF

引擎是同源的靜態檔（放進 `sw.js` 的 `ASSETS` → 離線可用、不受 CDN 政策影響），
模型則是一次性的大檔（16.9 MB），留在 HF 上讓有需要的人可以自行換版本或自架。

## 更新版本時

```sh
curl -sL -o needle/needle.js   https://huggingface.co/Cactus-Compute/needle3/resolve/main/wasm/needle.js
curl -sL -o needle/needle.wasm https://huggingface.co/Cactus-Compute/needle3/resolve/main/wasm/needle.wasm
shasum -a 256 needle/needle.js needle/needle.wasm
```

換引擎檔要**一起升 `sw.js` 的 `CACHE` 版號**，否則既有使用者的 Service Worker 會繼續
以 cache-first 供給舊檔（與 `whistle-worker.js` 同一條規則，見 README）。
