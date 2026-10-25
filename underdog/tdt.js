// Underdog Bark 3.0 的貪心 TDT 解碼。逐行對照匯出端的 export/tdt.py：
//
//   t = 0、last = blank，state 歸零
//   每一步：token_logits 取 argmax、duration_logits 取 argmax → durations[argmax]
//     token == blank → 前進 max(dur, 1)，state 不動
//     否則輸出 token、前進 dur（0 代表留在同一格）、state 換成 *_out
//
// 匯出圖的形狀（fp32/fp16/q8/q4f16 四種變體完全一致）：
//   encoder: input_features f32 [B,T,128]、attention_mask i64 [B,T]
//            → encoder_outputs f32 [B,T',640]（8 倍降採樣）、encoder_lengths i64 [B]
//   decoder_joint: encoder_outputs f32 [B,1,640]、input_ids i64 [B,1]、state_h/state_c f32 [2,B,640]
//            → token_logits f32 [B,8193]、duration_logits f32 [B,5]、state_h_out、state_c_out
//
// 這些常數是 config.json 的值，載入時會用實際的圖輸出來驗一次（見 checkShapes）。

export const GEN = {
  vocab: 8193,
  blank: 8192,
  eos: 3,
  durations: [0, 1, 2, 3, 4],
  hidden: 640,
  layers: 2,
  maxSymbolsPerStep: 10,
};

export function checkShapes(encoderSession, decoderSession, gen = GEN) {
  const encIn = encoderSession.inputNames, encOut = encoderSession.outputNames;
  const decIn = decoderSession.inputNames, decOut = decoderSession.outputNames;
  const want = {
    encIn: ['input_features', 'attention_mask'], encOut: ['encoder_outputs', 'encoder_lengths'],
    decIn: ['encoder_outputs', 'input_ids', 'state_h', 'state_c'],
    decOut: ['token_logits', 'duration_logits', 'state_h_out', 'state_c_out'],
  };
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const problems = [];
  if (!eq(encIn, want.encIn)) problems.push(`encoder inputs ${encIn.join(',')}`);
  if (!eq(encOut, want.encOut)) problems.push(`encoder outputs ${encOut.join(',')}`);
  if (!eq(decIn, want.decIn)) problems.push(`decoder inputs ${decIn.join(',')}`);
  if (!eq(decOut, want.decOut)) problems.push(`decoder outputs ${decOut.join(',')}`);
  if (problems.length) throw new Error(`不是 Underdog Bark 3.0 的 ONNX 圖：${problems.join('；')}`);
  if (gen.durations.length !== 5) throw new Error('durations 必須是 5 個');
  return true;
}

const argmax = data => {
  let best = 0, bv = data[0];
  for (let i = 1; i < data.length; i++) if (data[i] > bv) { bv = data[i]; best = i; }
  return best;
};

/**
 * ort：onnxruntime 的 module（只用 Tensor）；session：decoder_joint。
 * enc：Float32Array，[1, encLen, 640] 的連續記憶體。
 * 回傳 { tokens, durations, steps }；tokens 含 blank，與 generate() 的 sequences 一致。
 */
export async function greedyTdt(ort, session, enc, encLen, gen = GEN) {
  const H = gen.hidden, Ld = gen.layers;
  const h = new Float32Array(Ld * H), c = new Float32Array(Ld * H);
  const toks = [], durs = [];
  const maxSteps = gen.maxSymbolsPerStep * encLen - 1;
  const ids = new BigInt64Array(1);
  let last = gen.blank, t = 0;

  while (t < encLen && toks.length < maxSteps) {
    ids[0] = BigInt(last);
    const out = await session.run({
      encoder_outputs: new ort.Tensor('float32', enc.slice(t * H, (t + 1) * H), [1, 1, H]),
      input_ids: new ort.Tensor('int64', ids.slice(), [1, 1]),
      state_h: new ort.Tensor('float32', h.slice(), [Ld, 1, H]),
      state_c: new ort.Tensor('float32', c.slice(), [Ld, 1, H]),
    });
    const tok = argmax(out.token_logits.data);
    let d = gen.durations[argmax(out.duration_logits.data)];
    if (tok === gen.blank) {
      d = Math.max(d, 1);                       // blank always advances
    } else {
      last = tok;
      h.set(out.state_h_out.data);
      c.set(out.state_c_out.data);
    }
    toks.push(tok); durs.push(d); t += d;
    if (tok === gen.eos) break;
  }
  return { tokens: toks, durations: durs, steps: toks.length };
}

// tokenizer.json 的 model.vocab 是 {piece: id}；這裡只需要 id → piece。
export function piecesFromTokenizer(tokenizer) {
  const pieces = [];
  for (const [piece, id] of Object.entries(tokenizer.model.vocab)) pieces[id] = piece;
  return pieces;
}

// 與 tdt.py 的 detokenize 相同：跳過 blank 與 <...> 這類特殊符號，▁ 換成空格。
export function detokenize(ids, pieces, blank = GEN.blank) {
  let s = '';
  for (const id of ids) {
    if (id === blank) continue;
    const piece = pieces[id];
    if (piece === undefined) continue;
    if (piece.length > 1 && piece.startsWith('<') && piece.endsWith('>')) continue;
    s += piece;
  }
  return s.replace(/\u2581/g, ' ').trim();
}
