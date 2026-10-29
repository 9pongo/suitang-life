// 稽核 + 模擬：node sim.js [人數=10000] [--seed=1]
// 第一段靜態檢查資料（引用、旗標、欄位），第二段用隨機策略跑 N 條人生統計分布。
// 有任何錯誤時以離開碼 1 結束。報告寫到 reports/sim_report.md。
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const { world, strings, endings, data } = require('./load.js').loadData();
const AUDIT = world.audit || {};

const args = process.argv.slice(2);
const N = parseInt(args.find((a) => /^\d+$/.test(a)) || '10000', 10);
const seed0 = parseInt((args.find((a) => a.startsWith('--seed=')) || '--seed=1').slice(7), 10);

const errors = [];
const warns = [];
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// ------------------------------------------------------------ 靜態檢查
const ids = new Set();
for (const ev of data.events) {
  if (ids.has(ev.id)) errors.push(`事件 id 重複：${ev.id}`);
  ids.add(ev.id);
}
const STAT_KEYS = new Set([...world.stats, world.hpStat]);
const REGIONS = new Set(world.regions.map((r) => r.id));
const CLASSES = new Set(world.classes.map((c) => c.id));
const ROUTES = new Set(Object.keys(world.routes || {}));
const FACTIONS = new Set([world.civFaction || 'civ', ...Object.keys(world.factions || {})]);
const CHAPTERS = (world.chapters || []).map((c) => c.n);
const FOCI = new Set(Object.keys(world.focus));
const VARS = new Set(['name', 'friend', 'region', 'place', 'age', 'year', 'era', 'ta', 'self', 'spouse', 'child', 'parent', 'prev', 'surname', 'son', 'kid', 'young', 'gen', 'elder']);
const KINDS = new Set(['anchor', 'stage', 'bond', 'flavor']);
const flagsSet = new Map();
const flagsRead = new Map();
const add = (m, f, where) => { if (!m.has(f)) m.set(f, []); m.get(f).push(where); };

function checkReq(req, where) {
  if (!req) return;
  for (const f of [...arr(req.flag), ...arr(req.anyFlag), ...arr(req.noflag), ...arr(req.notAll), ...Object.keys(req.flagFor || {}), ...Object.keys(req.flagWithin || {})]) add(flagsRead, f, where);
  for (const r of [...arr(req.region), ...arr(req.noregion), ...Object.keys(req.noregionBefore || {})]) if (!REGIONS.has(r)) errors.push(`${where}：未知的州郡 ${r}`);
  for (const id of arr(req.notFired)) if (!ids.has(id)) errors.push(`${where}：notFired 指向不存在的事件 ${id}`);
  for (const c of arr(req.cls)) if (!CLASSES.has(c)) errors.push(`${where}：未知的家世 ${c}`);
  for (const r of arr(req.route)) if (!ROUTES.has(r)) errors.push(`${where}：未知的路線 ${r}`);
  for (const f of [...arr(req.faction), ...arr(req.nofaction)]) if (!FACTIONS.has(f)) errors.push(`${where}：未知的勢力 ${f}`);
  for (const f of arr(req.focus)) if (!FOCI.has(f)) errors.push(`${where}：未知的人生重心 ${f}`);
  for (const k of Object.keys(req.stat || {})) if (!STAT_KEYS.has(k)) errors.push(`${where}：未知的數值 ${k}`);
  for (const k of Object.keys(req.statMax || {})) if (!STAT_KEYS.has(k)) errors.push(`${where}：未知的數值 ${k}`);
  for (const k of [...Object.keys(req.bond || {}), ...Object.keys(req.bondMax || {})]) if (!data.bonds[k]) errors.push(`${where}：未知的人物 ${k}`);
  for (const k of ['child', 'son']) if (req[k] && !Array.isArray(req[k])) errors.push(`${where}：${k} 必須是 [最小年齡, 最大年齡]`);
  if (req.gen && !Array.isArray(req.gen)) errors.push(`${where}：gen 必須是 [最小, 最大]`);
  if (req.born && !Array.isArray(req.born)) errors.push(`${where}：born 必須是 [最早, 最晚]`);
  if (Array.isArray(req.anyFlag) && req.anyFlag.length === 0) errors.push(`${where}：anyFlag 是空陣列，永遠不成立`);
}
function checkEff(eff, where) {
  if (!eff) return;
  for (const k of Object.keys(eff)) {
    if (STAT_KEYS.has(k)) continue;
    if (!['flag', 'unflag', 'route', 'faction', 'focus', 'spouse', 'injure', 'bond', 'later', 'die', 'risk', 'hpCause', 'child', 'childDie', 'childAway', 'region', 'tagKid', 'kidWed', 'kidOut', 'kidHouse', 'campaignEnd'].includes(k)) errors.push(`${where}：未知的效果欄位 ${k}`);
  }
  for (const f of arr(eff.flag)) add(flagsSet, f, where);
  if (eff.route && !ROUTES.has(eff.route)) errors.push(`${where}：未知的路線 ${eff.route}`);
  if (eff.faction && !FACTIONS.has(eff.faction)) errors.push(`${where}：未知的勢力 ${eff.faction}`);
  if (eff.region && !REGIONS.has(eff.region)) errors.push(`${where}：未知的住處 ${eff.region}`);
  if (eff.focus && !FOCI.has(eff.focus)) errors.push(`${where}：未知的人生重心 ${eff.focus}`);
  for (const k of Object.keys(eff.bond || {})) if (!data.bonds[k]) errors.push(`${where}：未知的人物 ${k}`);
  for (const l of arr(eff.later)) if (!ids.has(l.id)) errors.push(`${where}：later 指向不存在的事件 ${l.id}`);
  if (eff.risk && !eff.risk.cause) errors.push(`${where}：risk 沒有寫死因 cause`);
}
function checkText(t, where) {
  if (!t) return;
  // 同一段話的幾種寫法（陣列）：每一種都要檢查，也不能是空陣列
  if (Array.isArray(t)) { if (!t.length) errors.push(`${where}：寫法陣列是空的`); for (const x of t) checkText(x, where); return; }
  if (typeof t !== 'string') { errors.push(`${where}：文字欄位不是字串`); return; }
  for (const m of t.matchAll(/\{(\w+)\}/g)) if (!VARS.has(m[1])) errors.push(`${where}：未知的模板變數 {${m[1]}}`);
}

