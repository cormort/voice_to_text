// 逐字稿的本機保存：重新整理、分頁被手機回收、瀏覽器當掉之後都還能還原。
//
// 為什麼是 localStorage 而不是 IndexedDB：一場 90 分鐘的會議約 1–2 萬字（< 200 KB），
// 遠低於 5 MB 配額；同步 API 也讓 pagehide 時的最後一次寫入一定來得及。
// 這裡只放純函式（序列化／還原），寫入時機與節流在 app.js。

const TRANSCRIPT_KEY = 'stt-transcript';
const TRANSCRIPT_VERSION = 1;

function serializeTranscript(start, segments) {
  return JSON.stringify({
    v: TRANSCRIPT_VERSION,
    start: start ? start.toISOString() : null,
    segments: segments.map(s => {
      const out = { t: s.time.toISOString(), text: s.text };
      if (s.zh) out.zh = s.zh;
      return out;
    }),
  });
}

// 壞掉、舊版或空的資料一律回 null：還原失敗只代表「從空白開始」，不能讓 App 起不來
function restoreTranscript(raw) {
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || data.v !== TRANSCRIPT_VERSION || !Array.isArray(data.segments)) return null;
  const segments = [];
  for (const s of data.segments) {
    const time = new Date(s && s.t);
    if (!s || typeof s.text !== 'string' || !s.text || Number.isNaN(time.getTime())) continue;
    const segment = { time, text: s.text };
    if (typeof s.zh === 'string' && s.zh) segment.zh = s.zh;
    segments.push(segment);
  }
  if (!segments.length) return null;
  const start = data.start ? new Date(data.start) : null;
  return { start: start && !Number.isNaN(start.getTime()) ? start : segments[0].time, segments };
}

export { TRANSCRIPT_KEY, serializeTranscript, restoreTranscript };
