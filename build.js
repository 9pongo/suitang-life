// 打包：node build.js → dist/index.html（引擎與資料內嵌成單一頁面）
// 打包前先跑一次靜態檢查；資料有錯就不產出。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

try {
  execFileSync(process.execPath, [path.join(__dirname, 'sim.js'), '2000'], { stdio: 'inherit' });
} catch (e) {
  console.error('稽核沒過，停止打包。');
  process.exit(1);
}

const { data } = require('./load.js').loadData();
const UI = data.strings.ui;
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const fill = (s) => String(s || '').replace('{EVENTS}', data.events.length).replace('{ENDINGS}', data.endings.filter((e) => !e.fallback).length);
const engine = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');

const json = JSON.stringify(data).replace(/</g, '\\u003c');
// 版本號：建置日期＋git 提交號（工作目錄有未提交的修改就加「+」）。玩家回饋時附上，才知道是哪一版
function buildId() {
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台灣時間的日期
  try {
    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'engine.js', 'ui.html', 'data'], { cwd: __dirname }).toString().trim();
    return `${day} ${hash}${dirty ? '+' : ''}`;
  } catch (e) { return day; }
}
const BUILD = buildId();
const html = ui
  .replace('/*__ENGINE__*/', () => engine.replace(/<\/script/gi, '<\\/script'))
  .replace('/*__DATA__*/', () => json)
  .replace(/__TITLE__/g, () => attr(UI.title))
  .replace(/__PREFIX__/g, () => UI.storagePrefix)
  .replace(/__BUILD__/g, () => BUILD);

// 頁面裡的每一段腳本先編譯一次：有語法錯誤就不產生檔案，免得發佈出一個打不開的頁面
const vm = require('vm');
for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
  try { new vm.Script(m[1]); } catch (err) {
    console.error(`頁面腳本有語法錯誤：${err.message}`);
    process.exit(1);
  }
}

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
// 開頭宣告 UTF-8：直接用本機伺服器打開 index.html 時，瀏覽器才不會用錯編碼變成亂碼
fs.writeFileSync(path.join(__dirname, 'dist', 'index.html'), '<meta charset="utf-8">\n' + html, 'utf8');
// 本機預覽用：補上發佈平台會自動加的外殼（doctype、charset、viewport）
// 這也是 GitHub Pages 的首頁：分享連結時，聊天軟體會讀 <head> 裡的標題、簡介和封面圖
const SITE = UI.site || '';
const desc = attr(fill(UI.desc));
// 封面圖：有 assets/cover.png 才寫進分享資訊
const coverSrc = path.join(__dirname, 'assets', 'cover.png'); // 1200×630，由 node assets/cover.js 產生
const cover = fs.existsSync(coverSrc);
if (cover) fs.copyFileSync(coverSrc, path.join(__dirname, 'dist', 'cover.png'));
const icon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="6" fill="#9a2f22"/><text x="32" y="47" font-size="44" text-anchor="middle" fill="#f0eee2" font-family="serif" font-weight="900">' + attr(UI.icon) + '</text></svg>');
const head = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  `<title>${attr(UI.title)}</title>`,
  `<meta name="description" content="${desc}">`,
  '<meta property="og:type" content="website">',
  `<meta property="og:title" content="${attr(UI.ogTitle || UI.title)}">`,
  `<meta property="og:description" content="${desc}">`,
  `<meta property="og:url" content="${SITE}">`,
  cover ? `<meta property="og:image" content="${SITE}cover.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">` : '',
  `<link rel="icon" href="${icon}">`,
].join('');
fs.writeFileSync(path.join(__dirname, 'dist', 'dev.html'),
  '<!doctype html><html lang="zh-Hant"><head>' + head + '</head><body>' + html + '</body></html>', 'utf8');
console.log(`dist/index.html：${data.events.length} 張事件卡、${data.endings.length} 種結局、${(html.length / 1024).toFixed(0)} KB，版本 ${BUILD}`);
