// 大檔下載的共用實作：Range 分段抓、逐段重試、不支援 Range 就退回單次串流。
//
// 為什麼要獨立一支：sherpa 的 189.8 MB `.data`、Whistle 的 16.9 MB `.cact`、
// Underdog 的 431.9 MB 外部權重、以及 Vosk 的 zip，全部走同一套「分段 + 進度」邏輯。
// 原本 `fetchRange`／`downloadInChunks`／`streamWhole` 寫在 app.js，四顆引擎都靠它，
// 但沒沒一個地方說得清楚它們的契約。搬到這裡之後：
//   * 契約集中（失敗重試幾次、進度怎麼回報、Range 不支援時怎麼辦）
//   * Phase 3 要換成 OPFS 續傳時，只需要改這一個檔
//   * 測試可以直接 import（不再從 HTML 刮原始碼）
//
// 進度回呼固定是 `onProgress(loadedBytes, totalBytes)`；`total` 可能是 0
// （伺服器沒給 Content-Length），呼叫端要能處理「不知道總量」的情況。

/** 一次 Range 請求的大小。太小→請求數暴增；太大→中斷一次重抓的成本高。 */
export const CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * 抓 [start, end] 這段位元組（含頭含尾），失敗會退避重試。
 * 只有 206 才算成功 —— 200 代表伺服器忽略了 Range，那會讓分段邏輯悄悄退化成
 * 每次都抓整份（曾經因此多下載了幾百 MB）。
 */
export async function fetchRange(url, start, end, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (response.status !== 206) throw new Error(`expected 206, got ${response.status}`);
      return await response.arrayBuffer();
    } catch (error) {
      if (attempt >= attempts) throw error;
      // 退避後重試：慢速線路上大檔很容易被中斷，重來一段比重來整份便宜
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

/** 不支援 Range 時的退路：一次串流讀完，逐塊回報進度。 */
export async function streamWhole(url, onProgress = () => {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);

  const total = Number(response.headers.get('Content-Length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * 下載整份檔案。先探測伺服器支不支援 Range：
 *   支援 → 依 CHUNK_BYTES 分段抓（每段各自重試）
 *   不支援 → 退回 streamWhole
 * ponytail: 段落只存在記憶體，重整頁面仍會從頭開始；跨重整續傳留給 Phase 3 的 OPFS。
 */
export async function downloadInChunks(url, onProgress = () => {}) {
  const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (!probe.ok) throw new Error(`${probe.status}: ${url}`);

  const contentRange = probe.headers.get('Content-Range');
  const total = probe.status === 206 && contentRange
    ? Number(contentRange.split('/')[1])
    : 0;

  if (!total) return streamWhole(url, onProgress);

  const bytes = new Uint8Array(total);
  let loaded = 0;

  for (let start = 0; start < total; start += CHUNK_BYTES) {
    const end = Math.min(start + CHUNK_BYTES, total) - 1;
    const part = await fetchRange(url, start, end);
    bytes.set(new Uint8Array(part), start);
    loaded += part.byteLength;
    onProgress(loaded, total);
  }

  return bytes;
}

/**
 * 進度文字的共同格式。各引擎的文案不同（「正在下載模型」／「Downloading model」），
 * 但 MB 與百分比的小數位、分隔符號應該長得一樣，否則同一個站上會出現兩種樣子。
 */
export function formatProgress(loaded, total, label = '') {
  const mb = n => (n / 1048576).toFixed(1);
  const prefix = label ? `${label} ` : '';
  if (!total) return `${prefix}${mb(loaded)} MB`;
  return `${prefix}${mb(loaded)} / ${mb(total)} MB（${(loaded / total * 100).toFixed(1)}%）`;
}