const SURVIVE = AUDIT.surviveWords ? new RegExp(AUDIT.surviveWords) : null;
for (const ev of data.events) {
  const w = `事件 ${ev.id}`;
  if (!KINDS.has(ev.kind)) errors.push(`${w}：未知的 kind ${ev.kind}`);
  if (ev.kind === 'flavor' && ev.choices) warns.push(`${w}：隨機小事帶了選項，介面會停下來`);
  if (ev.kind === 'flavor' && ev.age) errors.push(`${w}：隨機小事的 age 要寫在 req 裡，寫在外層會被忽略`);
  checkReq(ev.req, w); checkEff(ev.eff, w);
  checkText(ev.text, w); checkText(ev.title, w); checkText(ev.tag, w);
  if (ev.choices && !ev.title) errors.push(`${w}：抉擇卡沒有 title（結局頁的「這一生的抉擇」會沒有名字）`);
  for (const t of ev.alt || []) checkText(t, w);
  for (const v of ev.textIf || []) { checkReq(v.req, w + ' textIf'); checkText(v.text, w + ' textIf'); }
  (ev.choices || []).forEach((c, i) => {
    const cw = `${w} 選項${i + 1}「${c.t}」`;
    checkReq(c.req, cw); checkReq(c.show, cw); checkEff(c.eff, cw); checkText(c.t, cw); checkText(c.out, cw); checkText(c.tAlt, cw + ' tAlt'); checkText(c.sub, cw); checkText(c.subAlt, cw + ' subAlt'); for (const v of c.subIf || []) { checkReq(v.req, cw + ' subIf'); checkText(v.sub, cw + ' subIf'); } checkText(c.outAlt, cw + ' outAlt'); for (const v of c.outIf || []) { checkReq(v.req, cw + ' outIf'); checkText(v.out, cw + ' outIf'); }
    if (c.req && !c.lock) warns.push(`${cw}：有條件但沒寫 lock 文字，鎖住時玩家看不到原因`);
    for (const b of [c.ok, c.fail]) if (b) { checkEff(b.eff, cw); checkText(b.out, cw); checkText(b.outAlt, cw + ' outAlt'); }
    for (const n of [c.next, c.ok && c.ok.next, c.fail && c.fail.next]) for (const id of arr(n)) if (!ids.has(id)) errors.push(`${cw}：next 指向不存在的事件 ${id}`);
    if (c.chk && !(c.ok && c.fail) && c.chk.base !== 1) warns.push(`${cw}：有 chk 但缺 ok 或 fail 分支`);
    // 可能當場死的選項，結果文字卻寫成活下來：死了的時候要有另一段 deathOut
    checkText(c.deathOut, cw);
    if (c.deathOut && !(c.eff && c.eff.risk)) warns.push(`${cw}：有 deathOut 但這個選項不會當場死`);
    if (c.eff && c.eff.risk && !c.deathOut && SURVIVE && [c.out, ...(c.outAlt || [])].some((o) => SURVIVE.test(o || '')))
      errors.push(`${cw}：可能當場死，但結果寫成活下來，要補 deathOut`);
  });
  if (ev.kind !== 'flavor' && !ev.year && !ev.age) {
    // 沒有年份也沒有年齡的，只能靠 later 排程叫出來
    const called = data.events.some((x) => x.id !== ev.id &&
      (JSON.stringify(x).includes(`"id":"${ev.id}"`) || JSON.stringify(x).includes(`"next":"${ev.id}"`) || JSON.stringify(x).includes(`"next":["${ev.id}"`)));
    if (!called) warns.push(`${w}：沒有年份或年齡，也沒有被 later 排程，永遠不會觸發`);
  }
}
for (const t of world.talents) checkEff(t.eff, `天賦 ${t.id}`);
for (const k of ['birthText', 'heirText', 'childText', 'nearlyLostText', 'mingyingText', 'mingyingIllText', 'plagueDeathText', 'heirWedText', 'heirWedKidText', 'heirWedKidsText', 'spouseDeathTexts']) checkText(world[k], `world.${k}`);
// 年齡上不可能達到的結局：這一章結束時最老的人也不夠那個年紀
{
  const minBirth = Math.min(...world.birthYears.map((b) => b.y));
  const chEnd = Object.fromEntries((world.chapters || []).map((c) => [c.n, c.end]));
  for (const e of endings.endings) {
    const a = e.req?.age, y = e.req?.year;
    if (!a || e.chapter == null || !chEnd[e.chapter]) continue;
    const last = Math.min(chEnd[e.chapter], y ? y[1] : Infinity);
    if (a[0] > last - minBirth) errors.push(`結局 ${e.id}：要 ${a[0]} 歲以上，可是第${e.chapter}章最老的人只有 ${last - minBirth} 歲`);
  }
}
for (const e of endings.endings) { checkReq(e.req, `結局 ${e.id}`); checkText(e.text, `結局 ${e.id}`); if (e.noKid) checkText(e.noKid, `結局 ${e.id}`); }
for (const e of world.epilogues) {
  checkReq(e.req, '後記'); checkText(e.text, '後記');
  for (const k of ['short', 'aliveText', 'lateText', 'noKid']) if (e[k]) checkText(e[k], '後記');
  if (e.final && e.chapter == null && /你走(的|以後|之後)/.test(e.text) && !e.aliveText) warns.push(`後記「${e.text.slice(0, 16)}…」寫了「你走」，但沒有活著的版本 aliveText`);
  if (e.minYears && !e.short) warns.push(`後記「${e.text.slice(0, 16)}…」有 minYears 卻沒有 short`);
}
for (const ch of CHAPTERS) for (const k of ['dead', 'alive']) {
  const last = endings.endings.filter((e) => e.when === k && (e.chapter == null || e.chapter === ch)).pop();
  if (!last || last.req || last.cause) errors.push(`結局：第${ch}章「${k}」的最後一個結局必須無條件，當作保底`);
}
for (const e of endings.endings) if (e.chapter != null && !CHAPTERS.includes(e.chapter)) errors.push(`結局 ${e.id}：未知的章 ${e.chapter}`);
{ const seenT = new Map(); for (const e of endings.endings) { if (e.chapter == null) continue; const k = e.chapter + '/' + (e.when || '') + '/' + e.title; if (seenT.has(k)) warns.push(`結局 ${e.id}：第${e.chapter}章的${e.when === 'alive' ? '章末' : '身故'}標題「${e.title}」跟 ${seenT.get(k)} 重複，結局冊裡會分不出來`); else seenT.set(k, e.id); } }
for (const f of world.parentFlags || []) add(flagsSet, 'p_' + f, '傳承');
for (const f of world.inheritFlags || []) add(flagsRead, f, '傳承');
// 引擎直接讀的旗標（spouseHere：配偶是否在身邊）
// 資料裡有設定才算數：沒有這類劇情的資料不必設定它們
for (const f of ['widowed', 'spouse_taken', 'spouse_returned']) if (flagsSet.has(f)) add(flagsRead, f, '引擎');
add(flagsSet, 'spouse_dead_old', '引擎'); add(flagsRead, 'spouse_dead_old', '引擎');
for (const f of [...Object.keys(world.relocate || {}), ...Object.keys(world.relocatePlace || {})]) add(flagsRead, f, '搬家');
add(flagsSet, 'heir', '傳承'); add(flagsSet, 'has_child', '引擎'); add(flagsSet, 'heir_young', '引擎'); add(flagsSet, 'prev_child', '引擎'); add(flagsSet, 'heir_baby', '引擎'); add(flagsSet, 'served', '引擎'); add(flagsSet, 'father_in', '引擎'); add(flagsSet, 'mil_house', '引擎'); add(flagsSet, 'prev_served', '引擎'); add(flagsSet, 'prev_young', '引擎'); add(flagsSet, 'prev_fell', '引擎');
for (const [f, where] of flagsRead) if (!flagsSet.has(f) && !f.startsWith('_')) errors.push(`旗標「${f}」被讀取卻從沒被設定（${where[0]}）`);
{
  const inh = new Set([...(world.inheritFlags || []), 'heir', 'has_child']);
  const setYear = {};
  const yr = (e) => (e.year ? arr(e.year) : null);
  const effF = (eff) => (eff ? arr(eff.flag) : []);
  for (const e of data.events) {
    const y = yr(e); if (!y) continue;
    const ymax = y[1] ?? y[0];
    const add = (f) => { setYear[f] = Math.max(setYear[f] ?? -1, ymax); };
    effF(e.eff).forEach(add);
    for (const c of e.choices || []) { effF(c.eff).forEach(add); for (const b of [c.ok, c.fail]) if (b) effF(b.eff).forEach(add); }
  }
  for (const e of data.events) {
    const y = yr(e); if (!y || !e.req) continue;
    const reads = [...arr(e.req.flag), ...arr(e.req.anyFlag)];
    for (const f of reads) {
      if (f.startsWith('p_') || inh.has(f) || setYear[f] == null) continue;
      // 同一個事件接受 p_ 版本，或另有一個同年份的事件讀 p_ 版本（本人版＋傳承版成對），都算有接上
      const alt = arr(e.req.anyFlag).includes('p_' + f) ||
        data.events.some((x) => x !== e && x.year && arr(x.year)[0] === y[0] && x.req && [...arr(x.req.flag), ...arr(x.req.anyFlag)].includes('p_' + f));
      if (y[0] - setYear[f] >= 25 && !alt) warns.push(`事件 ${e.id}（${y[0]}）讀旗標「${f}」，它最晚在 ${setYear[f]} 年設定、又不會傳給子孫，換代以後就讀不到`);
    }
  }
}
const reserved = new Set((world.reservedFlags && world.reservedFlags.flags) || []);
for (const f of [...(world.inheritFlags || []), ...(world.parentFlags || [])]) if (!flagsSet.has(f) && f !== 'heir') errors.push(`繼承名單裡的旗標「${f}」在資料裡沒有任何地方設定`);
for (const f of reserved) if (!flagsSet.has(f)) errors.push(`保留旗標「${f}」在資料裡沒有任何地方設定，名單過期了`);
// 結局冊「人生故事」：每一格要靠得到的旗標，id 不能重複
const arcIds = new Set();
for (const a of world.arcBook || []) for (const it of a.items) {
  if (arcIds.has(it.id)) errors.push(`人生故事「${a.name}」的「${it.title}」id 重複：${it.id}`);
  arcIds.add(it.id);
  for (const f of [...(it.all || [it.id]), ...(it.any || [])]) add(flagsRead, f, '結局冊');
  for (const f of [...(it.all || [it.id]), ...(it.any || [])]) if (!flagsSet.has(f)) errors.push(`人生故事「${a.name}」的「${it.title}」要的旗標「${f}」沒有任何地方設定`);
}
// 雜報上的詩：欄位齊全、年份不晚於故事結束（晚了永遠登不出來）、地區存在
const poemIds = new Set();
const lastYear = (world.chapters || []).at(-1)?.end ?? Infinity;
for (const p of data.poems || []) {
  const where = `詩「${p.title || p.id}」`;
  if (!p.id || poemIds.has(p.id)) errors.push(`${where} 沒有 id 或 id 重複`);
  poemIds.add(p.id);
  if (!p.author || !p.title || !Array.isArray(p.lines) || !p.lines.length) errors.push(`${where} 缺作者、題目或詩句`);
  if (!Number.isFinite(p.year) || p.year > lastYear) errors.push(`${where} 的年份 ${p.year} 不在故事範圍內`);
  for (const r of p.regions || []) if (!REGIONS.has(r)) errors.push(`${where} 的地區「${r}」不存在`);
}

