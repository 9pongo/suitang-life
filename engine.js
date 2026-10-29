// 人生模擬引擎（不分朝代）
// 瀏覽器與 Node 共用：瀏覽器掛在 window.LifeEngine，Node 用 require。
// 引擎本身不含任何劇情、也不含任何給玩家看的字：
//   data/world.json   這個朝代的世界設定與規則（地區、身分、勢力、控制權時間線、數值名稱……）
//   data/strings.json 引擎與介面套用的句子、標籤、稱呼
//   data/events_*.json、data/endings.json  劇情
(function (root) {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // 把 {key} 換成值（引擎自己的句子；劇情文字另有 fmt）
  const tpl = (t, v) => String(t ?? '').replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m));

  // 干支、數字：字都放在 strings.calendar
  function ganzhi(y, C) {
    const i = (((y - 4) % 60) + 60) % 60;
    return C.stems[i % 10] + C.branches[i % 12];
  }

  function cnNum(n, C) {
    const D = C.digits, X = D[10];
    if (n <= 10) return D[n];
    if (n < 20) return X + (n % 10 ? D[n % 10] : '');
    return D[Math.floor(n / 10)] + X + (n % 10 ? D[n % 10] : '');
  }

  // 年號：同一個年號中途改了紀年單位（例如年改稱載）就拆成兩段，後一段寫 base（從哪一年起算）和 unit
  function eraLabel(y, eras, C) {
    const e = eras.find((x) => y >= x.from && y <= x.to);
    if (!e) return ganzhi(y, C) + C.yearUnit;
    const n = y - (e.base ?? e.from) + 1;
    return e.name + (n === 1 ? C.firstYear : cnNum(n, C)) + (e.unit || C.yearUnit);
  }

  function pickWeighted(R, items, w) {
    const total = items.reduce((s, it) => s + w(it), 0);
    if (total <= 0) return null;
    let r = R() * total;
    for (const it of items) { r -= w(it); if (r < 0) return it; }
    return items[items.length - 1];
  }

  // ---------------------------------------------------------------- game

  function createGame(data, seed, opts = {}) {
    if (seed == null) seed = Math.floor(Math.random() * 2 ** 31);
    const R = mulberry32(seed);
    const byId = {};
    for (const ev of data.events) byId[ev.id] = ev;
    // 沒有年份也沒有年齡的事件，只能由 later 排程叫出來（因果事件），不進每年的候選
    const scheduledPool = data.events.filter((e) => (e.kind === 'anchor' || e.kind === 'bond' || e.kind === 'stage') && (e.year || e.age));
    const flavorPool = data.events.filter((e) => e.kind === 'flavor');

    const g = { data, seed, R, byId, st: null, queue: [], pending: null, out: [], ended: null, interlude: null, succession: null };
    const W = data.world, T = data.strings.engine, C = data.strings.calendar;
    const STATS = W.stats, HP = W.hpStat;
    const zeroStats = () => Object.fromEntries(STATS.map((k) => [k, 0]));
    const cn = (n) => cnNum(n, C);
    const gz = (y) => ganzhi(y, C);
    const HOME_TAGS = new Set(W.homeTags || []);
    const AWAY_TAGS = new Set([...HOME_TAGS, ...(W.awayTags || [])]);
    const HOUSEHOLD = new RegExp(T.householdRegex || '(?!)');
    const ALIVE_FORBID = new RegExp(T.aliveForbidRegex || '(?!)');
    const GRAND = new RegExp(T.grandRegex || '(?!)');
    const talentDef = (id) => W.talents.find((x) => x.id === id) || {};
    const tough = () => S().talents.some((t) => talentDef(t).tough);

    // 地區在某一年歸誰管（world.regionControl）；沒列的年份算 world.defaultPower
    function powerOf(r, y) {
      const tl = (W.regionControl || {})[r] || [];
      const p = tl.find((x) => y >= (x.from ?? -Infinity) && y <= (x.to ?? Infinity));
      return p ? p.power : W.defaultPower || null;
    }
    // 年號：住處那一年的統治者有自己的年號就用它的；其次看自己跟的勢力；都沒有就用正朔
    function erasFor(y) {
      const has = (list) => list && list.some((x) => y >= x.from && y <= x.to);
      const s = g.st;
      const pw = s && (W.powers || {})[powerOf(s.region, y)];
      if (pw && has(pw.eras)) return pw.eras;
      const list = s && s.faction && (W.factionEras || {})[s.faction];
      if (has(list)) return list;
      return W.eras;
    }
    const era = (y) => eraLabel(y, erasFor(y), C);
    const chapters = W.chapters || [{ n: 1, end: W.chapterEnd }];
    const chapterOf = (n) => chapters.find((c) => c.n === n);

    // ---------- 狀態存取
    const S = () => g.st;
    function val(k) { return k === HP ? S().hp : (S().stats[k] ?? 0); }

    function vars() {
      const s = S(), F = T.fallback;
      return {
        name: s.name, friend: s.friend, region: s.regionName, place: s.place,
        age: s.age, year: s.year, era: era(s.year),
        ta: T.pronoun[s.gender], self: T.selfWord[s.gender],
        spouse: s.spouse || '',
        child: (s.children.filter((c) => c.alive).slice(-1)[0] || {}).name || F.child,
        // 父母：自己的父母；弟妹接班時跟前一位當家的是同一對父母。不知道名字就用 fallback.elder
        parent: s.parentName || F.elder,
        elder: s._elder || F.elder,
        // 前一位當家的人（可能是父母，也可能是兄姊）
        prev: (s.lineage.slice(-1)[0] || {}).name || F.elder,
        surname: s.surname, gen: cn(s.generation),
        son: s._son || F.son, kid: s._kid || F.child,
        // 夭折的是家裡最小、還在身邊的孩子（childDie 沒指定時就是這一個）
        young: (s.children.filter((c) => c.alive && !c.away).sort((x, y) => y.born - x.born)[0] || {}).name || F.child,
      };
    }
    // 同一段話有好幾種寫法：這一局的種子決定從哪一種開始，同一家族再碰到就換下一種
    // 不動用亂數，所以加寫法不會讓舊存檔重播走樣
    function variant(list, key, uk) {
      if (!Array.isArray(list)) return list;
      if (list.length < 2) return list[0];
      const s = S(), fam = s.familySeen || (s.familySeen = {});
      const k = '~' + key, n = fam[k] || 0;
      fam[k] = n + 1;
      let h = 2166136261 >>> 0;
      for (const ch of seed + ':' + key) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
      if (!uk) return list[(h + n) % list.length];
      // 同一件事換了開場（textIf）以後，不要又挑到上回已經寫過的那一句
      const used = fam['!' + uk] || (fam['!' + uk] = []);
      if (list.every((x) => used.includes(x))) used.splice(0, used.length - 1); // 每一種都寫過了：從頭再輪一遍，只是別緊接著又寫上一回那一句
      let t = list[(h + n) % list.length];
      for (let i = 0; i < list.length && used.includes(t); i++) t = list[(h + n + i) % list.length];
      used.push(t);
      return t;
    }
    const withAlt = (base, alt) => (alt && alt.length ? [base, ...alt] : base);
    // 寫到家裡還有別人的句子（strings.engine.householdRegex）：一個人過日子的時候，挑別的寫法；每一種都提到家人，就照原樣
    const homeText = (list) => { if (!Array.isArray(list) || !aloneNow()) return list; const f = list.filter((t) => !HOUSEHOLD.test(t)); return f.length ? f : list; };
    // 依住處換字（world.regionWords，例如南方把麥換成稻）、依勢力換字（world.factionWords）；有年份的時代大事照史料寫，不換
    let histText = false;
    function localize(t, region) {
      if (histText) return t;
      const words = [...((W.regionWords || {})[region || S().region] || []), ...((W.factionWords || {})[S().faction] || [])];
      for (const [a, b] of words) t = t.split(a).join(b);
      return t;
    }
    function fmt(t, region) {
      if (!t) return t;
      const v = vars();
      return localize(t.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)), region);
    }

    function findKid(gender, range, unwed) {
      const s = S();
      return (s.children || [])
        .filter((c) => c.alive && !c.away && !(c.outUntil > s.year) && (!gender || c.gender === gender) && !(unwed === true && c.wed) && !(unwed === 'stay' && c.gender === 'f' && c.wed) && !(unwed === 'wed' && !(c.wed || c.knownWed)) && !(unwed === 'wed' && s.year - (c.wedYear ?? -99) < 3))
        .filter((c) => { const a = s.year - c.born; return a >= range[0] && a <= (range[1] ?? 200); })
        .sort((x, y) => x.born - y.born)[0] || null;
    }

    function meets(req) {
      if (!req) return true;
      const s = S();
      if (req.age && (s.age < req.age[0] || s.age > req.age[1])) return false;
      if (req.year && (s.year < req.year[0] || s.year > req.year[1])) return false;
      if (req.born && (s.birthYear < req.born[0] || s.birthYear > req.born[1])) return false; // 出生年：某件大事以後才出生的人，沒見過那件事
      if (req.region && !arr(req.region).includes(s.region)) return false;
      if (req.noregion && arr(req.noregion).includes(s.region)) return false;
      if (req.noregionBefore && s.year < (req.noregionBefore[s.region] ?? -Infinity)) return false; // 住在這一帶、這一年以前碰不上（例如那裡還沒歸這個朝廷管）
      if (req.power && !arr(req.power).includes(powerOf(s.region, s.year))) return false; // 住處這一年歸誰管（world.regionControl）
      if (req.nopower && arr(req.nopower).includes(powerOf(s.region, s.year))) return false;
      if (req.notFired && arr(req.notFired).some((id) => s.fired[id])) return false; // 這輩子碰過內容相近的事
      if (req.cls && !arr(req.cls).includes(s.cls)) return false;
      if (req.nocls && arr(req.nocls).includes(s.cls)) return false; // 有田莊的人家，碰不上窮人家的小事
      // 帶著某個旗標的人家，碰不到只寫給某些身分的事（world.clsBlock：{ flag, cls }）
      if (req.cls && (W.clsBlock || []).some((b) => s.flags[b.flag] && arr(req.cls).every((c) => arr(b.cls).includes(c)))) return false;
      if (req.gender && s.gender !== req.gender) return false;
      if (req.talent && !arr(req.talent).some((t) => s.talents.includes(t))) return false;
      if (req.flag && !arr(req.flag).every((f) => s.flags[f])) return false;
      if (req.anyFlag && !arr(req.anyFlag).some((f) => s.flags[f])) return false;
      if (req.noflag && arr(req.noflag).some((f) => s.flags[f])) return false;
      if (req.notAll && arr(req.notAll).every((f) => s.flags[f])) return false; // 這幾個旗標不能全都有（例如爹娘不能都不在了）
      if (req.route && !arr(req.route).includes(s.route)) return false;
      if (req.noroute && arr(req.noroute).includes(s.route)) return false;
      // 身在官府管不到的地方：碰不到里正、徭役這些事。world.factionAlias：帶著某個旗標的人，算作某個勢力
      const CIV = W.civFaction || 'civ';
      if (req.nofaction && (arr(req.nofaction).includes(s.faction || CIV) || (W.factionAlias || []).some((a) => s.flags[a.flag] && arr(req.nofaction).includes(a.faction)))) return false;
      // 身在軍中陣營的女子不上陣，但她也是那片土地上的百姓：平民的劇情同樣算她一份（world.civWomenExcept 列出的勢力除外）
      if (req.faction && !arr(req.faction).includes(s.faction || CIV) &&
        !(s.gender === 'f' && arr(req.faction).includes(CIV) && !arr(W.civWomenExcept).includes(s.faction))) return false;
      if (req.chapter && !arr(req.chapter).includes(s.chapter)) return false;
      if (req.focus && !arr(req.focus).includes(s.focus)) return false;
      if (req.stat) for (const k in req.stat) if (val(k) < req.stat[k]) return false;
      if (req.statMax) for (const k in req.statMax) if (val(k) > req.statMax[k]) return false;
      if (req.bond) for (const k in req.bond) if ((s.bonds[k] || 0) < req.bond[k]) return false;
      if (req.bondMax) for (const k in req.bondMax) if ((s.bonds[k] || 0) > req.bondMax[k]) return false;
      if (req.gen && (s.generation < req.gen[0] || s.generation > (req.gen[1] ?? 99))) return false;
      // 子女：在某個年齡範圍內、還活著、沒有送走的孩子（son 只看兒子）
      // 故事線的後續：認當初用 tagKid 標記的那個孩子，不靠年齡猜（家裡有好幾個同齡上下的孩子時才不會認錯人）
      if (req.kidTag) { const c = (s.children || []).find((x) => x.alive && !x.away && x.tag === req.kidTag); if (!c) return false; s._kid = c.name; if (c.gender === 'm') s._son = c.name; }
      if (req.child) { const c = findKid(null, req.child, req.kidUnwed || (req.kidWed && 'wed')); if (!c) return false; s._kid = c.name; }
      if (req.son) { const c = findKid('m', req.son, req.kidUnwed || (req.kidWed && 'wed')); if (!c) return false; s._son = c.name; }
      // 還住在小時候住的地方（沒有搬到別的地區去）
      if (req.home !== undefined && (s.place === homePlace()) !== req.home) return false;
      if (req.ancestral !== undefined && (s.place === ((s.regionHist || [])[0] || [])[2]) !== req.ancestral) return false; // 住在這一家最早落腳、祖墳所在的地方
      if (req.elderSib !== undefined && (s.siblings || []).some((c) => c.alive && !c.away && s.year - c.born >= 18) !== req.elderSib) return false; // 家裡還有成了年的哥哥姊姊
      if (req.alone !== undefined && aloneNow() !== req.alone) return false; // 沒配偶、沒孩子、爹娘也都不在
      if (req.away !== undefined && awayAtWar() !== req.away) return false; // 人還跟著隊伍在外
      // 同一個地區裡落腳的地方不同（relocatePlace 換過地名）；接家的孩子沒有上一代逃難時記下的旗標，看的是現在住在哪裡
      if (req.place && !arr(req.place).includes(s.place)) return false;
      if (req.noplace && arr(req.noplace).includes(s.place)) return false;
      if (req.homeAcross !== undefined && homeAcross() !== req.homeAcross) return false;
      if (req.tombAcross !== undefined && tombAcross() !== req.tombAcross) return false;
      // 拿到這個旗標以後沒有搬過家（例如自己開的那塊地，搬走了就不再是你家的）
      // 在這一帶住了夠久：搬來的年份不晚於 settled（晚年才搬來的人，沒見過這裡從前的事）；settledIn 列出算作同一帶的地區
      if (req.settled != null) { const h = s.regionHist || []; let i = h.length; const near = arr(req.settledIn || s.region); while (i > 0 && near.includes(h[i - 1][1])) i--; if (i < h.length && h[i][0] > req.settled) return false; }
      if (req.justMoved !== undefined && ((s.regionHist || []).length > 1 && s.regionHist[s.regionHist.length - 1][0] === s.year) !== req.justMoved) return false; // 這一年剛搬家
      if (req.movedWithin != null) { const h = s.regionHist || []; if (!(h.length > 1 && s.year - h[h.length - 1][0] < req.movedWithin)) return false; } // 搬來這裡還不到幾年
      if (req.settledFor != null) { const h = s.regionHist || []; if (h.length && s.year - h[h.length - 1][0] < req.settledFor) return false; } // 搬來這裡至少住了幾年
      if (req.stayed) for (const f of arr(req.stayed)) { const y = (s.flagYear || {})[f]; if (y !== undefined && (s.regionHist || []).some(([yy]) => yy > y)) return false; }
      if (req.flagFor) for (const [f, n] of Object.entries(req.flagFor)) { const y = (s.flagYear || {})[f]; if (s.flags[f] && y !== undefined && s.year - y < n) return false; } // 拿到這個旗標至少過了幾年
      if (req.flagWithin && !Object.entries(req.flagWithin).some(([f, n]) => { const y = (s.flagYear || {})[f]; return s.flags[f] && y !== undefined && s.year - y < n; })) return false; // 其中一個旗標是這幾年才拿到的
      if (req.wedFor != null && s.spouseYear != null && s.year - s.spouseYear < req.wedFor) return false; // 成親至少幾年
      if (req.brother != null && (s.siblings || []).some((x) => x.gender === 'm' && x.alive) !== req.brother) return false;
      if (req.married === true && !spouseHere()) return false;
      if (req.married === false && s.spouse) return false;
      return true;
    }

    function emit(entry) {
      const s = S();
      const e = Object.assign({ age: s.age, year: s.year }, entry);
      if (e.text) e.text = fmt(e.text);
      if (e.tag) e.tag = fmt(e.tag);
      if (e.text) for (const c of s.children || []) if (c.alive && e.text.includes(c.name)) c.seen = s.year; // 這兩年事情裡還提到名字的孩子，接家時不會突然不在了
      g.out.push(e);
      s.log.push(e);
      return e;
    }

    // ---------- 效果
    function chance(c) {
      if (c == null) return 1;
      if (typeof c === 'number') return c;
      // 「活下來就一定是這個結果」（base 1、沒有 fail）：不能被上限 0.97 卡掉，落得一個什麼都沒寫的結局
      if (c.base >= 1 && !c.stat && !c.bond) return 1;
      let p = c.base ?? 0.5;
      if (c.stat) p += (c.k ?? 0.01) * val(c.stat);
      if (c.bond) p += (c.bk ?? 0.1) * (S().bonds[c.bond] || 0);
      return clamp(p, c.min ?? 0.03, c.max ?? 0.97);
    }

    function die(cause, entry) {
      const s = S();
      if (!s.alive) return;
      // 命硬（talents[].tough）：一輩子能從鬼門關回來一次
      if (tough() && !s.flags._mingying) {
        s.flags._mingying = true;
        s.hp = Math.max(10, s.hp - 25);
        emit({ type: 'event', tag: T.tags.tough, text: fmt(variant(W.mingyingText, 'mingyingText')) });
        return;
      }
      s.alive = false;
      s.cause = cause;
      s.hp = 0; // 人走了，健康也就沒了（否則會出現「病故、健 96」）
      if (entry) entry.death = true;
    }

    // 小時候（八歲上下）住在哪裡
    function homePlace() {
      const s = S();
      let r = null;
      for (const [y, , pl] of s.regionHist || []) if (r === null || y <= s.birthYear + 8) r = pl;
      return r || s.place;
    }
    // 小時候住的地方跟現在分屬不同的統治者：老家的事傳不過來，人也回不去
    function homeAcross() {
      const s = S();
      let hr = null;
      for (const [y, r] of s.regionHist || []) if (hr === null || y <= s.birthYear + 8) hr = r;
      return across(hr);
    }
    // 祖墳在國界的另一邊，或是一家人搬走五十年以上、老家早就斷了音信：捎不來信，也回不去修墳
    function tombAcross() {
      const s = S(), h = s.regionHist || [];
      if (!h.length || s.place === h[0][2]) return false;
      const left = (h.find((x) => x[2] !== h[0][2]) || [])[0];
      return across(h[0][1]) || (left !== undefined && s.year - left >= 50);
    }
    // 兩地這一年分屬不同的統治者（world.regionControl）
    function across(hr) {
      const s = S();
      if (!hr || hr === s.region) return false;
      return powerOf(hr, s.year) !== powerOf(s.region, s.year);
    }
    const moveNote = (name) => emit({ type: 'note', tag: T.tags.move, text: tpl(T.moveText, { to: name }) });
    function moveTo(id, quiet) {
      const s = S();
      const r = W.regions.find((x) => x.id === id);
      if (!r || s.region === id) return;
      s.region = r.id; s.regionName = r.name; s.place = r.place;
      // 綁在原地的身分（例如替莊主種地）：搬走了就不算了（world.moveClearFlags）
      for (const f of W.moveClearFlags || []) delete s.flags[f];
      (s.regionHist || (s.regionHist = [])).push([s.year, r.id, r.place]);
      // 搬到別家的地盤：原本跟著哪一家，到了這裡都只是新來的百姓
      const CIV = W.civFaction || 'civ';
      if (r.faction && s.year >= (r.factionFrom ?? 0) && s.year <= (r.factionUntil ?? 9999) && s.faction && s.faction !== CIV && s.faction !== r.faction) s.faction = CIV;
      if (!quiet) moveNote(r.name);
    }

    function apply(eff, entry) {
      if (!eff) return;
      const s = S();
      const delta = {};
      for (const k of STATS) {
        if (eff[k]) {
          const before = s.stats[k];
          s.stats[k] = clamp(before + eff[k], 0, 100);
          if (s.stats[k] !== before) delta[k] = s.stats[k] - before;
        }
      }
      if (eff[HP]) {
        const before = s.hp;
        s.hp = clamp(before + eff[HP], 0, 100);
        if (s.hp !== before) delta[HP] = s.hp - before;
      }
      for (const f of arr(eff.flag)) {
        if (!s.flags[f]) { (s.flagYear || (s.flagYear = {}))[f] = s.year; (s.flagRegion || (s.flagRegion = {}))[f] = s.region; }
        if (arr(W.moveFlags).includes(f) && !s.flags[f]) (s.regionHist || (s.regionHist = [])).push([s.year, s.region, s.place]); // 同一地區另找地方落腳（world.moveFlags）：算是新搬來的
        s.flags[f] = true;
        // 拿到某些旗標就換身分（world.promoteFlags：{ flags, from, to }，例如出來做了官，往後算吏家）
        for (const p of W.promoteFlags || []) if (arr(p.flags).includes(f) && arr(p.from).includes(s.cls)) { s.cls = p.to; s.clsName = (W.classes.find((c) => c.id === p.to) || {}).name || s.clsName; }
        // 搬家：帶上這些旗標，住處就跟著換（子孫也住在新的地方）
        // 也可以照原本住的地方分開寫：{ 甲地: '乙地', '*': '丙地' }；'@home' 是回老家
        const r0 = (W.relocate || {})[f];
        const home = r0 === '@home' ? ((s.regionHist || [])[0] || [])[1] : null; // 回老家：這一家最早落腳、祖墳所在的地方
        const to = home || (r0 && typeof r0 === 'object' ? (r0[s.region] ?? r0['*']) : r0);
        const pl = (W.relocatePlace || {})[f];
        const plOk = pl && (!pl.from || pl.from === s.region);
        if (home && home === s.region) { const r = W.regions.find((x) => x.id === home); if (r && s.place !== r.place) { s.place = r.place; s.regionName = r.name; s.regionHist.push([s.year, r.id, r.place]); moveNote(r.name); } } // 老家跟現在同一個地區：只換地名
        else if (to) moveTo(to, plOk);
        if (plOk && s.place !== pl.place) { s.place = pl.place; s.regionName = pl.name; (s.regionHist || (s.regionHist = [])).push([s.year, s.region, s.place]); moveNote(pl.name); }
      }
      if (eff.region) moveTo(eff.region);
      for (const f of arr(eff.unflag)) delete s.flags[f];
      if (eff.route) s.route = eff.route;
      if (eff.faction) s.faction = eff.faction;
      // 某個勢力、某個地方才有的制度：跟了別的勢力、或搬到別處，就不再是（world.dropFlags：{ flags, factions, regions }）
      for (const d of W.dropFlags || []) if (arr(d.factions).includes(s.faction) || arr(d.regions).includes(s.region)) for (const f of arr(d.flags)) delete s.flags[f];
      if (eff.focus) s.focus = eff.focus;
      if (eff.campaignEnd) delete s.campaignYear; // 脫下軍服：往後不再算跟著隊伍在外
      if (eff.spouse) {
        s.spouse = eff.spouse === '@random' ? spouseName(s.gender === 'm' ? 'f' : 'm') : eff.spouse;
        s.spouseYear = s.year;
        // 當家的女兒成親，是對方搬進這個家（招婿）：往後生的孩子跟著這個家姓
        if (s.gender === 'f' && s.flags.heir) s.flags.zhui = true; else delete s.flags.zhui;
        // 換了一個人：前一個配偶的那些事跟這一個無關（world.spouseResetFlags）
        for (const k of W.spouseResetFlags || []) delete s.flags[k];
      }
      if (eff.injure) {
        s.injuries.push(fmt(eff.injure));
        emit({ type: 'note', text: tpl(T.injureText, { what: fmt(eff.injure) }) });
      }
      if (eff.bond) {
        for (const id in eff.bond) {
          const def = data.bonds[id];
          const before = s.bonds[id] || 0;
          const after = clamp(before + eff.bond[id], 0, def.tiers.length - 1);
          s.bonds[id] = after;
          if (after > before) {
            emit({ type: 'bond', bond: id, tier: after, text: tpl(T.bondText, { who: def.name, tier: def.tiers[after] }) });
          }
        }
      }
      if (eff.later) for (const l of arr(eff.later)) s.scheduled.push({ year: s.year + l.in, id: l.id, at: s.region + '/' + (s.place || '') });
      if (eff.child) {
        // 孩子跟父姓：自己是男的跟自己姓，自己是女的跟配偶姓（招婿進門的，跟這個家姓）
        const sur = s.gender === 'm' || s.flags.zhui ? s.surname : (s.spouse ? s.spouse[0] : s.surname);
        const cg = R() < 0.5 ? 'm' : 'f';
        const nm = kidName(sur, cg);
        s.children.push({ name: nm, gender: cg, born: s.year, alive: true });
        s.flags.has_child = true;
      }
      // 標記剛剛條件挑中的那個兒子（或孩子），之後的消息要落在同一個人身上
      if (eff.tagKid) {
        const nm = s._tagKid || s._son || s._kid;
        const c = s.children.find((x) => x.name === nm && x.alive);
        if (c) c.tag = eff.tagKid;
      }
      // 把家交給了這個孩子：日後接家，名單上這個孩子排在頭一個
      if (eff.kidHouse) {
        const nm = s._tagKid || s._kid;
        const c = s.children.find((x) => x.name === nm && x.alive);
        if (c) { for (const x of s.children) delete x.house; c.house = true; }
      }
      // 孩子成親：記下來，這個孩子日後接家時就是已經成了家的人
      if (eff.kidWed) {
        const c = s.children.find((x) => x.name === s._kid && x.alive);
        if (c) { c.wed = true; c.wedYear = s.year; }
      }
      if (eff.childDie) {
        // 沒指定是哪一個，就是家裡年紀最小、還在身邊的那個
        const youngest = () => s.children.filter((x) => x.alive && !x.away).sort((x, y) => y.born - x.born)[0] || s.children.filter((x) => x.alive).pop();
        const c = typeof eff.childDie === 'string'
          ? (s.children.find((x) => x.alive && x.tag === eff.childDie) || youngest())
          : youngest();
        if (c) c.alive = false;
        if (!s.children.some((x) => x.alive)) delete s.flags.has_child;
      }
      // 孩子出門在外幾年（跟人去闖、去城裡謀生）：這幾年家裡的事不會找上這個孩子
      if (eff.kidOut) {
        const c = s.children.find((x) => x.name === (s._son || s._kid) && x.alive);
        if (c) c.outUntil = s.year + eff.kidOut;
      }
      if (eff.childAway) {
        // 條件挑中的那個孩子（req.child / son）；沒有就是最後添的那一個
        const nm = s._tagKid;
        const c = s.children.find((x) => x.alive && !x.away && x.name === nm) || s.children.filter((x) => x.alive && !x.away).pop();
        if (c) c.away = true;
      }
      if (entry && Object.keys(delta).length) entry.delta = Object.assign(entry.delta || {}, delta);
      if (eff.die) die(eff.die, entry);
      if (eff.risk && s.alive) {
        const p = chance(eff.risk);
        if (R() < p) {
          die(eff.risk.cause, entry);
          if (!s.alive) s.fell = true; // 死在選項裡（戰場、路上）：人沒有回到家
        }
      }
      if (s.hp <= 0 && s.alive) die(eff.hpCause || T.hpCause, entry);
    }

    // ---------- 事件
    function fire(ev) {
      const s = S();
      histText = !!ev.year;
      s.fired[ev.id] = (s.fired[ev.id] || 0) + 1;
      // 這件事的條件挑中的是哪個孩子（tagKid 要標在他身上）：同一年先前別件事挑過的兒子不算
      { const r0 = ev.req || {}; s._tagKid = r0.son ? s._son : (r0.child || r0.kidTag) ? s._kid : null; }
      if (ev.kind !== 'flavor' && isCampaign(ev)) {
        s.campaignYear = s.year;
        if (!s.flags.served) { s.flags.served = true; (s.flagYear || (s.flagYear = {})).served = s.year; } // 這輩子上過戰場
      }
      // 祖上傳說：{elder} 指的是真正做過那件事的人
      const pf = typeof ev.req?.flag === 'string' && ev.req.flag.startsWith('p_') ? ev.req.flag.slice(2) : null;
      s._elder = pf ? (s.elders || {})[pf] || null : null;
      // 同一件小事在家族裡第二次發生時，換一種寫法
      // 同一件人生大事（接家、四十、六十）每一代都會碰到：依時代與家境換一段開場
      const tvi = (ev.textIf || []).findIndex((v) => meets(v.req));
      const text = tvi >= 0 ? variant(homeText(ev.textIf[tvi].text), ev.id + '@' + tvi, ev.id) : variant(homeText(withAlt(ev.text, ev.alt)), ev.id, ev.textIf && ev.id);
      // 家族記得每件事發生過幾次、最近一次是哪一年：後代少碰重複的事
      {
        const fam = s.familySeen || (s.familySeen = {});
        fam[ev.id] = (fam[ev.id] || 0) + 1;
        fam['@' + ev.id] = s.year;
      }
      const entry = emit({
        type: ev.choices ? 'decision' : 'event', id: ev.id, kind: ev.kind,
        tag: ev.tag, title: ev.title ? fmt(ev.title) : null, text, note: ev.note || null,
        who: ev.who || null, scene: ev.scene || null, // 插圖：介面依 data/scenes.json 畫這一幕
      });
      apply(ev.eff, entry);
      if (!s.alive) return;
      if (ev.choices) {
        const opts = ev.choices
          .map((c, i) => ({ c, i }))
          .filter(({ c }) => meets(c.show))
          .map(({ c, i }) => ({
            i, t: fmt(tOf(c, ev.id + '#' + i)), sub: fmt(subOf(c, ev.id + '#' + i)) || null,
            ok: meets(c.req), lock: c.lock ? fmt(c.lock) : null,
          }));
        if (!opts.some((o) => o.ok)) opts[opts.length - 1].ok = true; // 保底：至少一條路
        g.pending = { ev, entry, opts };
      }
    }

    // 選項本身的字：同樣可以依條件換寫法（例如本來就住在那裡的人，不說「去那裡」）
    function tOf(c, key) {
      const ti = (c.tIf || []).findIndex((v) => meets(v.req));
      return ti >= 0 ? variant(c.tIf[ti].t, key + 't' + ti) : variant(withAlt(c.t, c.tAlt), key);
    }
    // 選項底下的小字：先看有沒有依條件（例如性別）換的寫法，再從幾種寫法裡輪一種
    function subOf(c, key) {
      const si = (c.subIf || []).findIndex((v) => meets(v.req));
      return si >= 0 ? variant(c.subIf[si].sub, key + 's' + si) : variant(withAlt(c.sub, c.subAlt), key + 's');
    }
    function resolve(c, ev, label) {
      const s = S();
      const head = emit({ type: 'choice', id: ev.id, text: label || c.t, title: ev.title ? fmt(ev.title) : null });
      const ov0 = (c.outIf || []).find((v) => meets(v.req)), at0 = s.region + '/' + s.place; // 這個選項搬了家：看的是搬走以前住在哪裡
      apply(c.eff, head);
      // 這一下沒活過去：不能再接「你第三天夜裡才爬出來」那種寫活下來的結果
      const ov = at0 !== s.region + '/' + s.place ? ov0 : (c.outIf || []).find((v) => meets(v.req));
      const out = !s.alive && c.deathOut ? c.deathOut : ov ? variant(ov.out, ev.id + '#' + c.t + '@') : variant(homeText(withAlt(c.out, c.outAlt)), ev.id + '#' + c.t);
      if (out) {
        // 搬家的小字（「你家從此落腳在…」）排在選項結果後面，不要先講落腳、再講一路往南走
        const moved = g.out.slice(g.out.indexOf(head) + 1).filter((e) => e.type === 'note' && e.tag === T.tags.move);
        for (const list of [g.out, s.log]) for (const e of moved) list.splice(list.lastIndexOf(e), 1);
        emit({ type: 'event', text: out });
        g.out.push(...moved); s.log.push(...moved);
      }
      let branch = null;
      if (s.alive && c.chk) {
        branch = R() < chance(c.chk) ? c.ok : c.fail;
      }
      if (branch && s.alive) {
        const key = ev.id + '#' + c.t + (branch === c.ok ? '+' : '-');
        // 同一個結果換個時候發生，寫法和結果都不同（例如某個制度開始以前，結果另有寫法）
        const bv = (branch.outIf || []).find((v) => meets(v.req));
        if (bv) branch = { ...branch, out: bv.out, outAlt: null, eff: bv.eff ?? branch.eff };
        const e = branch.out ? emit({ type: 'event', text: variant(withAlt(branch.out, branch.outAlt), key) }) : head;
        apply(branch.eff, e);
      }
      const next = (branch && branch.next) || c.next;
      if (next && s.alive) g.queue.unshift(...arr(next).map((id) => ({ id, force: true })));
      // 「這一生的抉擇」給玩家看：沒有標題就用分類名，不要露出英文代號
      s.choices.push({ age: s.age, year: s.year, title: ev.title ? fmt(ev.title) : (ev.tag || T.tags.choice), pick: label || fmt(c.t), id: ev.id });
    }

    // ---------- 出生
    function randomSurname() {
      const N = data.world.names;
      return N.surnames[Math.floor(R() * N.surnames.length)];
    }
    function randomGiven(gender) {
      const N = data.world.names;
      const pool = gender === 'm' ? N.male : N.female;
      return pool[Math.floor(R() * pool.length)];
    }
    // 抽到書裡寫到的人名、地名、年號，順著名冊往下換一個（不動用亂數）
    function unfamous(nm, gender) {
      const N = data.world.names, av = N.avoid || [];
      if (!av.includes(nm)) return nm;
      const pool = gender === 'm' ? N.male : N.female;
      let i = pool.indexOf(nm.slice(1));
      if (i < 0) return nm;
      for (let k = 0; k < pool.length && av.includes(nm[0] + pool[i]); k++) i = (i + 1) % pool.length;
      return nm[0] + pool[i];
    }
    function randomName(gender) { return unfamous(randomSurname() + randomGiven(gender), gender); }
    // 玩伴不跟自己、父母、兄弟姊妹同名（白承祖的玩伴叫徐承祖，讀起來像同一個人）。
    // 撞名時順著名冊往下挑，不動用亂數，舊存檔重播不走樣
    function unclashFriend(s) {
      const pool = data.world.names.male;
      const used = [s.name, s.parentName, ...s.siblings.map((x) => x.name)].filter(Boolean).map((n) => n.slice(1));
      let i = pool.indexOf(s.friend.slice(1));
      if (i < 0) return;
      for (let k = 0; k < pool.length && used.includes(pool[i]); k++) i = (i + 1) % pool.length;
      s.friend = s.friend[0] + pool[i];
    }
    // 弟妹也不跟自己、父母或其他兄弟姊妹同名（史禮的弟弟又叫史禮，接班時就分不清誰是誰的爹）。同樣順著名冊往下挑，不動用亂數
    function unclashSiblings(s, from, extra) {
      const N = data.world.names;
      for (let j = from; j < s.siblings.length; j++) {
        const c = s.siblings[j], pool = c.gender === 'm' ? N.male : N.female;
        const used = [s.name, s.parentName, ...(extra || []), ...s.siblings.filter((x, k) => k !== j).map((x) => x.name)].filter(Boolean).map((n) => n.slice(1));
        let i = pool.indexOf(c.name.slice(1));
        if (i < 0 || !used.includes(pool[i])) continue;
        for (let k = 0; k < pool.length && used.includes(pool[i]); k++) i = (i + 1) % pool.length;
        c.name = c.name[0] + pool[i];
      }
    }
    // 配偶（含續弦、再嫁）的名，不跟自己或家裡孩子的名重複
    function spouseName(gender) {
      const s = S();
      const used = [s.name, ...s.children.map((c) => c.name), ...(s.forbid || [])].map((n) => n.slice(1)); // 也不跟長輩同名
      let nm = randomName(gender);
      for (let k = 0; k < 12 && used.includes(nm.slice(1)); k++) nm = randomName(gender);
      // 同姓不婚：抽到跟自己同姓的，順著姓氏名冊往下換一個（不動用亂數，只有原本同姓的那幾局會不一樣）
      if (nm[0] === s.name[0]) { const L = data.world.names.surnames; nm = L[(L.indexOf(nm[0]) + 1) % L.length] + nm.slice(1); }
      return nm;
    }
    // 孩子取名：不跟兄姊同名，也不用父母、祖上的名（古人避諱），更不能跟配偶同名同姓
    function kidName(sur, cg) {
      const s = S();
      const avoid = [s.name, s.spouse, ...(s.forbid || [])].filter(Boolean);
      const bad = (nm) => s.children.some((c) => c.name === nm) || avoid.some((n) => n === nm || n.slice(1) === nm.slice(1));
      // 先換掉書裡寫到的名字再查撞名，換過的名字也不能跟父母、配偶撞
      let nm = unfamous(sur + randomGiven(cg), cg);
      for (let k = 0; k < 12 && bad(nm); k++) nm = unfamous(sur + randomGiven(cg), cg);
      return nm;
    }

    function born() {
      const region = pickWeighted(R, W.regions, (r) => r.w);
      // 身分可以限定出生地（classes[].regions，例如府兵多在關中）
      const cls = pickWeighted(R, W.classes, (c) => (!c.regions || c.regions.includes(region.id) ? c.w : 0));
      const gender = R() < 0.5 ? 'm' : 'f';
      const birthYear = pickWeighted(R, W.birthYears, (b) => b.w).y;
      const talents = [];
      while (talents.length < 2) {
        const t = pickWeighted(R, W.talents.filter((x) => !talents.includes(x.id)), (x) => x.w);
        talents.push(t.id);
      }
      // 有自己姓氏的身分（classes[].surnames，例如胡人用本族的姓）
      const surname = cls.surnames ? cls.surnames[Math.floor(R() * cls.surnames.length)] : randomSurname();
      g.st = {
        name: unfamous(surname + randomGiven(gender), gender), surname, gender, birthYear, year: birthYear, age: 0,
        children: [], siblings: [], generation: 1, lineage: [],
        region: region.id, regionName: region.name, place: region.place, regionHist: [[birthYear, region.id, region.place]],
        cls: cls.id, clsName: cls.name, talents,
        stats: Object.assign(zeroStats(), cls.stats),
        hp: 70, flags: {}, bonds: {}, focus: null, route: null, faction: null, chapter: 1, spouse: null,
        friend: randomName('m'), injuries: [], fired: {}, scheduled: [], choices: [], log: [],
        alive: true, cause: null, firstLife: true,
      };
      const s = g.st;
      const nSib = 1 + Math.floor(R() * 3);
      for (let i = 0; i < nSib; i++) {
        const sg = R() < 0.5 ? 'm' : 'f';
        s.siblings.push({ name: unfamous(surname + randomGiven(sg), sg), gender: sg, born: birthYear + 1 + Math.floor(R() * 8), alive: true });
      }
      unclashSiblings(s, 0);
      unclashFriend(s);
      for (const t of talents) {
        const def = W.talents.find((x) => x.id === t);
        if (def.eff) apply(def.eff, null);
      }
      s.birth = {
        era: era(birthYear), ganzhi: gz(birthYear),
        region, cls, talents: talents.map((t) => W.talents.find((x) => x.id === t)),
        family: fmt(pickWeighted(R, cls.family, () => 1)),
      };
      emit({ type: 'event', tag: T.tags.birth, text: fmt(W.birthText), scene: 'birth' });
      emit({ type: 'event', text: s.birth.family });
      g.queue = buildYearQueue();
    }

    // ---------- 年度流程
    // 祖上碰過的排程抉擇，再碰到的機會：童年的卡打折少；隔得很久（曾祖那一輩）的也放寬一些
    function repeatRate(e) {
      const W = data.world;
      if (e.age[1] <= 15) return W.familyRepeatChild ?? 0.6;
      const ago = S().year - ((S().familySeen || {})['@' + e.id] ?? -999);
      if (ago >= (W.familyRepeatOldGap ?? 45)) return W.familyRepeatOld ?? 0.5;
      return W.familyRepeatStage ?? 0.3;
    }
    function buildYearQueue() {
      const s = S();
      const q = [];
      // 因果：多年前排下的事
      for (const sc of s.scheduled.filter((x) => x.year === s.year)) q.push({ id: sc.id, force: true, at: sc.at });
      s.scheduled = s.scheduled.filter((x) => x.year !== s.year);
      // 主線、羈絆、人生階段：照順序，執行時才判斷條件
      const due = scheduledPool
        .filter((e) => !e.year || (s.year >= arr(e.year)[0] && s.year <= (arr(e.year)[1] ?? arr(e.year)[0])))
        .filter((e) => !e.age || (s.age >= e.age[0] && s.age <= e.age[1]))
        // 有年份的時代大事，家族裡有人經歷過就不再重演（familyRepeat 例外）
        .filter((e) => !e.year || e.familyRepeat || !ancestorsSaw(e.id));
      // 這一年本來就有兩張以上的大事抉擇（例如亂起的那一年），與史實無關的人生抉擇就讓一讓
      let pTaken = due.filter((e) => e.p == null && e.choices && !s.fired[e.id] && meets(e.req)).length >= 2;
      const cand = due
        // 有 p 的人生抉擇：在年齡範圍裡每年只有 p 的機會，不會人人都在同一歲碰上；範圍的最後一年一定輪到
        // 同一年最多一張這種抉擇，其餘順延到之後的年份（接家那年常會一口氣湧上好幾張）
        .filter((e) => {
          if (e.p == null || !e.age || s.fired[e.id]) return true;
          // 排入時就要符合條件：否則年中剛成親、剛添丁，限定條件的幾張會在同一年一起湧上來
          // 家族裡有人碰過的：機會打折，最後一年也不保底；familyOnce 的一個家族只碰一次
          // 童年的抉擇打折少一點（familyRepeatChild）：小時候接家的孩子能挑的卡本來就少，再碰到也會換一種開場
          const rep = !e.familyRepeat && (s.familySeen || {})[e.id], last = !rep && s.age >= e.age[1];
          if (rep && (e.familyOnce || s.year - (s.familySeen['@' + e.id] ?? -999) < (e.age[1] <= 15 ? (data.world.familyRepeatGapChild ?? 15) : (data.world.familyRepeatGap ?? 25)))) return false;
          if (!meets(e.req) || (pTaken && !last) || (!last && R() >= e.p * (rep ? repeatRate(e) : 1))) return false;
          pTaken = true;
          return true;
        })
        .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
      for (const e of cand) q.push({ id: e.id });
      // 隨機小事：每年一到三件，多數年份兩件
      const n = R() < 0.25 ? 1 : R() < 0.7 ? 2 : 3;
      const picked = [];
      for (let i = 0; i < n; i++) {
        // 同一組的小事一年只會有一件（例如豐收和蝗災不會同一年發生）
        const elderDue = s.elderBorn != null && s.year - s.elderBorn >= ELDER_AGE ? (W.elderEvents || {})[s.elderParent] : null;
        const pool = flavorPool.filter((e) => e.id !== elderDue && !picked.includes(e) && !(e.group && picked.some((x) => x.group === e.group)) && okFlavor(e));
        // 祖上經歷過的小事，接班人比較少再碰上一模一樣的
        const fam = S().familySeen || {};
        const ev = pickWeighted(R, pool, (e) => (e.w ?? 1) * (fam[e.id] ? (data.world.familyRepeatWeight ?? 0.35) : 1));
        if (ev) picked.push(ev);
      }
      for (const e of picked) q.push({ id: e.id, flavor: true });
      // 還活著的那一位家長過了 world.elderMaxAge 歲，這一年走了（world.elderEvents 指定寫哪一則）；接家的人還小，就只記下來
      // 排在這一年最後；人跟著隊伍在外的那一年，留到明年
      if (s.elderBorn != null && !s.flags[s.elderParent + '_dead'] && s.year - s.elderBorn >= ELDER_AGE) {
        if (s.age >= 18 && (W.elderEvents || {})[s.elderParent]) q.push({ id: W.elderEvents[s.elderParent], force: true, flavor: true }); else s.flags[s.elderParent + '_dead'] = true;
      }
      return q;
    }
    const ELDER_AGE = W.elderMaxAge ?? 82;

    // 祖上（不是自己）碰過這件事：家族記錄的次數比自己這輩子的多
    function ancestorsSaw(id) {
      const s = S();
      return ((s.familySeen || {})[id] || 0) > (s.fired[id] || 0);
    }

    function okFlavor(e) {
      const s = S();
      if (!e.textIf && aloneNow() && [e.text, ...(e.alt || [])].every((t) => HOUSEHOLD.test(t))) return false;
      if (!e.repeat && s.fired[e.id]) return false;
      if (e.repeat && s.fired[e.id] >= e.repeat) return false;
      // 可重複的小事：同一個人碰過以後，至少隔 repeatGap 年才會再碰到
      if (e.repeat && e.repeatGap && s.fired[e.id] && s.year - ((s.familySeen || {})['@' + e.id] ?? -999) < e.repeatGap) return false;
      // 祖上傳說這類只該說一次的小事：家族裡誰聽過了，後代就不再重複
      if (e.familyOnce && (s.familySeen || {})[e.id]) return false;
      if (e.year && !(s.year >= e.year[0] && s.year <= e.year[1])) return false;
      if (e.year && !e.familyRepeat && ancestorsSaw(e.id)) return false;
      // 人跟著隊伍在外打仗的那幾年，家鄉的日常輪不到你，碰到的是軍中的小事；時代的消息、祖上的傳說照常聽得到
      {
        const away = awayAtWar();
        if (e.camp && !away) return false;
        if (away && !e.camp && !e.year && !String(e.req?.flag || '').startsWith('p_')) return false;
        if (away && e.homeOnly) return false; // 有年份的小事，寫的是家裡的日子，人在外也碰不上
      }
      // 被關在某處的那幾年（world.insideFlag，例如沒入官府），碰到的是裡頭的事（事件標 inside）
      if (e.inside && !inside()) return false;
      if (inside() && !e.inside && !e.year && !String(e.req?.flag || '').startsWith('p_')) return false;
      if (inside() && e.homeOnly) return false;
      if (e.p != null && R() >= e.p) return false; // 稀有小事：每年只有 p 的機會進候選
      return meets(e.req);
    }

    function canFire(item) {
      const ev = byId[item.id];
      if (!ev) return null;
      const s = S();
      // 里中要你出面的事（修橋、爭水、作保、收留人），人跟著隊伍在外、或被關在某處的那幾年碰不上
      // 家鄉那邊排定的後續也一樣，人不在就作罷
      if (!ev.year && (AWAY_TAGS.has(ev.tag) || ev.homeOnly) && (awayAtWar() || inside())) return null;
      // 身在官府管不到的勢力裡（world.lawlessFactions）：里中的事碰不上，寫給那個勢力的除外
      if (!ev.year && (HOME_TAGS.has(ev.tag) || ev.homeOnly) && arr(W.lawlessFactions).includes(s.faction) && !arr((ev.req || {}).faction).includes(s.faction)) return null;
      // 排定以後全家搬走了（例如鄰里的後續），搬到新地方就碰不上了
      if (item.at && item.at !== s.region + '/' + (s.place || '') && !ev.year && (HOME_TAGS.has(ev.tag) || ev.homeOnly)) return null;
      // 出征在外的那一年，家鄉的瑣事輪不到你（年邁的家長過世也一樣，留到明年再說）
      if (item.flavor && s.campaignYear === s.year) return null;
      if (item.flavor && !item.force && inside() && !ev.inside && !ev.year) return null; // 年初排好的小事，這一年人被關進去了就作罷
      if (item.flavor && ev.inside && !inside()) return null; // 裡頭的小事，這一年人放出來了就作罷
      if (item.flavor && ev.camp && !awayAtWar()) return null; // 軍中的小事，這一年隊伍散了、人回了家就作罷
      // 排定的後續通常不再看條件；標了 recheck 的（例如幾年後再來說媒），到時候還要再確認一次
      const elderKey = Object.keys(W.elderEvents || {}).find((k) => W.elderEvents[k] === item.id);
      if (item.force && elderKey && s.flags[elderKey + '_dead']) return null; // 這一年已經寫過過世了
      if (item.force) return ev.recheck && !meets(ev.req) ? null : ev;
      // 接家那年已經問過往後怎麼過，就略過某些人生大事（world.skipInHeirYear：{ event, ifFired }）
      if ((W.skipInHeirYear || []).some((x) => x.event === ev.id && s.heirYear === s.year && s.fired[x.ifFired])) return null;
      const CA = W.campaignAge || [15, 55];
      if (ev.kind !== 'flavor' && isCampaign(ev) && (s.age > CA[1] || s.age < CA[0]) && !ev.req?.age) return null; // 上了年紀的、還小的不跟著隊伍出征
      if (ev.kind !== 'flavor' && s.fired[ev.id] && !ev.repeat) return null;
      // 人被關著：外頭的事輪不到你拿主意；沒有年份的人生大事（說親、借貸、入社……）也碰不上
      if (inside() && ev.kind === 'stage' && (ev.choices || !ev.year) && !ev.inside && !arr(ev.req?.flag).some((f) => INSIDE.includes(f))) return null;
      // 要你拿主意的劇情卡，沒寫年齡就當作是給大人的（年幼的接班人不會被問要不要上陣）
      const r = ev.req || {};
      if (ev.choices && !ev.age && !r.age && !r.son && !r.child && r.married == null && s.age < (W.minChoiceAge ?? 14)) return null;
      return meets(ev.req) ? ev : null;
    }

    function endYear() {
      const s = S();
      const W = data.world;
      // 人生重心帶來的慢慢累積
      // 年輕時學得快：三十歲前每年累積，三十一到四十五歲隔年一次，之後不再累積
      if (s.focus && (s.age <= 30 || (s.age <= 45 && s.age % 2 === 0))) {
        const f = W.focus[s.focus];
        if (f && f.yearly) apply(f.yearly, null);
      }
      // 年紀與疫病
      const band = W.mortality.find((m) => s.age >= m.age[0] && s.age <= m.age[1]);
      let h = band ? band.p : 0.05;
      // 疫年：數字是天下大疫；{year, regions} 是只在某些地方流行的疫病
      const plague = W.plagueYears.some((y) => typeof y === 'number' ? y === s.year : y.year === s.year && (!y.regions || y.regions.includes(s.region)));
      if (plague) h *= W.plagueMult;
      h *= 1.6 - s.hp / 100;
      h *= 1 + 0.25 * s.injuries.length;
      // 第一代的主角在五歲前大多能撐過來（否則一投胎就結束）；撐過來的那一次，留下一句話
      const r = R();
      // 還沒有弟妹可以接手的時候一定撐得過去，否則一投胎就結束
      const noBackup = !s.siblings.some((c) => c.alive && c.born <= s.year);
      const spared = s.firstLife && s.age < 5 ? (noBackup ? 1 : plague ? 0 : (W.firstChildSpare ?? 0)) : 0;
      if (r < h && r >= h * (1 - spared)) {
        if (!s.nearlyLost) {
          s.nearlyLost = true;
          emit({ type: 'event', tag: T.tags.danger, text: fmt(variant(W.nearlyLostText, 'nearlyLostText')), scene: 'sick' });
        }
      } else if (r < h) {
        const cause = plague ? T.plagueCause : band.cause;
        // 命硬的人這一次撐得過去：先寫病倒，不要先寫「沒有再醒來」再讓他活過來
        if (tough() && !s.flags._mingying && W.mingyingIllText) {
          emit({ type: 'event', tag: T.tags.danger, text: fmt(variant(W.mingyingIllText, 'mingyingIllText')), scene: 'sick' });
          die(cause, null);
        } else {
          const entry = emit({ type: 'event', tag: T.tags.end, text: fmt(plague ? variant(W.plagueDeathText, 'plagueDeathText') : variant(band.text, 'band' + band.age[0])), scene: 'death' });
          die(cause, entry);
        }
      }
      // 配偶也會老、會病：大致跟你同齡，死亡率比照你這個年紀（當年才成親的，那一年不會走；成親沒幾年的，另有寫法）
      if (s.alive && spouseHere() && s.age >= 30 && band && R() < band.p * (W.spouseMortality ?? 0.9) * (plague ? W.plagueMult : 1) && s.spouseYear !== s.year) {
        apply({ flag: 'spouse_dead_old', [HP]: -8 }, null);
        // 吵翻了一直沒說開的：不寫「握著你的手」那種
        const pool = (awayAtWar() && W.spouseDeathTextsAway) || (s.flags.am_rift_apart && !s.flags.am_rift_talked && W.spouseDeathTextsCold) || (s.spouseYear != null && s.year - s.spouseYear < 8 && W.spouseDeathTextsShort) || W.spouseDeathTexts || [];
        emit({ type: 'event', tag: T.tags.widow, text: fmt(pool[Math.floor(R() * pool.length)] || T.spouseDeathFallback), scene: 'funeral' });
      }
      // 成了家的人，從成親的第二年起，每年有一定機會添一個孩子（夫妻都過了四十，機會小得多；人跟著隊伍在外，只有告假回家的時候）
      if (s.alive && spouseHere() && s.year !== s.spouseYear && s.age >= 16 && s.age <= 45 && s.children.length < 6 && R() < (W.childChance ?? 0.2) * (s.age > 40 ? 0.3 : 1) * (awayAtWar() ? 0.4 : 1)) {
        apply({ child: true }, null);
        emit({ type: 'event', tag: T.tags.child, text: fmt(awayAtWar() && W.childTextAway ? variant(W.childTextAway, 'childTextAway') : variant(W.childText, 'childText')), scene: 'birth' });
      }
      if (s.alive && s.age >= 1) s.hp = clamp(s.hp + (s.age < 40 ? 2 : -1), 0, 100);
    }

    function beginYear() {
      const s = S();
      s.year += 1;
      s.age += 1;
      emit({ type: 'year', era: era(s.year), ganzhi: gz(s.year) });
      g.queue = buildYearQueue();
    }

    // 誰能接下這個家：先看自己的孩子，沒有就看還活著的兄弟姊妹。
    // 孩子在背景裡長大，接手的時候才擲一次骰子決定是否平安長大。
    // 上陣打仗的劇情：標了 campaign 的卡、world.campaignRoutes 列出的路線卡，以及軍中勢力限男子的卡
    function isCampaign(ev) {
      const r = ev.req || {};
      if (ev.campaign != null) return ev.campaign === 'm' ? S().gender === 'm' : !!ev.campaign;
      if (r.route && arr(W.campaignRoutes).includes(r.route)) return true;
      return r.gender === 'm' && !!r.faction && !arr(r.faction).includes(W.civFaction || 'civ');
    }
    // 人跟著隊伍在外（world.away）：
    //   factions/maxAge/within：跟了這些勢力的男子、上過戰場、within 年內還出過征、不超過 maxAge 歲
    //   endFlags：拿到這個旗標以後（例如降了、隊伍散了）就不算
    //   rules：另外的情形，每條的條件都符合才算 { flag, faction, gender, years, maxAge, flagWithin }
    function awayAtWar() {
      const s = S(), A = W.away || {};
      const fy = s.flagYear || {};
      if (arr(A.endFlags).some((f) => s.flags[f] && (s.campaignYear ?? -99) <= fy[f])) return false;
      for (const r of A.rules || []) {
        if (r.flag && !arr(r.flag).some((f) => s.flags[f])) continue;
        if (r.faction && !arr(r.faction).includes(s.faction)) continue;
        if (r.gender && s.gender !== r.gender) continue;
        if (r.years && (s.year < r.years[0] || s.year > r.years[1])) continue;
        if (r.maxAge != null && s.age > r.maxAge) continue;
        if (r.flagWithin && !Object.entries(r.flagWithin).every(([f, n]) => s.flags[f] && s.year - (fy[f] ?? -99) <= n)) continue;
        return true;
      }
      return s.gender === 'm' && arr(A.factions).includes(s.faction) && !!s.flags.served && s.age <= (A.maxAge ?? 58) && s.year - (s.campaignYear ?? -99) <= (A.within ?? 3);
    }
    // 被關在某處（world.insideFlag，可以是一個或幾個旗標：被擄、入宮……）
    const INSIDE = arr(W.insideFlag);
    const inside = () => INSIDE.some((f) => S().flags[f]);
    // 一個人過日子：沒有配偶在身邊、沒有活著的孩子、爹娘也都不在了、也沒有還沒長大的弟妹
    function aloneNow() {
      const s = S(), f = s.flags;
      return !spouseHere() && !(s.children || []).some((c) => c.alive) && !!f.father_dead && !!f.mother_dead && !(s.siblings || []).some((c) => c.alive && !c.away && c.born <= s.year && s.year - c.born < 20);
    }
    // 配偶還在身邊：成了親、沒有過世、也沒有被抓走未歸
    function spouseHere() {
      const s = S(), f = s.flags;
      return !!s.spouse && !f.widowed && !f.spouse_dead_old && !(f.spouse_taken && !f.spouse_returned);
    }
    function survivors(list) {
      const s = S();
      return list.filter((c) => {
        if (!c.alive || c.away || c.born > s.year) return false;
        if (c.checked) return true;
        c.checked = true;
        const age = s.year - c.born;
        const p = age < 5 ? 0.82 : age >= 60 ? Math.max(0.05, 1 - (age - 55) * 0.07) : 0.8;
        const r = R(); // 亂數照抽，舊存檔重播才不走樣
        c.alive = c.seen >= s.year - 2 || r < p;
        return c.alive;
      });
    }
    function findHeirs() {
      const s = S();
      let own = survivors(s.children).sort((a, b) => a.born - b.born);
      // 跟著人出去闖、還沒回來的孩子，家裡還有別的孩子在，就不接這個家
      const home = own.filter((c) => !(c.outUntil > s.year));
      if (home.length) own = home;
      const RL = T.rel;
      if (own.length) {
        const list = own.map((c) => ({ ...c, rel: c.gender === 'm' ? RL.son : RL.daughter }));
        // 長子女上了年紀，也可以把家交給長孫。名字、年紀用另一條亂數算，不動主線亂數，舊存檔重播不走樣
        if (s.year - own[0].born >= (W.grandHeirAge ?? 40)) {
          const via = own.find((c) => c.gender === 'm') || own[0];
          const lr = mulberry32((g.seed ^ Math.imul(s.year, 2654435761)) + s.generation);
          const gg = lr() < 0.5 ? 'm' : 'f', N = W.names;
          const sur = via.gender === 'm' ? via.name[0] : N.surnames[Math.floor(lr() * N.surnames.length)];
          const pool = gg === 'm' ? N.male : N.female;
          const taken = [s.name, s.spouse, ...s.children.map((c) => c.name), ...(s.forbid || [])].filter(Boolean).map((x) => x.slice(1)); // 也不跟祖上、早走的叔伯姑姑同名
          let nm = sur + pool[Math.floor(lr() * pool.length)];
          for (let k = 0; k < 12 && taken.includes(nm.slice(1)); k++) nm = sur + pool[Math.floor(lr() * pool.length)];
          const born = Math.min(via.born + 20 + Math.floor(lr() * 8), s.year - 16);
          list.push({ name: nm, gender: gg, born, alive: true, rel: gg === 'm' ? RL.grandson : RL.granddaughter, via: via.name });
          // 列出了長孫，就等於說了這個孩子早已成家；往後輪到他以弟妹身分接家，不能變成一輩子沒成家的人
          list.find((x) => x.name === via.name).knownWed = true;
        }
        const hi = list.findIndex((x) => x.house);
        if (hi > 0) list.unshift(list.splice(hi, 1)[0]);
        return list;
      }
      const sib = survivors(s.siblings).sort((a, b) => a.born - b.born);
      return sib.map((c) => ({ ...c, rel: c.gender === 'm' ? RL.brother : RL.sister, sib: true }));
    }

    // 結局：死了就是這一生的結局（有後人就傳下去）；活著走到章末，若還有下一章就是「章末」，否則是最終結局
    function evaluateEnding() {
      const s = S();
      histText = false;
      const list = data.endings;
      const heirs = !s.alive ? findHeirs() : [];
      const personEnded = !s.alive || !chapterOf(s.chapter + 1);
      const last = (!s.alive && !heirs.length) || (s.alive && !chapterOf(s.chapter + 1));
      const ending = list.find((e) =>
        (e.chapter == null || e.chapter === s.chapter) &&
        (e.when === 'dead' ? !s.alive : e.when === 'alive' ? s.alive : true) &&
        (!e.cause || arr(e.cause).includes(s.cause)) &&
        meets(e.req)) || list[list.length - 1];
      const after = [];
      for (const id in s.bonds) {
        const def = data.bonds[id];
        const tier = s.bonds[id];
        if (tier > 0 && def.after && def.after[tier]) after.push({ who: def.name, tier: def.tiers[tier], text: fmt(def.after[tier]) });
      }
      // 不分章的 final 後記跟著這個人走（人死就出現）；有分章的 final 後記是整段歷史的收尾，只在真正的結局出現
      const shown = (data.world.epilogues || [])
        .filter((e) => (e.chapter == null || e.chapter === s.chapter) &&
          (!e.final || (e.chapter == null ? personEnded : last)) && meets(e.req));
      // 個人往事（不分章的 final 後記）與天下的收尾分開，介面先放往事、最後放天下
      const isMemory = (e) => e.final && e.chapter == null;
      const noKid = !s.children.some((c) => c.alive);
      // 孩子都還小（收養來的、晚生的），說不上「孫子在床邊」
      const noGrand = noKid || !s.children.some((c) => c.alive && s.year - c.born >= 18);
      // 往事只算這輩子親身經歷的：從上一代繼承來的旗標沒有取得的年份
      const fy = s.flagYear || {};
      // pri 高的排前面（故事線的結局比零碎小事更像「這一生」），同級照資料順序
      const picked = shown.filter(isMemory).sort((a, b) => (b.pri || 0) - (a.pri || 0)).map((e) => {
        const f = typeof e.req?.flag === 'string' ? e.req.flag : arr(e.req?.anyFlag).find((x) => s.flags[x] && x in fy);
        if (f && !(f in fy)) return null;
        const since = s.year - (fy[f] ?? s.year);
        let t = e.text;
        if (e.minYears && since < e.minYears) t = e.short ?? null;          // 經歷之後沒活幾年
        if (t && e.beforeYear && s.year >= e.beforeYear) t = e.lateText ?? null; // 文字說的未來，已經過去了
        if (t && s.alive && e.aliveText) t = (e.minYears && since < e.minYears && e.aliveShort) || e.aliveText;                   // 活著走到最後一章
        if (t && s.alive && ALIVE_FORBID.test(t)) t = null;           // 活著的人不能說「你走以後」
        if (t && e.noKid && (noKid || (noGrand && GRAND.test(t)))) t = e.noKid;                              // 膝下沒有孩子
        return t ? { life: !!e.life, t: fmt(t, (s.flagRegion || {})[f]) } : null; // 麥或稻：照事情發生時住的地方
      }).filter(Boolean);
      // 日常故事（life）與歷史經歷輪流排，前三件裡兩種都看得到
      const lifeM = picked.filter((m) => m.life), histM = picked.filter((m) => !m.life), memories = [];
      for (let i = 0; i < Math.max(lifeM.length, histM.length); i++) { if (lifeM[i]) memories.push(lifeM[i].t); if (histM[i]) memories.push(histM[i].t); }
      const epilogue = shown.filter((e) => !isMemory(e)).map((e) => fmt(e.text));
      const result = {
        id: ending.id, title: fmt(ending.title), rare: !!ending.rare, text: fmt(ending.noKid && (noKid || (noGrand && GRAND.test(ending.text))) ? ending.noKid : ending.text),
        alive: s.alive, cause: s.cause, age: s.age, year: s.year, chapter: s.chapter,
        chapterTitle: chapterOf(s.chapter)?.title || null,
        next: s.alive && !last ? chapterOf(s.chapter + 1) : null,
        after: personEnded ? after : [], epilogue, memories,
        name: s.name, generation: s.generation,
      };
      s.chapterEndings = (s.chapterEndings || []).concat([{ chapter: s.chapter, id: result.id, title: result.title, name: s.name }]);
      if (personEnded) s.lineage = s.lineage.concat([{ gen: s.generation, name: s.name, gender: s.gender, born: s.birthYear, died: s.alive ? null : s.year, age: s.age, cause: s.cause, title: result.title, memo: memories[0] }]); // 家譜上每一代留一句往事
      result.lineage = s.lineage;
      if (!s.alive && heirs.length) { result.heirs = heirs.map((h) => ({ name: h.name, gender: h.gender, age: s.year - h.born, rel: h.rel, via: h.via, house: !!h.house })); g.succession = { result, heirs }; return; }
      if (last) { result.extinct = !s.alive; g.ended = result; } else g.interlude = result;
    }

    // 接家的人算不算還在上一代的勢力裡（world.heirFactionReset：{ faction, before, maxAge, notRegions }，條件都符合就改回百姓）
    function heirFaction(f, year, age, region) {
      for (const r of W.heirFactionReset || []) {
        if (r.faction !== f) continue;
        if (r.before != null && year >= r.before) continue;
        if (r.maxAge != null && age > r.maxAge) continue;
        if (r.notRegions && arr(r.notRegions).includes(region)) continue;
        return W.civFaction || 'civ';
      }
      return f;
    }
    // 接班：用選中的孩子建立新的一條人生，家世、勢力、住處、部分財產與名聲傳下去
    function becomeHeir(i) {
      const p = S();
      const { heirs } = g.succession;
      const h = heirs[i] || heirs[0];
      const age = p.year - h.born;
      const isSib = !!h.sib;
      // 上一代當過官、很有名或很有錢，家世往上提（world.heirPromote：由上往下第一條符合的；classes[].rank 比目標低才提）
      let clsId = p.cls;
      const rank = (id) => (W.classes.find((c) => c.id === id) || {}).rank ?? 0;
      for (const pr of W.heirPromote || []) {
        const hit = arr(pr.flags).some((f) => p.flags[f]) || Object.entries(pr.stat || {}).some(([k, v]) => (k === HP ? p.hp : p.stats[k]) >= v);
        if (!hit) continue;
        if (rank(clsId) < rank(pr.to)) clsId = pr.to;
        break;
      }
      const ncls = W.classes.find((c) => c.id === clsId);
      const talents = [];
      if (R() < 0.5) talents.push(p.talents[Math.floor(R() * p.talents.length)]);
      while (talents.length < 2) {
        const t = pickWeighted(R, W.talents.filter((x) => !talents.includes(x.id)), (x) => x.w);
        talents.push(t.id);
      }
      // 數值：照年紀長出來的（world.heirStats.grow，讀書人家另看 growLettered），加上從上一代繼承的（inherit）
      const HS = W.heirStats || {};
      const grow = Math.min(age, 25);
      const stats = Object.assign(zeroStats(), ncls.stats);
      for (const [k, v] of Object.entries({ ...(HS.grow || {}), ...(ncls.lettered ? HS.growLettered || {} : {}) })) stats[k] += Math.floor(grow * v);
      for (const [k, v] of Object.entries(HS.inherit || {})) stats[k] += Math.round((p.stats[k] || 0) * v);
      for (const k of STATS) stats[k] = clamp(stats[k], 0, 100);
      const flags = { heir: true };
      if (age < 14) flags.heir_young = true; // 接手時還小，等長大了才輪到自己拿主意
      if (age < 5) flags.heir_baby = true; // 接手時還不記事：上一代說過什麼、教過什麼，都不記得
      if (p.age < 10) flags.prev_child = true; // 上一位是夭折的孩子：沒有留下家業，也沒有說過什麼話
      if (p.flags.served || p.flags.mil_house) flags.mil_house = true; // 祖上有人當過兵：子孫到了年紀照樣進營
      if (p.flags.served && p.fell) flags.prev_fell = true; // 上一位死在外頭：隨身的東西沒有帶回家
      else if (p.flags.served && p.gender === 'm') flags.prev_served = true; // 上一位當了大半輩子的兵
      if (p.age < 20) flags.prev_young = true; // 上一位走的時候還年輕：沒有用了好些年的舊物、也沒有常掛在嘴邊的話
      // 父母的生死：孩子接班，死去的上一代就是父或母；弟妹接班，父母狀態跟兄姊相同
      if (isSib) {
        if (p.flags.father_dead) flags.father_dead = true;
        if (p.flags.mother_dead) flags.mother_dead = true;
      } else if (h.via) {
        flags.grand_heir = true; // 長孫接班：過世的是祖父母，爹娘都還在
      } else {
        flags[p.gender === 'm' ? 'father_dead' : 'mother_dead'] = true;
        // 另一位家長就是上一代的配偶
        if (p.flags.widowed || p.flags.spouse_dead_old || !p.spouse || (p.flags.spouse_taken && !p.flags.spouse_returned)) flags[p.gender === 'm' ? 'mother_dead' : 'father_dead'] = true; // 被抓走沒回來的，也不在了
        else if (p.gender === 'f') flags.father_in = true; // 上一代是母親當家，父親是後來搬進這個家的：官府裡的差事不是他的
      }
      if (clsId !== p.cls || h.via) flags.father_in = true; // 家世是這一代才提上來的、或是長孫接班：爹沒在官府當過差
      for (const f of W.inheritFlags || []) if (p.flags[f]) flags[f] = true;
      // 上一代當年拿到某個旗標、當年就死了：家裡人還是原來的身分（world.heirSameYearFlags：{ 那個旗標: 換回的旗標 }）
      for (const [f, back] of Object.entries(W.heirSameYearFlags || {})) if (p.flags[f] && (p.flagYear || {})[f] === p.year) flags[back] = true;
      // 祖上的事：記住是誰做的。上一任當家親自做的寫他的名字，更早以前的就只說 fallback.elder
      const elders = {};
      for (const f of W.parentFlags || []) {
        if (p.flags[f]) { flags['p_' + f] = true; elders[f] = p.name; }
        else if (p.flags['p_' + f]) flags['p_' + f] = true;
      }
      const siblings = h.via ? [] : heirs.filter((x) => x !== h && !x.via).map((x) => ({ name: x.name, gender: x.gender, born: x.born, alive: true, checked: false, knownWed: !!(x.wed || x.knownWed) }));
      const surname = h.name[0];
      g.st = {
        name: h.name, surname, gender: h.gender, birthYear: h.born, year: p.year, age,
        // 兄弟姊妹接班還是同一代
        children: [], siblings, generation: isSib ? p.generation : p.generation + (h.via ? 2 : 1), lineage: p.lineage,
        region: p.region, regionName: p.regionName, place: p.place, regionHist: [...(p.regionHist || [])], // 這一家歷年住過的地方：接家的人小時候住哪裡，從這裡查
        cls: clsId, clsName: ncls.name, talents, stats, hp: 70, flags, bonds: {},
        // 上一代跟的勢力，接家的人不一定還算在裡頭（world.heirFactionReset）
        focus: null, route: null, faction: heirFaction(p.faction, p.year, age, p.region), chapter: p.chapter, spouse: null,
        friend: randomName('m'), injuries: [], fired: {}, scheduled: [], choices: [], log: [],
        alive: true, cause: null, chapterEndings: p.chapterEndings, familySeen: { ...(p.familySeen || {}) },
        // 孩子接班：父母就是前一位；弟妹接班：父母跟前一位相同
        parentName: h.via || (isSib ? (p.parentName || null) : p.name),
        elders, heirYear: p.year + 1,
        // 還活著的那一位家長（上一代的配偶），年紀當作跟上一代差不多
        elderBorn: h.via || isSib ? null : p.birthYear, elderParent: p.gender === 'm' ? 'mother' : 'father',
        // 祖上幾代當家和他們的配偶：往後孩子取名都要避開；孫輩接班的，親生父母和叔伯姑姑（前一位的孩子）也一樣
        forbid: [...new Set([...(p.forbid || []), p.name, p.spouse, h.via, ...(p.children || []).map((c) => c.name)].filter((n) => n && n !== h.name))],
      };
      const s = g.st;
      unclashFriend(s);
      for (const t of talents) { const def = W.talents.find((x) => x.id === t); if (def.eff) apply(def.eff, null); }
      s.birth = { era: era(h.born), ganzhi: gz(h.born), region: W.regions.find((r) => r.id === s.region), cls: ncls, talents: talents.map((t) => W.talents.find((x) => x.id === t)), family: '' };
      // 接班時已經成年的人，大多早就成了家，這些年也添了孩子
      let wedText = null;
      // 弟妹早已成家的（成過親、或曾經被列出孩子接班）一定是成了家的人。亂數照樣抽一次，舊存檔重播不走樣
      if ((h.wed && age >= 15) || (age >= 18 && (R() < (age >= 25 ? (W.heirMarried ?? 0.9) : 0.6) || h.knownWed))) {
        s.spouse = spouseName(s.gender === 'm' ? 'f' : 'm');
        // 上一代列出的長孫就是這個人的孩子：先放進孩子名單（女兒接家的，配偶跟著改成孩子的姓）
        // （孩子的名不能犯祖上的諱；長孫的名是上一代取的，沒避開更早的祖上，犯了就不帶進來）
        let gc = !h.via && heirs.find((x) => x.via === h.name);
        if (gc && [s.name, ...s.forbid].some((n) => n.slice(1) === gc.name.slice(1))) gc = null;
        if (gc) {
          // 配偶：女兒接家的改成孩子的姓；名跟姓同字（石石）、或跟孩子同名的，照出生年換一個名，不動主線亂數
          const pool = s.gender === 'f' ? W.names.male : W.names.female;
          const sur = s.gender === 'f' ? gc.name[0] : s.spouse[0];
          let given = s.spouse.slice(1);
          for (let k = 0; (given === sur || given === gc.name.slice(1)) && k < pool.length; k++) given = pool[(gc.born + k) % pool.length];
          s.spouse = sur + given;
          s.children.push({ name: gc.name, gender: gc.gender, born: gc.born, alive: true });
          s.flags.has_child = true;
        }
        const sur = s.gender === 'm' ? s.surname : s.spouse[0];
        for (let y = h.born + 19; y < s.year && y <= h.born + 45; y++) {
          if (s.children.length >= 6 || R() >= (W.heirPastChildRate ?? 0.1)) continue;
          if (R() >= (W.heirPastChildSurvive ?? 0.7)) continue; // 沒能養大的孩子
          const cg = R() < 0.5 ? 'm' : 'f';
          const nm = kidName(sur, cg);
          s.children.push({ name: nm, gender: cg, born: y, alive: true });
          s.flags.has_child = true;
        }
        wedText = age >= 45 && W.heirWedOldText && s.children.some((c) => s.year - c.born >= 20) ? W.heirWedOldText : s.children.length > 1 ? W.heirWedKidsText : s.children.length ? W.heirWedKidText : W.heirWedText;
      }
      g.succession = null;
      g.out = [];
      emit({ type: 'heir', text: tpl(T.heirLine, { gen: cn(s.generation), name: s.name }), gen: s.generation, rel: h.rel });
      emit({ type: 'event', tag: T.tags.heir, scene: 'heir', text: fmt(flags.prev_child && W.heirChildText ? variant(W.heirChildText, 'heirChild') : age < 8 && W.heirYoungText ? variant(W.heirYoungText, 'heirYoung') : variant(W.heirText, 'heirText')) });
      if (h.via) emit({ type: 'event', tag: T.tags.heir, text: fmt(variant(W.heirGrandText, 'heirGrand')) });
      if (wedText) emit({ type: 'event', tag: T.tags.wed, text: fmt(variant(wedText, 'heirWed')) });
      g.queue = [];
      if (s.year >= chapterOf(s.chapter).end) evaluateEnding();
      else beginYear();
      return g.out;
    }

    // ---------- 對外介面
    function step() {
      // 一路往前跑，直到需要玩家抉擇、或這一生結束。回傳這段期間新增的紀錄。
      // 一次走一年：年紀標題和這一年發生的事一起出來，再停下來讓人看（不是先出標題、停一下才出事）
      g.out = [];
      let guard = 0, advanced = false;
      const before = g.out.length;
      while (!g.pending && !g.ended && !g.interlude && !g.succession && guard++ < 500) {
        const s = S();
        if (!s.alive) { evaluateEnding(); break; }
        if (g.queue.length) {
          const item = g.queue.shift();
          const ev = canFire(item);
          if (ev) fire(ev);
          continue;
        }
        // 這一年剩下的事都出完了：已經換過年、或這一步本來就有東西出來，就停在這裡
        // （背後跑祖上幾代時沿用舊的停法：換年後就停。後代投胎選定出生時機靠這個停點，改了舊存檔會對不上）
        if (!opts.ancestor && (advanced || g.out.length > before)) break;
        endYear();
        if (!s.alive) { evaluateEnding(); break; }
        if (s.year >= chapterOf(s.chapter).end) { evaluateEnding(); break; }
        beginYear();
        if (opts.ancestor) break;
        advanced = true;
      }
      return g.out;
    }

    function choose(i) {
      if (!g.pending) return [];
      const { ev, opts } = g.pending;
      const o = opts[i];
      if (!o || !o.ok) return [];
      g.out = [];
      g.pending = null;
      resolve(ev.choices[o.i], ev, o.t);
      if (!S().alive) evaluateEnding();
      return g.out;
    }

    // 投胎到某個家族的後代：先在背後把前幾代的人生真的跑一遍，再讓玩家出生成為這一代當家的孩子
    function bornLate() {
      const L = W.lateStart || {};
      const lr = mulberry32((seed ^ 0x9e3779b9) >>> 0);
      const here = (p) => !!p.spouse && !p.flags.widowed && !p.flags.spouse_dead_old && !(p.flags.spouse_taken && !p.flags.spouse_returned);
      const [y0, y1] = L.years;
      for (let tries = 0; tries < 30; tries++) {
        const target = y0 + Math.floor(lr() * (y1 - y0 + 1));
        const anc = createGame(data, Math.floor(lr() * 2 ** 31), { ancestor: true });
        let k = 0, P = null;
        while (!anc.ended && k++ < 20000) {
          const a = anc.state;
          if (a.year > target + 15) break;
          if (!anc.pending && !anc.interlude && !anc.succession && a.alive && a.year >= target && a.age >= 18 && a.age <= 40 && here(a)) { P = a; break; }
          if (anc.interlude) { anc.continueChapter(); continue; }
          if (anc.succession) { anc.continueAsHeir(0); continue; }
          if (anc.pending) { const ok = anc.pending.opts.filter((o) => o.ok); anc.choose(anc.pending.opts.indexOf(ok[Math.floor(lr() * ok.length)])); continue; }
          anc.step();
        }
        if (P) return bornAsChildOf(P);
      }
      born(); // 很少發生：前幾代一直沒有適合的時機，就照一般方式投胎
    }

    function bornAsChildOf(P) {
      const gender = R() < 0.5 ? 'm' : 'f';
      const surname = P.gender === 'm' || P.flags?.zhui ? P.surname : P.spouse[0];
      const cls = W.classes.find((c) => c.id === P.cls);
      const talents = [];
      while (talents.length < 2) {
        const t = pickWeighted(R, W.talents.filter((x) => !talents.includes(x.id)), (x) => x.w);
        talents.push(t.id);
      }
      // 傳給後代的東西：住處與全家的決定、祖上（已過世那幾代）的傳說
      const flags = {};
      for (const f of W.inheritFlags || []) if (P.flags[f]) flags[f] = true;
      for (const f of W.parentFlags || []) if (P.flags['p_' + f]) flags['p_' + f] = true;
      const older = (P.children || []).filter((c) => c.alive && !c.away).map((c) => ({ name: c.name, gender: c.gender, born: c.born, alive: true }));
      const year = P.year;
      const stats = Object.assign(zeroStats(), cls.stats);
      for (const [k, v] of Object.entries((W.heirStats || {}).lateInherit || {})) stats[k] = clamp(stats[k] + Math.round((P.stats[k] || 0) * v), 0, 100);
      g.st = {
        name: '', surname, gender, birthYear: year, year, age: 0,
        children: [], siblings: [...older], generation: P.generation + 1, lineage: P.lineage.map(({ memo, ...x }) => x), // 自動跑過的祖上不是你親身活過的，不留「你」的往事
        region: P.region, regionName: P.regionName, place: P.place, regionHist: [[year, P.region, P.place]],
        cls: cls.id, clsName: cls.name, talents, stats,
        hp: 70, flags, bonds: {}, focus: null, route: null, faction: heirFaction(P.faction, year, 0, P.region), chapter: P.chapter, spouse: null,
        friend: randomName('m'), injuries: [], fired: {}, scheduled: [], choices: [], log: [],
        alive: true, cause: null, firstLife: true, lateStart: true,
        chapterEndings: P.chapterEndings || [], familySeen: { ...(P.familySeen || {}) },
        parentName: P.name, elders: { ...(P.elders || {}) },
        forbid: [...(P.forbid || []), P.name, P.spouse].filter(Boolean),
      };
      const s = g.st;
      // 名字：不跟兄姊同名，也不用父母的名
      const avoid = [P.name, P.spouse, ...(P.forbid || []), ...older.map((c) => c.name)].filter(Boolean);
      let nm = unfamous(surname + randomGiven(gender), gender);
      for (let k = 0; k < 12 && avoid.some((n) => n === nm || n.slice(1) === nm.slice(1)); k++) nm = unfamous(surname + randomGiven(gender), gender);
      s.name = nm;
      // 往後還會有弟妹（接家時的備援）
      const nYoung = Math.floor(R() * 3);
      for (let i = 0; i < nYoung; i++) {
        const sg = R() < 0.5 ? 'm' : 'f';
        s.siblings.push({ name: unfamous(surname + randomGiven(sg), sg), gender: sg, born: year + 1 + Math.floor(R() * 8), alive: true });
      }
      unclashSiblings(s, older.length, [P.spouse]);
      unclashFriend(s);
      for (const t of talents) { const def = W.talents.find((x) => x.id === t); if (def.eff) apply(def.eff, null); }
      const first = s.lineage[0], LT = T.late;
      const parentRole = P.gender === 'm' ? LT.father : LT.mother;
      // 哪一代是女兒當家，孩子就隨了父姓，祖上卻是別家的姓：這時只說「這一家」
      const sameLine = surname === P.name[0] && (!first || first.name[0] === surname);
      let family = tpl(LT.intro, { house: sameLine ? tpl(LT.houseOf, { surname }) : LT.thisHouse, gen: cn(s.generation), role: parentRole, parent: P.name });
      const n = older.length;
      const cnt = (k) => (k === 2 ? LT.two : cn(k)) + LT.unit;
      const nM = older.filter((x) => x.gender === 'm').length, nF = n - nM;
      family += n ? tpl(LT.older, { list: [nM && cnt(nM) + LT.brother, nF && cnt(nF) + LT.sister].filter(Boolean).join(LT.sep) }) : LT.first;
      // 早逝、壽終這類平常的收場，說不上是「事」
      if (first) family += tpl(arr(LT.sadTitles).includes(first.title) ? LT.sad : arr(LT.happyTitles).includes(first.title) ? LT.happy : LT.other, { name: first.name, title: first.title });
      s.birth = {
        era: era(year), ganzhi: gz(year), region: W.regions.find((r) => r.id === s.region), cls,
        talents: talents.map((t) => W.talents.find((x) => x.id === t)), family, late: true,
        parent: { gen: P.generation, name: P.name, born: P.birthYear },
      };
      emit({ type: 'event', tag: T.tags.birth, text: fmt(W.birthText), scene: 'birth' });
      emit({ type: 'event', text: family });
      g.queue = buildYearQueue();
    }

    if (opts.late && !opts.ancestor) bornLate(); else born();

    return {
      seed,
      get state() { return g.st; },
      get pending() { return g.pending ? { title: g.pending.entry.title, tag: g.pending.ev.tag, text: g.pending.entry.text, note: g.pending.ev.note, who: g.pending.ev.who, opts: g.pending.opts } : null; },
      get ended() { return g.ended; },
      get interlude() { return g.interlude; },
      get succession() { return g.succession ? { ...g.succession.result } : null; },
      continueAsHeir(i) { return g.succession ? becomeHeir(i || 0) : []; },
      // 章末之後繼續同一條人生
      continueChapter() {
        if (!g.interlude) return [];
        g.out = [];
        g.interlude = null;
        S().chapter += 1;
        const c = chapterOf(S().chapter);
        emit({ type: 'chapter', text: c.title, n: c.n });
        beginYear();
        return g.out;
      },
      step, choose,
      eraLabel: (y) => era(y), ganzhi: gz,
      powerOf: (y) => powerOf(g.st.region, y ?? g.st.year), // 介面畫插圖、標勢力用
    };
  }

  // 把 data/ 底下幾個檔案合成引擎要的一份資料
  function mergeData(world, parts, endings, strings, scenes) {
    const out = { world, strings, scenes: scenes || {}, events: [], bonds: {}, endings: endings.endings };
    for (const p of parts) {
      if (p.events) out.events.push(...p.events);
      if (p.bonds) Object.assign(out.bonds, p.bonds);
    }
    return out;
  }

  const api = { createGame, mergeData };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LifeEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
