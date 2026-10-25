// 模型權重的本機儲存：OPFS（Origin Private File System）。
//
// 為什麼不用 Cache Storage（原本的做法）：430 MB 的權重要先在 JS 記憶體裡組完才能
// `cache.put`，中斷一次就整份重來，而且沒辦法知道「已經抓了多少」。OPFS 可以
// **分段寫入指定位置**，所以下載被打斷（關頁、斷網、當掉）之後，下一次從已寫入的
// 位元組繼續，不必重抓 430 MB。
//
// 這一支刻意把「儲存」與「Fetcher」都做成可注入，於是 Node 測試可以拿假 store／
// 假 fetch 驗續傳邏輯，不必開瀏覽器。

/**
 * 一次 Range 請求的大小。
 * 為什麼是 32 MB：432 MB 的權重若用 8 MB 分段要 54 次「請求＋寫入＋flush」，
 * 每次都有固定成本（實測首次載入因此從 27 s 退到 ~105 s）。放大到 32 MB 只要 14 次。
 * 太大的代價是「中斷時最多重抓一段」，32 MB 在慢速線路上還算合理。
 */
export const CHUNK_BYTES = 32 * 1024 * 1024;

// ── 檔名：同一個檔名可能來自不同網址 ─────────────────────────────────────
// 以前 key 只有「prefix/檔名」：換「資產位置」到另一個 repo／鏡像（檔名相同）時，
// 舊檔會被當成同一份而續傳，拼出新舊混雜的壞檔。網址雜湊放進檔名就不會撞。
/** FNV-1a 32-bit，回 8 位十六進位。不是密碼學用途，只要「不同網址 → 不同檔名」。 */
export function urlHash(url) {
  let h = 0x811c9dc5;
  const text = String(url);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** `prefix/<網址雜湊>-<label>`，例：`underdog/1a2b3c4d-encoder_model_q4f16.onnx_data` */
export function opfsKey(prefix, url, label) {
  return `${prefix}/${urlHash(url)}-${label}`;
}

/** 每個檔案旁邊的來源紀錄（網址、總大小、ETag），用來判斷「已寫入的前段還能不能接」 */
export const metaKeyOf = key => `${key}.meta`;

// ── 真實的 OPFS store ────────────────────────────────────────────────────
export async function opfsAvailable() {
  try {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  } catch {
    return false;
  }
}

async function modelsDir(create = true) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('models', { create });
}

async function fileHandle(key, create = true) {
  // 把 `a/b` 這樣的 key 變成巢狀目錄，避免所有檔案擠在同一層
  const parts = String(key).split('/').filter(Boolean);
  const name = parts.pop();
  let dir = await modelsDir(create);
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
  return dir.getFileHandle(name, { create });
}

export const opfsStore = {
  async size(key) {
    try {
      const handle = await fileHandle(key, false);
      return (await handle.getFile()).size;
    } catch {
      return 0;                       // 不存在
    }
  },
  async read(key) {
    try {
      const handle = await fileHandle(key, false);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch {
      return null;
    }
  },
  /**
   * 開一個可續寫的 writer，新資料一律接在檔案現有內容後面。
   *
   * 首選 createSyncAccessHandle（只有 dedicated worker 有）：每段寫完就 flush，
   * 位元組**直接落在檔案裡** —— 關頁、當掉之後，下次真的能從斷點接。
   * createWritable 是寫進暫存檔、close() 才整份換上去：分頁被關時 close 沒跑，
   * 這一輪寫的全部消失；所以它只當退路（主執行緒、舊瀏覽器、診斷頁的 1 MiB 探測）。
   * 順帶：close() 時把 432 MB 暫存檔搬回原檔，也是首次載入慢的原因之一。
   */
  async openWriter(key) {
    const handle = await fileHandle(key, true);
    if (typeof handle.createSyncAccessHandle === 'function') {
      let access = null;
      try {
        access = await handle.createSyncAccessHandle();
      } catch {
        access = null;                  // 例如在主執行緒：退回 createWritable
      }
      if (access) {
        let at = access.getSize();
        return {
          write: async data => {
            const view = data instanceof Uint8Array ? data : new Uint8Array(data);
            let done = 0;
            while (done < view.length) done += access.write(view.subarray(done), { at: at + done });
            at += view.length;
            access.flush();             // 這一段落地：之後就算分頁被關，下次也從這裡接
          },
          close: async () => { try { access.flush(); } finally { access.close(); } },
          abort: async () => { try { access.close(); } catch { /* 已經關了 */ } },
        };
      }
    }
    const writable = await handle.createWritable({ keepExistingData: true });
    return {
      // 只追加、不指定位置：續傳的情境一定是「已經有前段、往後接」，
      // 用 append 比 position 少一個出錯的地方（position 忘了帶就默默覆蓋開頭）。
      write: data => writable.write({ type: 'write', data }),
      close: () => writable.close(),
      abort: async () => { try { await writable.abort(); } catch { /* 已經關了 */ } },
    };
  },
  async readText(key) {
    try {
      const handle = await fileHandle(key, false);
      return await (await handle.getFile()).text();
    } catch {
      return null;
    }
  },
  async writeText(key, text) {
    const handle = await fileHandle(key, true);
    const writable = await handle.createWritable();     // 不保留舊內容：整份覆寫
    await writable.write(text);
    await writable.close();
  },
  async remove(key) {
    try {
      const parts = String(key).split('/').filter(Boolean);
      const name = parts.pop();
      let dir = await modelsDir(false);
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: false });
      await dir.removeEntry(name);
      return true;
    } catch {
      return false;
    }
  },
  async list() {
    const out = [];
    async function walk(dir, prefix) {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') { await walk(handle, `${prefix}${name}/`); continue; }
        const file = await handle.getFile();
        out.push({ key: `${prefix}${name}`, size: file.size });
      }
    }
    try { await walk(await modelsDir(false), ''); } catch { /* 還沒有目錄 */ }
    return out;
  },
};

