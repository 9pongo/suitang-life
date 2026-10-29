// 讀 data/ 底下的檔案，合成引擎要的一份資料。sim.js 與 build.js 共用。
// 劇情檔：data/ 底下所有 events_*.json（照檔名排序）。換朝代時只要換掉 data/。
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const DIR = path.join(__dirname, 'data');
const EVENT_FILES = fs.readdirSync(DIR).filter((f) => /^events_.*\.json$/.test(f)).sort();

function readJson(f) {
  return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
}

function loadData() {
  const world = readJson('world.json');
  const strings = readJson('strings.json');
  const scenes = fs.existsSync(path.join(DIR, 'scenes.json')) ? readJson('scenes.json') : {};
  const endings = readJson('endings.json');
  const parts = EVENT_FILES.map(readJson);
  return { world, strings, scenes, endings, parts, data: E.mergeData(world, parts, endings, strings, scenes) };
}

module.exports = { loadData, EVENT_FILES };
