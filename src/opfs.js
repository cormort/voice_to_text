// 模型權重的本機儲存：OPFS（Origin Private File System）。
//
// 為什麼不用 Cache Storage（原本的做法）：430 MB 的權重要先在 JS 記憶體裡組完才能
// `cache.put`，中斷一次就整份重來，而且沒辦法知道「已經抓了多少」。OPFS 可以
// **分段寫入指定位置**，所以下載被打斷（關頁、斷網、當掉）之後，下一次從已寫入的
// 位元組繼續，不必重抓 430 MB。
//
// 這一支刻意把「儲存」與「Fetcher」都做成可注入，於是 Node 測試可以拿假 store／
// 假 fetch 驗續傳邏輯，不必開瀏覽器。

/** 一次 Range 請求的大小。與 src/download.js 的 CHUNK_BYTES 對齊。 */
export const CHUNK_BYTES = 8 * 1024 * 1024;

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
  /** 開一個可續寫的 writer：keepExistingData 讓新資料接在已寫入的內容後面 */
  async openWriter(key) {
    const handle = await fileHandle(key, true);
    const writable = await handle.createWritable({ keepExistingData: true });
    return {
      // 只追加、不指定位置：續傳的情境一定是「已經有前段、往後接」，
      // 用 append 比 position 少一個出錯的地方（position 忘了帶就默默覆蓋開頭）。
      write: data => writable.write({ type: 'write', data }),
      close: () => writable.close(),
      abort: async () => { try { await writable.abort(); } catch { /* 已經關了 */ } },
    };
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
 * @returns {Promise<{bytes: Uint8Array, fromCache: boolean, resumedFrom: number}>}
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

  // 2) 已經抓完就直接讀回來（第二次載入模型不再碰網路）
  const size = await store.size(key);
  if (size === total) {
    onProgress(total, total);
    const cached = await store.read(key);
    if (cached) return { bytes: cached, fromCache: true, resumedFrom: total };
  }
  // 3) 大小比總量還大（伺服器換檔或上次寫壞）→ 砍掉重來；比總量小 = 上次中斷，續傳
  let offset = 0;
  if (size > total) {
    await store.remove(key).catch(() => {});
  } else if (size > 0) {
    offset = size;
  }

  const chunks = [];
  const writer = await store.openWriter(key);
  try {
    while (offset < total) {
      const end = Math.min(offset + chunkBytes, total) - 1;
      const part = await range(url, offset, end);
      await writer.write(part);                    // 追加；前段已經在檔案裡
      chunks.push(part);
      offset += part.length;
      onProgress(offset, total);
    }
    await writer.close();
  } catch (error) {
    // 用 close 而不是 abort：abort 會丟掉已寫入的內容，續傳就白費了
    try { await writer.close(); } catch { /* 已經關了 */ }
    throw error;
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }

  // 續傳的情況：前面的部分不在這次的 chunks 裡，要從 store 補回來
  if (at !== total) {
    const cached = await store.read(key);
    if (!cached || cached.length !== total) throw new Error('續傳後的檔案不完整，請重新下載');
    return { bytes: cached, fromCache: false, resumedFrom: size };
  }
  return { bytes, fromCache: false, resumedFrom: size > 0 && size < total ? size : 0 };
}
