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
  return files.map(file => `// ==== ${path.relative(root, file)} ====\n${fs.readFileSync(file, 'utf8')}`).join('\n');
};

module.exports.files = function files() {
  const root = __dirname;
  return [path.join(root, 'index.html'), ...walk(path.join(root, 'src'))];
};