for (const [f, where] of flagsSet) if (!flagsRead.has(f) && !reserved.has(f)) warns.push(`旗標「${f}」設定了但沒有任何地方讀它（${where[0]}）`);

// ------------------------------------------------------------ 模擬
const rawTemplates = new Set();
const stats = {
  lives: 0, alive: 0, infant: 0, ch1Alive: 0, chAlive: {}, fac: {}, successions: 0, generations: {}, lastYear: {}, extinctCh: {}, interludes: {}, factions: {}, factionDead: {},
  routes: {}, routeDead: {}, endings: {}, causes: {}, events: {}, optShown: {}, optOk: {}, optPick: {},
  bondMax: {}, finalStats: Object.fromEntries([...world.stats, world.hpStat].map((k) => [k, 0])), choicesPerLife: 0, genders: { m: 0, f: 0 },
};
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

// ------------------------------------------------------------ 執行時的一致性檢查（過去實際出過的問題，防止再犯）
const byId = Object.fromEntries(data.events.map((e) => [e.id, e]));
const consist = {};
const flagIssue = (k, seedNo, example) => { consist[k] ??= { n: 0, seed: seedNo, example }; consist[k].n++; };
const WEATHER = new Set(AUDIT.weatherEvents || []); // 天氣小事：不依賴資料裡的 group 設定，拿掉設定也抓得到
const HOUSEHOLD = AUDIT.householdEvents || []; // 全家一起決定的事，接班人不該再決定一次
const KID_WORDS = AUDIT.kidWords ? new RegExp(AUDIT.kidWords) : null;
function snapshot(st) {
  return { father: !!st.flags.father_dead, mother: !!st.flags.mother_dead, lone: !!(st.flags.widowed || st.flags.spouse_dead_old), name: st.name,
    single: !!st.flags.single, wed: !!st.spouse,
    kids: st.children.filter((c) => c.alive).map((c) => ({ name: c.name, born: c.born })) };
}
function checkStep(g, before, from, seedNo) {
  const st = g.state;
  if (st.name !== before.name) return; // 換了人，交給接班的檢查
  const fresh = st.log.slice(from);
  const weather = {};
  for (const x of fresh) {
    const ev = x.id && byId[x.id];
    if (!ev) continue;
    if (/^st_(heir_)?marry/.test(x.id) && (before.single || before.wed)) flagIssue('說過再也沒人上門說媒、或已經成了家，又有人來說媒', seedNo, x.id);
    if (x.id === 'f_father' && before.father) flagIssue('父親已經過世，又收到「父親過世」', seedNo);
    if (x.id === 'f_mother' && before.mother) flagIssue('母親已經過世，又收到「母親過世」', seedNo);
    if (ev.req?.married === true && before.lone) flagIssue('配偶已經過世，還收到要求有配偶在身邊的卡', seedNo);
    if (ev.kind === 'flavor' && st.campaignYear === x.year) flagIssue('出征在外的那一年，還發生家鄉的小事', seedNo);
    if (WEATHER.has(x.id)) { if (weather[x.year]) flagIssue('同一年出現兩件天氣小事（例如豐收又蝗災）', seedNo); weather[x.year] = 1; }
    if (x.id === 'f_child_die') {
      const gone = before.kids.filter((c) => !st.children.some((d) => d.name === c.name && d.alive));
      if (gone.length === 1 && x.year - gone[0].born > 6) flagIssue('「孩子沒能熬過冬天」帶走的不是幼兒', seedNo);
    }
  }
  // 寫了「終」（壽終、病逝）的人卻還活著（例如命硬救回來）
  if (st.alive && fresh.some((x) => x.tag === '終')) flagIssue('已經寫了「終」，人卻又活了過來', seedNo);
  // 孩子跟配偶同名同姓，或用了父母的名（避諱）
  const given = (n) => (n || '').slice(1);
  for (const c of st.children) {
    if (st.spouse && c.name === st.spouse) flagIssue('孩子跟配偶同名同姓', seedNo, c.name);
    else if (given(c.name) === given(st.name) || (st.spouse && given(c.name) === given(st.spouse))) flagIssue('孩子用了父母的名（犯諱）', seedNo, c.name);
  }
  // 年幼接班的人只該在十六歲選一次人生重心
  if (st.fired.st_focus15 && st.fired.st_heir_focus_young) flagIssue('年幼接班的人十五、十六歲連續選了兩次人生重心', seedNo);
}
function checkEnding(st, r, seedNo) {
  if (!r) return;
  if (KID_WORDS && !st.children.some((c) => c.alive)) for (const t of [r.text, ...(r.memories || [])]) if (KID_WORDS.test(t || '')) flagIssue(`沒有孩子在世，結局「${r.id}」或往事卻寫到自家孩子`, seedNo, String(t).slice(0, 30));
}

