// 測試用的「站台原始碼」讀取器。
//
// 2026-10 之後程式分成 index.html（版面）＋ src/*.js（邏輯與文案），
// 這些測試在意的是「行為有沒有接上」，不是某一行住在哪個檔案 ——
// 所以一律把 index.html 與 src/ 底下所有 .js 串起來再比對。
// 這樣之後再把程式拆成 src/engines/* 時，測試不用跟著改。
'use strict';

const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

module.exports = function readSite() {
  const root = __dirname;
  const files = [path.join(root, 'index.html'), ...walk(path.join(root, 'src'))];
  // 一律正規化成 LF：這台機器上有些檔案是 CRLF（git autocrlf）、有些是 LF（工具直接寫入），
  // 而測試會用 `\n  }\n` 這種樣式刮函式原始碼 —— 混用時會抓過頭、跨檔案抓到別的 export，
  // 出現「CI 綠、本機紅」的假失敗。正規化之後兩邊看到同一份文字。
  return files
    .map(file => `// ==== ${path.relative(root, file)} ====\n${fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')}`)
    .join('\n');
};

module.exports.files = function files() {
  const root = __dirname;
  return [path.join(root, 'index.html'), ...walk(path.join(root, 'src'))];
};
