// sherpa 一次解碼迴圈（sherpa-onnx 的 recognizer 是同步 API，這裡把它包成
// 「吐一個 hypothesis」的形狀給 src/engines/live.js 用）。
//
// 為什麼要單獨一支：這段有幾個「寫錯會安靜壞掉」的分支 ——
//   * decode 迴圈要跑到 isReady 為 false 才停，少跑一次就少字
//   * endpoint 之後一定要 reset，否則下一句會接著上一句
//   * endpoint 但沒有字（純靜音）仍要 reset，只是不 commit
//   * 換場之後（isActive() 為 false）不可以再寫入字幕
// 這些之前在 app.js 的 sherpaDecode() 裡，只能靠測試刮原始碼來驗；抽出來之後
// test_sherpa_decode.js 直接載入真正的實作。

/**
 * @param {object} args
 *   recognizer — sherpa recognizer（isReady／decode／getResult／isEndpoint／reset）
 *   stream     — createStream() 的結果
 *   emit       — hypothesis => void（{ type: 'partial' | 'final', text }）
 *   isActive   — () => boolean，換場／停止後回 false
 */
export function decodeSherpa({ recognizer, stream, emit, isActive = () => true }) {
  if (!recognizer || !stream || !isActive()) return;

  while (recognizer.isReady(stream)) recognizer.decode(stream);

  const text = (recognizer.getResult(stream)?.text || '').trim();

  if (recognizer.isEndpoint(stream)) {
    recognizer.reset(stream);
    if (text) {
      emit({ type: 'final', text });
      return;
    }
  }
  emit({ type: 'partial', text });
}