// 每個人：選了路線的，看他有沒有活過那一章；死去的人，記在他死的那一章、當時的勢力下
function countPerson(p) {
  if (p.route && !p._routeCounted) { p._routeCounted = true; inc(stats.routes, p.route); if (!p.alive) inc(stats.routeDead, p.route); }
  if (!p.alive && p.chapter >= 2 && !p._deadCounted) { p._deadCounted = true; stats.fac[p.chapter] ??= { live: {}, dead: {} }; inc(stats.fac[p.chapter].dead, p.faction || 'civ'); }
}
for (let i = 0; i < N; i++) {
  const g = E.createGame(data, seed0 * 100003 + i, { late: Math.random() < ((world.lateStart || {}).chance || 0) });
  const firedLife = {};
  const familyFired = {};
  const noteFamily = () => { for (const id of HOUSEHOLD) if (g.state.fired[id]) { if (familyFired[id]) flagIssue(`全家一起決定的「${id}」被接班人又決定了一次`, g.seed); familyFired[id] = 1; } };
  let guard = 0;
  while (!g.ended && guard++ < 12000) {
    if (g.succession) {
      stats.successions++; for (const id in g.state.fired) firedLife[id] = 1;
      checkEnding(g.state, g.succession, g.seed); noteFamily();
      const dead = g.state;
      countPerson(dead);
      // 有長孫可選時，三次裡挑一次長孫，讓隔代接班也跑得到
      const hs = g.succession.heirs, gi = hs.findIndex((x) => x.via);
      const pickGrand = gi >= 0 && Math.random() < 1 / 3;
      if (pickGrand) stats.grandHeirs = (stats.grandHeirs || 0) + 1;
      g.continueAsHeir(pickGrand ? gi : 0);
      if (pickGrand && (g.state.generation !== dead.generation + 2 || g.state.parentName !== hs[gi].via || g.state.flags.father_dead || g.state.flags.mother_dead)) flagIssue('長孫接班的代數或爹娘不對', g.seed, g.state.name);
      // 接班人的父母：孩子接班時，死去的那一位必須記為已過世
      const h = g.state;
      // 上一代時已經成親的孩子，接家時必須是成了家的人
      const wedKid = dead.children.find((c) => c.name === h.name && c.alive);
      if (wedKid && wedKid.wed && !h.spouse) flagIssue('孩子成親過，接家時卻是單身', g.seed, h.name);
      const picked = hs[pickGrand ? gi : 0];
      if (picked && picked.knownWed && h.age >= 18 && !h.spouse) flagIssue('早已成家的弟妹接家時卻是單身', g.seed, h.name);
      if (h.parentName === dead.name && !h.flags[dead.gender === 'm' ? 'father_dead' : 'mother_dead']) flagIssue('接班人的父／母剛過世，卻沒有記為已過世', g.seed);
      continue;
    }
    if (g.interlude) { const ch = g.interlude.chapter; countPerson(g.state); if (ch >= 2) { stats.fac[ch] ??= { live: {}, dead: {} }; inc(stats.fac[ch].live, g.state.faction || 'civ'); } inc(stats.interludes, g.interlude.id); inc(stats.chAlive, g.interlude.chapter); if (g.interlude.chapter === 1) stats.ch1Alive++; g.continueChapter(); continue; }
    if (g.pending) {
      const p = g.pending;
      const evId = g.state.log.filter((e) => e.type === 'decision').pop().id;
      const ok = p.opts.filter((o) => o.ok);
      for (const o of p.opts) { inc(stats.optShown, `${evId}#${o.i}`); if (o.ok) inc(stats.optOk, `${evId}#${o.i}`); }
      const pick = ok[Math.floor(Math.random() * ok.length)];
      inc(stats.optPick, `${evId}#${pick.i}`);
      const before = snapshot(g.state), from = g.state.log.length;
      g.choose(p.opts.indexOf(pick));
      checkStep(g, before, from, g.seed);
    } else {
      const before = snapshot(g.state), from = g.state.log.length;
      g.step();
      checkStep(g, before, from, g.seed);
    }
  }
  if (!g.ended) { errors.push(`第 ${i} 條人生跑了 12000 步還沒結束（種子 ${g.seed}）`); continue; }
  for (const id in g.state.fired) firedLife[id] = 1;
  checkEnding(g.state, g.ended, g.seed); noteFamily();
  // 實際顯示出來的文字裡不能留下沒填的 {變數}
  {
    const st = g.state;
    const texts = [...st.log.map((x) => x.text || ''), ...st.choices.map((c) => c.pick + c.title), g.ended.text, ...(g.ended.epilogue || []), ...(g.ended.memories || [])];
    for (const t of texts) {
      const m = String(t).match(/\{\w+\}/);
      if (m && !rawTemplates.has(m[0])) { rawTemplates.add(m[0]); errors.push(`顯示的文字裡留下沒填的 ${m[0]}：「${String(t).slice(0, 30)}…」（種子 ${g.seed}）`); }
    }
  }
  inc(stats.generations, g.ended.lineage.length);
  inc(stats.lastYear, String(Math.floor(g.ended.year / 10) * 10));
  if (g.ended.extinct) inc(stats.extinctCh, g.ended.chapter);
  const s = g.state;
  stats.lives++;
  inc(stats.genders, s.gender);
  if (s.alive) stats.alive++;
  if (!s.alive && s.age <= 4) stats.infant++;
  countPerson(s);
  if (s.alive && s.chapter >= 2) { stats.fac[s.chapter] ??= { live: {}, dead: {} }; inc(stats.fac[s.chapter].live, s.faction || 'civ'); }
  inc(stats.endings, g.ended.id);
  if (!s.alive) inc(stats.causes, s.cause);
  for (const id in firedLife) inc(stats.events, id);
  for (const b in data.bonds) inc(stats.bondMax, `${b}:${s.bonds[b] || 0}`);
  for (const k of world.stats) stats.finalStats[k] += s.stats[k];
  stats.finalStats[world.hpStat] += s.hp;
  stats.choicesPerLife += s.choices.length;
}