// ── 可續傳的下載 ─────────────────────────────────────────────────────────
function rangeFetcher(fetchImpl) {
  return async (url, start, end, attempts = 4) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` } });
        if (response.status !== 206) throw new Error(`expected 206, got ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (attempt >= attempts) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));   // 退避
      }
    }
  };
}

/**
 * 下載一整份檔案到 store（預設 OPFS），支援「上次中斷就從斷點續傳」。
 *
 * 已寫入的前段只有在「同一個網址、同一個總大小、同一個 ETag」時才會接著用；
 * 任何一項對不上（伺服器換了檔、舊版沒有來源紀錄）都從 0 重抓，`restarted` 為 true。
 * store 沒有 readText／writeText 時不做來源檢查（相容舊的假 store）。
 *
 * @returns {Promise<{bytes: Uint8Array, fromCache: boolean, resumedFrom: number, restarted: boolean}>}
 */
export async function downloadResumable(url, key, {
  store = opfsStore,
  fetchImpl = (...args) => fetch(...args),
  onProgress = () => {},
  chunkBytes = CHUNK_BYTES,
} = {}) {
  const range = rangeFetcher(fetchImpl);

  // 1) 先探測總大小（Range 0-0 不會付整份的代價）
  const probe = await fetchImpl(url, { headers: { Range: 'bytes=0-0' } });
  if (!probe.ok) throw new Error(`${probe.status}: ${url}`);
  const contentRange = probe.headers.get('Content-Range');
  const total = probe.status === 206 && contentRange ? Number(contentRange.split('/')[1]) : 0;
  if (!total) throw new Error('伺服器不支援 Range，無法續傳');
  // HF 的 206 回應有 ETag（CORS 有開放讀取）；弱 ETag 的 W/ 前綴不影響「是不是同一份」
  const etag = (probe.headers.get('ETag') || '').replace(/^W\//, '');

  // 2) 來源檢查：已寫入的前段是不是「這一份」檔案的前段
  const tracksSource = typeof store.readText === 'function' && typeof store.writeText === 'function';
  let size = await store.size(key);
  let restarted = false;
  if (tracksSource && size > 0) {
    let meta = null;
    try { meta = JSON.parse((await store.readText(metaKeyOf(key))) || 'null'); } catch { meta = null; }
    const same = !!meta && meta.url === url && meta.total === total && (meta.etag || '') === etag;
    if (!same) {
      await store.remove(key);
      size = 0;
      restarted = true;
    }
  }

  // 3) 已經抓完就直接讀回來（第二次載入模型不再碰網路）
  if (size === total) {
    onProgress(total, total);
    const cached = await store.read(key);
    if (cached) return { bytes: cached, fromCache: true, resumedFrom: total, restarted };
  }
  // 4) 大小比總量還大（上次寫壞）→ 砍掉重來；比總量小 = 上次中斷，續傳
  let offset = 0;
  if (size > total) {
    await store.remove(key);
    size = 0;
    restarted = true;
  } else if (size > 0) {
    offset = size;
  }
  // 先寫來源紀錄再寫資料：資料寫到一半就被中斷時，下次才認得出這是同一份
  if (tracksSource) await store.writeText(metaKeyOf(key), JSON.stringify({ url, total, etag }));

  const writer = await store.openWriter(key);
  try {
    while (offset < total) {
      const end = Math.min(offset + chunkBytes, total) - 1;
      const part = await range(url, offset, end);
      await writer.write(part, offset);            // 指定位置寫入（續傳時前段已在檔案裡）
      offset += part.length;
      onProgress(offset, total);
    }
    await writer.close();
  } catch (error) {
    // 用 close 而不是 abort：abort 會丟掉已寫入的內容，續傳就白費了
    try { await writer.close(); } catch { /* 已經關了 */ }
    throw error;
  }

  // 直接從 store 讀一次，而不是把每段留在記憶體再複製成 total 大小：
  // 432 MB 的檔案這樣可以省掉一份完整的 Uint8Array（峰值少 432 MB），
  // 而且續傳與全新下載走同一條路，不用兩個分支。
  const bytes = await store.read(key);
  if (!bytes || bytes.length !== total) throw new Error('寫入後的檔案不完整，請重新下載');
  return { bytes, fromCache: false, resumedFrom: size > 0 && size < total ? size : 0, restarted };
}
