// 封面圖：node assets/cover.js → assets/cover.html，再用無頭 Chrome 截成 assets/cover.png（1200×630）
// 插圖用介面裡同一套山水皮影的畫法；事件卡、結局數照目前的資料算
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'ui.html'), 'utf8').replace(/\r\n/g, '\n');
const { data: DATA } = require('../load.js').loadData();
const UI = DATA.strings.ui;

// 從介面取出插圖模組（只用到純函式 sceneSvg）
const a = ui.indexOf('  // ---------------- 插圖'), b = ui.indexOf('  initSceneToggle();');
const $ = () => null, h = () => null, esc = (x) => x, pref = () => null, PFX = '';
const sceneSvg = eval(ui.slice(a, b) + ';sceneSvg'); // eslint-disable-line no-eval
const css = ui.slice(ui.indexOf('/* ---------- 插圖'), ui.indexOf('.fadein {'));
const rootVars = ui.slice(ui.indexOf(':root {'), ui.indexOf('@media (prefers-color-scheme'));

const plate = sceneSvg({
  region: 'guanzhong', year: 740, scene: 'market',
  fam: [{ g: 'm', age: 'adult', cls: 'junfarmer' }, { g: 'f', age: 'adult', cls: 'junfarmer' }, { g: 'm', age: 'child' }, { g: 'f', age: 'child' }],
}).replace('xMidYMax slice', 'xMidYMid slice');
const endings = DATA.endings.filter((e) => !e.fallback).length;
const last = DATA.world.chapters.at(-1);
const CNUM = '〇一二三四五六七八九十';

const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;600;900&display=swap">
<style>
${rootVars}
${css}
html, body { margin: 0; }
body { width: 1200px; height: 630px; background: var(--bg); color: var(--ink); font-family: "Noto Serif TC", serif; position: relative; overflow: hidden;
  background-image: repeating-linear-gradient(90deg, transparent 0 99px, rgba(0,0,0,.05) 99px 100px); }
.frame { position: absolute; inset: 30px; border: 2px solid #6b6650; }
.frame::after { content: ""; position: absolute; inset: 10px; border: 1px solid #c9c3a8; }
.title { position: absolute; left: 118px; top: 58px; writing-mode: vertical-rl; font-weight: 900; font-size: 118px; line-height: 1; letter-spacing: .06em; margin: 0; }
.title em { font-style: normal; color: var(--yellow); }
.body { position: absolute; left: 330px; top: 78px; right: 80px; }
.slogan { border-left: 5px solid var(--yellow); padding-left: 22px; font-size: 30px; line-height: 1.55; color: var(--muted); margin: 0; }
.head { font-weight: 900; font-size: 50px; line-height: 1.3; margin: 20px 0 18px; }
.plate { height: 176px; width: 790px; border-color: #c9c3a8; }
.fine { font-size: 24px; line-height: 1.5; color: var(--muted); margin: 14px 0 0; }
.seal { position: absolute; right: 70px; top: 70px; width: 104px; height: 104px; border: 4px solid var(--red); color: var(--red); display: grid; grid-template: 1fr 1fr / 1fr 1fr; place-items: center;
  font-weight: 900; font-size: 40px; line-height: 1; padding: 6px; transform: rotate(4deg); background: rgba(240,238,226,.6); }
</style>
<div class="frame"></div>
<h1 class="title">${UI.titleHtml}</h1>
<div class="seal">${['人', '生', '模', '擬'].map((c) => `<span>${c}</span>`).join('')}</div>
<div class="body">
  <p class="slogan">${UI.slogan}</p>
  <p class="head">${UI.headline}</p>
  <figure class="plate">${plate}</figure>
  <p class="fine">${DATA.world.chapters[0].title.split('　')[1]}元年（581）到廣德元年（${last.end}）・${CNUM[DATA.world.chapters.length]}章<br>${DATA.events.length} 張事件卡・${endings} 種結局・${CNUM[Object.keys(DATA.bonds).length]}位歷史人物</p>
</div>
</html>`;
const out = path.join(__dirname, 'cover.html');
fs.writeFileSync(out, html, 'utf8');

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!chrome) { console.log('找不到 Chrome，只產生了 assets/cover.html'); process.exit(0); }
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1200,630',
  '--virtual-time-budget=8000', `--screenshot=${path.join(__dirname, 'cover.png')}`, 'file:///' + out.replace(/\\/g, '/')], { stdio: 'inherit' });
fs.unlinkSync(out);
console.log('assets/cover.png');