// 跑得夠多時：從沒觸發的事件、從沒被選到的選項都算提醒
if (N >= 2000) {
  for (const e of data.events) if (!stats.events[e.id]) warns.push(`事件 ${e.id}：模擬 ${N} 條人生從未觸發`);
  for (const ev of data.events) (ev.choices || []).forEach((c, i) => { if (stats.events[ev.id] && !stats.optPick[`${ev.id}#${i}`]) warns.push(`事件 ${ev.id} 選項「${c.t}」：從來沒有被選到（出現 ${stats.optShown[`${ev.id}#${i}`] || 0} 次）`); });
}
for (const [k, v] of Object.entries(consist)) errors.push(`一致性：${k}（${v.n} 次，例如種子 ${v.seed}${v.example ? `：「${v.example}…」` : ''}）`);

// ------------------------------------------------------------ 報告
const pct = (n, d = stats.lives) => (d ? ((100 * n) / d).toFixed(1) + '%' : '-');
const L = [];
L.push(`# ${strings.ui.title}：稽核與模擬報告`, '', `模擬 ${stats.lives} 條人生（隨機選擇），種子 ${seed0}。`, '');
L.push(`## 靜態檢查`, '', `錯誤 ${errors.length} 項，提醒 ${warns.length} 項。`, '');
for (const e of errors) L.push(`- ❌ ${e}`);
for (const w of warns) L.push(`- ⚠️ ${w}`);
L.push('', '## 生死', '');
L.push(`| 指標 | 數值 |`, `|---|---|`);
L.push(`| 五歲前夭折 | ${pct(stats.infant)} |`);
L.push(`| 活到第一章結束（${world.chapters[0].end}） | ${pct(stats.ch1Alive)} |`);
for (const c of world.chapters.slice(1, -1)) L.push(`| 活到第${c.n}章結束（${c.end}） | ${pct(stats.chAlive[c.n] || 0)} |`);
L.push(`| 活到最後一章結束（${world.chapters.at(-1).end}） | ${pct(stats.alive)} |`);
L.push(`| 最後一代平均做幾次抉擇 | ${(stats.choicesPerLife / stats.lives).toFixed(1)} |`);
L.push(`| 每個家族平均傳承次數 | ${(stats.successions / stats.lives).toFixed(2)} |`);
L.push('', '## 家族', '', '| 傳了幾代 | 家族占比 |', '|---|---|');
for (const k of Object.keys(stats.generations).sort((a, b) => a - b)) L.push(`| ${k} 代 | ${pct(stats.generations[k])} |`);
L.push('', '| 香火斷在第幾章 | 占比 |', '|---|---|');
for (const k of Object.keys(stats.extinctCh).sort((a, b) => a - b)) L.push(`| 第${k}章 | ${pct(stats.extinctCh[k])} |`);
{
  const tot = Object.values(stats.routes).reduce((x, y) => x + y, 0);
  L.push('', `## 路線（${world.routeLabel || ''}的選擇）`, '', '每個選了路線的人，看他有沒有活過選路線的那一章。', '', '| 路線 | 占選了路線的人 | 第一章內死亡率 |', '|---|---|---|');
  for (const r of Object.keys(stats.routes).sort((a, b) => stats.routes[b] - stats.routes[a])) L.push(`| ${r} | ${pct(stats.routes[r], tot)} | ${pct(stats.routeDead[r] || 0, stats.routes[r])} |`);
}
function facRows(ch) {
  const F = stats.fac[ch] || { live: {}, dead: {} };
  const keys = [...new Set([...Object.keys(F.live), ...Object.keys(F.dead)])];
  const tot = (f) => (F.live[f] || 0) + (F.dead[f] || 0);
  const all = keys.reduce((s, f) => s + tot(f), 0);
  return keys.sort((a, b) => tot(b) - tot(a)).map((f) => ({ f, share: pct(tot(f), all), dead: pct(F.dead[f] || 0, tot(f)) }));
}
for (const c of world.chapters.filter((c) => c.n >= 2)) {
  L.push('', `## 第${c.n}章勢力（以章末或死亡時的勢力計）`, '', '| 勢力 | 占這一章的人數 | 這一章的死亡率 |', '|---|---|---|');
  for (const r of facRows(c.n)) L.push(`| ${r.f} | ${r.share} | ${r.dead} |`);
}
L.push('', '## 章末（活過某一章的人拿到的章末標題）', '', '| 章末 | 章 | 標題 | 占全部人生 |', '|---|---|---|---|');
for (const e of endings.endings.filter((x) => x.chapter != null && x.chapter < world.chapters.at(-1).n && x.when === 'alive')) L.push(`| ${e.id} | ${e.chapter} | ${e.title}${e.rare ? '（稀有）' : ''} | ${pct(stats.interludes[e.id] || 0)} |`);
L.push('', '## 最終結局分布', '', '| 結局 | 章 | 標題 | 占比 |', '|---|---|---|---|');
for (const e of endings.endings) L.push(`| ${e.id} | ${e.chapter ?? '-'} | ${e.title}${e.rare ? '（稀有）' : ''} | ${pct(stats.endings[e.id] || 0)} |`);
L.push('', '## 死因', '', '| 死因 | 占全部人生 |', '|---|---|');
for (const c of Object.keys(stats.causes).sort((a, b) => stats.causes[b] - stats.causes[a])) L.push(`| ${c} | ${pct(stats.causes[c])} |`);
L.push('', '## 人物羈絆（最高交情的分布）', '');
for (const b in data.bonds) {
  const tiers = data.bonds[b].tiers.map((t, i) => `${t} ${pct(stats.bondMax[`${b}:${i}`] || 0)}`).join('、');
  L.push(`- ${data.bonds[b].name}：${tiers}`);
}
L.push('', '## 事件觸發率（每條人生至少觸發一次的比例）', '');
const never = data.events.filter((e) => !stats.events[e.id]);
L.push(never.length ? `**從未觸發（${never.length}）**：${never.map((e) => e.id).join('、')}` : '所有事件都至少觸發過一次。', '');
L.push('| 事件 | 類型 | 觸發率 |', '|---|---|---|');
for (const e of [...data.events].sort((a, b) => (stats.events[b.id] || 0) - (stats.events[a.id] || 0))) L.push(`| ${e.id} | ${e.kind} | ${pct(stats.events[e.id] || 0)} |`);
L.push('', '## 從來沒有被選到的選項', '');
const deadOpts = [];
for (const ev of data.events) (ev.choices || []).forEach((c, i) => {
  const k = `${ev.id}#${i}`;
  if (stats.events[ev.id] && !stats.optOk[k]) deadOpts.push(`${ev.id}「${c.t}」（出現 ${stats.optShown[k] || 0} 次，全部鎖住）`);
});
L.push(deadOpts.length ? deadOpts.map((x) => `- ${x}`).join('\n') : '沒有。');
L.push('', '## 結束時的平均數值（全部人生）', '');
L.push(Object.entries(stats.finalStats).map(([k, v]) => `${k} ${(v / stats.lives).toFixed(1)}`).join('　'));

fs.mkdirSync(path.join(__dirname, 'reports'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'reports', 'sim_report.md'), L.join('\n') + '\n', 'utf8');

// 終端摘要
console.log(`靜態檢查：錯誤 ${errors.length}，提醒 ${warns.length}`);
for (const e of errors) console.log('  ❌ ' + e);
for (const w of warns) console.log('  ⚠️  ' + w);
console.log(`模擬 ${stats.lives} 條：夭折 ${pct(stats.infant)}，` + world.chapters.slice(0, -1).map((c) => `活到 ${c.end} 年 ${pct(stats.chAlive[c.n] || 0)}`).join('，') + `，活到 ${world.chapters.at(-1).end} 年 ${pct(stats.alive)}，平均抉擇 ${(stats.choicesPerLife / stats.lives).toFixed(1)} 次`);
console.log(`家族：平均傳承 ${(stats.successions / stats.lives).toFixed(2)} 次（長孫接班 ${stats.grandHeirs || 0} 次）；傳到最後一章結束的家族 ${pct(stats.alive)}；代數分布 ` + Object.entries(stats.generations).sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}代 ${pct(n)}`).join('、'));
for (const c of world.chapters.filter((c) => c.n >= 2)) console.log(`第${c.n}章勢力（占比／死亡率）：` + facRows(c.n).map((r) => `${r.f} ${r.share}／${r.dead}`).join('、'));
console.log('路線：' + Object.entries(stats.routes).map(([r, n]) => `${r} ${pct(n)}（死 ${pct(stats.routeDead[r] || 0, n)}）`).join('、'));
console.log('從未觸發：' + (never.map((e) => e.id).join('、') || '無'));
console.log('鎖死選項：' + (deadOpts.length ? deadOpts.join('；') : '無'));
console.log('報告：reports/sim_report.md');
process.exit(errors.length ? 1 : 0);
