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
  // 雜報上刊的詩（可有可無；引擎不讀，只給介面用）
  const poems = fs.existsSync(path.join(DIR, 'poems.json')) ? readJson('poems.json').poems : [];
  // 故事線檔可以自帶結局冊的人生故事（arcBook）、後記（epilogues）、結局（endings）：
  // 人生故事與後記接在 world 後面；結局插在 before 指定的那一個前面，沒指定的——
  // 章末插在同一章原有的第一個章末前面，身故插在 world.partDeadBefore 前面（照檔名順序）
  for (const p of parts) {
    if (p.arcBook) world.arcBook = [...(world.arcBook || []), ...p.arcBook];
    if (p.epilogues) world.epilogues = [...(world.epilogues || []), ...p.epilogues];
  }
  const base = endings.endings.slice();
  // 先放沒指定位置的，再放指定 before 的（before 可以指向後面檔案裡的結局）
  const partEnds = parts.flatMap((p) => p.endings || []);
  for (const e of [...partEnds.filter((x) => !x.before), ...partEnds.filter((x) => x.before)]) {
    const anchor = e.before || (e.when === 'alive'
      ? (base.find((x) => x.when === 'alive' && x.chapter === e.chapter) || {}).id
      : world.partDeadBefore);
    const i = endings.endings.findIndex((x) => x.id === anchor);
    const { before, ...rest } = e;
    endings.endings.splice(i < 0 ? endings.endings.length : i, 0, rest);
  }
  // pin：放到同一章同一類（章末／身故）的最前面（只給條件很窄、又常被別的結局搶走的）
  for (const e of endings.endings.filter((x) => x.pin).reverse()) { // 倒著搬，釘住的幾個保持原本的先後
    endings.endings.splice(endings.endings.indexOf(e), 1);
    const i = endings.endings.findIndex((x) => x.when === e.when && x.chapter === e.chapter);
    endings.endings.splice(i < 0 ? endings.endings.length : i, 0, e);
  }
  const data = E.mergeData(world, parts, endings, strings, scenes);
  data.poems = poems;
  return { world, strings, scenes, endings, parts, poems, data };
}

module.exports = { loadData, EVENT_FILES };
