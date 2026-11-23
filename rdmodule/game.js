// The rdmodule's page. Your leader runs the lane on its own; you spend gold on minis and on
// your leader's own card, and they do the fighting. Each day's course is the same for everyone (seeded by the UTC
// date), and today's PvP modifiers add a twist. Art comes from the Rumble Collection Tracker's game data.
'use strict';
(() => {
  const W = 1280, H = 600, GROUND = 468;
  const DATA = '/static/'; // the tracker's own game data
  const M = 30; // pixels per meter
  const LEADER_X = 110;
  const RANGED_LINE = 420; // where ranged minis hold, between the leader and the melee line
  const MELEE_LINE = 680; // where melee minis hold, the middle of the stage
  const SWING_MAX = 0.9, DEPLOY_MAX = 0.5, DEATH_MAX = 0.6, CAST_MAX = 0.7; // the longest an animation of each kind plays
  const ATTACK_TIME = 0.4; // seconds an attack shows when its sprite has no attack frames
  const STRIKE = 0.4; // how far through an attack the hit lands
  const ADVANCE = 45; // how much faster than the leader minis move up to their line
  const HEARTS = 3; // what a mini or an enemy starts with, like the leader
  const NEAR = 700; // how far ahead "near you" reaches: up to the melee line
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // ---------- helpers ----------
  // The fonts of the Rumble Collection Tracker (fonts/, open fonts): Lilita One for the heaviest text, Nunito for the rest.
  const font = (size, weight = 600) => (weight >= 800 ? `${size}px "Lilita One", system-ui, sans-serif`
    : `${weight} ${size}px Nunito, system-ui, "Segoe UI", sans-serif`);
  document.fonts?.load('16px "Lilita One"');
  document.fonts?.load('600 16px Nunito');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y - a.h < b.y && a.y > b.y - b.h;
  const fmt = (n) => Math.floor(n).toLocaleString('en-US');
  function hashStr(s) {
    let h = 2166136261;
    for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function seeded(a) {
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(`rdmodule.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`rdmodule.${k}`, JSON.stringify(v)); } catch { /* storage off */ } },
  };
  // Images from the tracker's game data, loaded on first use; null until loaded.
  const images = {};
  function img(path, base = DATA) {
    let i = images[path];
    if (!i) { i = new Image(); i.src = base + path; images[path] = i; }
    return i.complete && i.naturalWidth ? i : null;
  }

  // Unit and tower sprites, rendered from the game's models: sprites/<id>.png next to the page, a sheet of frames
  // facing right. sprites/index.json says how to cut each sheet: { cell: [w, h], cols, at: [x, y] (the feet, within a
  // cell), body (the standing figure's height), anims: { move, attack, idle, death, deploy, cast, charge: [first frame,
  // frames, seconds] } }, each there when the unit has such a clip.
  // sprite() is null while loading or when there is none; units then fall back to a portrait token.
  const sprites = {};
  // Effects: frames of the game's own particle effects on black (sprites/fx-<key>.png), cut as sprites/fx.json says:
  // { cell: [w, h], cols, frames, seconds, at: [x, y] (the effect's origin within a cell), unit (pixels per game unit) }.
  // They are screened onto the scene, so the black shows nothing. Without them only the plain rings and lines are drawn.
  let waiting = 3; // lists still being fetched: effects, sprites, sounds (the loading screen waits for them)
  let effects = {};
  // Each unit's own attack effects, as the game's unit catalog ties them to its attack (sprites/unitfx.json): sprite id ->
  // { cast: on the attacker as it swings, impact: on its target as the hit lands }.
  let unitFx = {};
  fetch('sprites/unitfx.json').then((r) => (r.ok ? r.json() : {})).then((j) => { unitFx = j; }).catch(() => {});
  fetch('sprites/fx.json').then((r) => (r.ok ? r.json() : {})).then((j) => { effects = j; }).catch(() => {}).finally(() => { waiting--; });
  // Starts an effect at a point, or on a unit (o.on) that it then follows; o.size scales it, o.vx moves it along the
  // lane (pixels a second). False when there is none.
  function burst(key, x, y, o = {}) {
    if (!effects[key] || !run) return false;
    // one at a time in one place: three whelps hitting together would add up to a white blot
    const u = o.on || null;
    if (run.bursts.some((b) => b.key === key && b.t < 0.2 && (u ? b.on === u : !b.on && Math.abs(b.x - x) < 60))) return true;
    run.bursts.push({ key, x, y, t: 0, on: o.on || null, size: o.size || 1, vx: o.vx || 0 });
    return true;
  }
  const burstOn = (key, u, size) => burst(key, 0, 0, { on: u, size });
  // effects that belong on the ground under a unit, not on its body
  const FX_AT_FEET = new Set(['roots', 'deploy', 'skeleton-spawn', 'scarab-spawn', 'treant-spawn', 'wolf-spawn', 'fire-spawn',
    'dream-portal', 'burrow', 'emerge', 'trapdoor', 'frost-wave', 'poison-wave', 'shockwave', 'tranquility', 'banner', 'warcry',
    'rock', 'petrify', 'blast-wave', 'consecrate', 'totem', 'coins', 'resurrect', 'radiant', 'flamestrike', 'queens-reach']);
  // effects drawn smaller than in Warcraft Rumble, where they cover an area and here mark one unit
  const FX_SIZE = { roots: 0.5, poison: 0.5, 'u-fx-poison-impact-aoe-small-size2': 0.5, 'ice-burst': 0.4, tranquility: 0.6, shadows: 0.5, explosion: 1.3, deploy: 0.55, 'skeleton-spawn': 0.6,
    'scarab-spawn': 0.5, 'treant-spawn': 0.6, 'wolf-spawn': 0.6, 'fire-spawn': 0.6, 'dream-portal': 0.6 };
  // effects drawn faint: a mini arriving should not take the eye off the fight
  const FX_ALPHA = { poison: 0.6, poisoned: 0.5, 'u-fx-poison-impact-aoe-small-size2': 0.6, 'u-fx-poison-impact-directional-01': 0.6,
    deploy: 0.3, 'skeleton-spawn': 0.4, 'scarab-spawn': 0.35, 'treant-spawn': 0.4, 'wolf-spawn': 0.4, 'fire-spawn': 0.45, 'dream-portal': 0.45 };
  const FX_MAX = 560; // no effect is drawn wider than this
  // what a mini's hit leaves on its target where the catalog names none (other melee hits: 'sharp'), and what a
  // summoned mini arrives in
  const HIT_FX = { drake: 'fire-breath', 'emerald-drake': 'poison', 'emerald-whelp': 'poison', priestess: 'smite', 'fire-elemental': 'fire-small',
    'darkspear-troll': 'pierce', murloc: 'pierce', dryad: 'nature', 'gryphon-rider': 'hammer', 'skeleton-mage': 'ice', abomination: 'crit',
    'stonehoof-tauren': 'crit', grunt: 'crit', 'mirror-image': 'crit' };
  const SPAWN_FX = { skeleton: 'skeleton-spawn', 'skeleton-mage': 'skeleton-spawn', scarab: 'scarab-spawn', treant: 'treant-spawn',
    'spirit-wolf': 'wolf-spawn', 'fire-elemental': 'fire-spawn', 'emerald-whelp': 'dream-portal', 'emerald-drake': 'dream-portal' };
  // what a leader's own blow leaves on its target, and what its card shows as it is played: on the leader ('self') or
  // on the ground at the melee line ('front'). A key with the talent's number is for that talent only.
  const LEADER_HIT = { 'bloodmage-thalnos': 'curse', 'general-drakkisath': 'spear', 'grommash-hellscream': 'crit', 'orgrim-doomhammer': 'blunt',
    sneed: 'saw', 'sylvanas-windrunner': 'black-arrow', 'jaina-proudmoore': 'ice' };
  const CARD_FX = {
    'anub-arak': [['burrow', 'self']], 'anub-arak 2': [['trapdoor', 'self']],
    'arthas-menethil': [['frost-wave', 'self']], 'arthas-menethil 1': [['poison-wave', 'self']],
    'baron-rivendare 0': [['blood-pact', 'self']],
    'cairne-bloodhoof': [['shockwave', 'front']],
    cenarius: [['tranquility', 'self']],
    'general-drakkisath 1': [['flamestrike', 'front']], 'general-drakkisath 2': [['banner', 'self']],
    'grommash-hellscream 0': [['warcry', 'self']], 'grommash-hellscream 1': [['mirror', 'self']],
    'jaina-proudmoore 0': [['blink', 'self']],
    'maiev-shadowsong': [['stealth', 'self']], 'maiev-shadowsong 0': [['shadows', 'front']],
    onu: [['rock', 'front']], 'onu 2': [['petrify', 'self']],
    'orgrim-doomhammer 0': [['armor', 'self']],
    ragnaros: [['blast-wave', 'front']], 'ragnaros 1': [['radiant', 'self']],
    'rend-blackhand': [['shadowflame', 'self']],
    'sylvanas-windrunner 0': [['queens-reach', 'front']], 'sylvanas-windrunner 1': [['wail', 'self']],
    'thrall 0': [['totem', 'self']],
    'tirion-fordring 2': [['consecrate', 'front']],
    ysera: [['dream', 'self']],
  };
  let sheets = {};
  fetch('sprites/index.json').then((r) => (r.ok ? r.json() : {})).then((j) => { sheets = j; }).catch(() => {}).finally(() => { waiting--; });
  function sprite(id) {
    let i = sprites[id];
    if (!i) { i = new Image(); i.src = `sprites/${id}.png`; sprites[id] = i; }
    return i.complete && i.naturalWidth ? i : null;
  }
  // how long a unit's animation runs, 0 when it has none
  const clip = (id, anim) => sheets[id]?.anims[anim]?.[2] || 0;
  const ONCE = ['attack', 'death', 'deploy', 'cast']; // played once from start to end; the others loop
  // Sounds from the game's own audio: sounds/<key>-<take>.wav next to the page (on this PC only, like the sprites);
  // sounds/index.json lists how many takes each key has. Without the folder the rdmodule is silent. S turns sound off and on.
  // Each file is fetched once and kept in memory, and played from there: an <audio> on a file of its own keeps a
  // connection to the server open, and a handful of those leave none for the pictures.
  const VOLUME = 0.75; // every sound is turned down by this much
  let takes = {};
  const held = {}; // file -> its address in memory once fetched, '' while on its way
  function hold(file) {
    if (file in held) return held[file];
    held[file] = '';
    fetch(`sounds/${file}.wav`).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b) held[file] = URL.createObjectURL(b); }).catch(() => {});
    return '';
  }
  // fetches every take of these sounds ahead, so the first time each plays it is there
  function ready(keys) { for (const key of keys) for (let k = 1; k <= (takes[key] || 0); k++) hold(`${key}-${k}`); }
  fetch('sounds/index.json').then((r) => (r.ok ? r.json() : {})).then((j) => {
    takes = j;
    ready(['music.menu', ...Object.keys(j).filter((k) => /^(ui|gold|over|death)\b/.test(k))]);
  }).catch(() => {}).finally(() => { waiting--; });
  let muted = store.get('muted', false), voices = 0;
  const lastPlayed = {};
  // Plays one take of a sound; false when there is no such sound, so the caller can fall back on another.
  function sfx(key, vol = 0.4) {
    const n = takes[key];
    if (!n) return false;
    const now = performance.now(), src = hold(`${key}-${1 + Math.floor(Math.random() * n)}`);
    if (muted || !src || voices >= 10 || now - (lastPlayed[key] || 0) < 90) return true;
    lastPlayed[key] = now;
    const a = new Audio(src);
    let live = true;
    const done = () => { if (live) { live = false; voices--; } };
    a.volume = vol * VOLUME;
    a.onended = a.onerror = done;
    voices++;
    a.play().catch(done);
    return true;
  }
  // Music: sounds/music.<name>-1.wav, one piece that loops: the menu's on the menu and in the deck builder, in a run
  // the battle music of the leader's side. The menu's is fetched with the page and the battle pieces behind it, so a
  // change of music is at once: the old one fades out and the new one in over FADE seconds. Browsers only let music
  // start after a key or a click.
  const FADE = 0.25, MUSIC_VOLUME = 0.3;
  const players = {}; // key -> its Audio, made once its file is in memory
  let music = null, tune = null, blocked = false; // the one playing, its key, and whether the browser held it back
  function player(key) {
    const src = hold(`${key}-1`);
    if (!players[key] && src) {
      const a = players[key] = new Audio(src);
      a.loop = true; a.volume = 0;
    }
    return players[key] || null;
  }
  function startMusic() {
    const a = music;
    blocked = false;
    a.play().catch((e) => { if (music === a && e.name === 'NotAllowedError') blocked = true; });
  }
  function playMusic(key) {
    if (!takes[key] || muted) key = null;
    if (tune === key) return;
    const next = key ? player(key) : null;
    if (key && !next) return; // still on its way: the old piece plays on until it is here
    tune = key;
    music = next;
    if (music) { music.currentTime = 0; startMusic(); }
  }
  // every frame: the playing piece toward full volume, the others toward silence and then stopped
  function fadeMusic(dt, quiet) {
    const step = dt / FADE * MUSIC_VOLUME * VOLUME;
    for (const a of Object.values(players)) {
      const on = a === music && !quiet;
      a.volume = clamp(a.volume + (on ? step : -step), 0, MUSIC_VOLUME * VOLUME);
      if (!on && a.volume === 0 && !a.paused) a.pause();
      else if (on && a.paused && !blocked) startMusic();
    }
  }
  for (const what of ['keydown', 'pointerdown']) addEventListener(what, () => { if (music && blocked) startMusic(); });
  const scratch = document.createElement('canvas');
  // Draws a sprite standing at (x, y): h is the figure's height on screen. o: anim (one of the sheet's), t
  // (seconds, for one that loops), p (0..1 through one that plays once), flip (face left), tint (a color laid over it: frozen, rooted,
  // hit), lean (radians, tipping forward around the feet), alpha.
  function drawSprite(id, x, y, h, o = {}) {
    const im = sprite(id);
    if (!im) return false;
    const sheet = sheets[id] || { cell: [im.width, im.height], cols: 1, at: [im.width / 2, im.height], body: im.height, anims: {} };
    const want = o.anim || 'idle', has = !!sheet.anims[want];
    const [first, count, seconds] = sheet.anims[has ? want : 'move'] || [0, 1, 0];
    let frame = first;
    if (has && ONCE.includes(want)) frame += Math.min(count - 1, Math.floor((o.p || 0) * count));
    else if (seconds && (has || want !== 'idle')) frame += Math.floor(((o.t || 0) / seconds) % 1 * count);
    // without frames for it, a unit moves as a toy figure: it rocks while walking and tips forward when it attacks
    const lean = o.lean ?? (has && count > 1 ? 0 : want === 'attack' ? 0.22 : want === 'move' ? Math.sin((o.t || 0) * 9) * 0.07 : 0);
    const [cw, ch] = sheet.cell, k = h / sheet.body;
    let src = im, sx = (frame % sheet.cols) * cw, sy = Math.floor(frame / sheet.cols) * ch;
    if (o.tint) {
      scratch.width = cw; scratch.height = ch;
      const c = scratch.getContext('2d');
      c.drawImage(im, sx, sy, cw, ch, 0, 0, cw, ch);
      c.globalCompositeOperation = 'source-atop';
      c.fillStyle = o.tint;
      c.fillRect(0, 0, cw, ch);
      src = scratch; sx = sy = 0;
    }
    ctx.save();
    ctx.translate(x, y);
    if (o.flip) ctx.scale(-1, 1);
    if (lean) ctx.rotate(lean);
    if (o.alpha != null) ctx.globalAlpha *= o.alpha;
    ctx.drawImage(src, sx, sy, cw, ch, -sheet.at[0] * k, -sheet.at[1] * k, cw * k, ch * k);
    ctx.restore();
    return true;
  }
  const HIT_TINT = 'rgba(255,255,255,0.55)';
  // A unit's size on screen. With sprites it comes from the game's own numbers (sprites/index.json: tall = the model's
  // height at the game's scale, radius = its collider), so units keep the sizes they have next to each other in
  // Warcraft Rumble; size (a figure's height in pixels) stands in without them. tall is the height drawn, w and h the
  // box that fights and gets hit.
  const UNIT_PX = 26, MAX_TALL = 150;
  function dims(art, size) {
    const sh = sheets[art];
    if (!sh?.tall) return { tall: size * 1.45, w: size * 0.8, h: size };
    const tall = Math.min(MAX_TALL, sh.tall * UNIT_PX);
    return { tall, w: Math.max(20, (sh.radius || 1) * 38), h: Math.max(34, tall * 0.7) };
  }

  // ---------- content ----------
  const FAMILY = {
    Alliance: '#3f78e0', Horde: '#c8352b', Undead: '#8f5bd6', Beast: '#c9822e', Blackrock: '#e0612a',
    Cenarion: '#3a9d5d', Neutral: '#8a8a8a',
  };
  // The 15 minis you can put in a deck. kind: melee, ranged, flying, siege or spell. Health and damage are in hearts:
  // a mini has 3 unless it says otherwise (hp), and a hit takes 1 unless it says otherwise (dmg). A flier with a range
  // attacks from a distance.
  const MINIS = {
    footmen: { name: 'Footmen', family: 'Alliance', cost: 5, kind: 'melee', dmg: 1, rate: 0.9, size: 58, armored: true,
      text: 'Armored: each hit takes only half a heart.' },
    ghoul: { name: 'Ghoul', family: 'Undead', cost: 2, kind: 'melee', dmg: 1, rate: 0.7, size: 48, text: 'Cheap, tough brawler.' },
    skeletons: { name: 'Skeletons', family: 'Undead', cost: 2, kind: 'melee', hp: 1, dmg: 1, rate: 0.6, size: 34, count: 3,
      unbound: true, text: 'Three quick skeletons, 1 heart each.' },
    'stonehoof-tauren': { name: 'Stonehoof Tauren', family: 'Horde', cost: 4, kind: 'melee', dmg: 2, rate: 1, size: 56,
      charge: true, text: 'Charges ahead; first hit lands double.' },
    abomination: { name: 'Abomination', family: 'Undead', cost: 6, kind: 'melee', dmg: 2, rate: 1.2, size: 66, cleave: true,
      text: 'Huge tank that cleaves everything near it.' },
    treant: { name: 'Treant', family: 'Cenarion', cost: 3, kind: 'melee', dmg: 1, rate: 1, size: 54, armored: true,
      text: 'Armored: each hit takes only half a heart.' },
    'darkspear-troll': { name: 'Darkspear Troll', family: 'Horde', cost: 3, kind: 'ranged', dmg: 1, rate: 0.8, range: 320,
      size: 46, hitsAir: true, text: 'Throws spears, hits fliers.' },
    dryad: { name: 'Dryad', family: 'Cenarion', cost: 4, kind: 'ranged', dmg: 1, rate: 0.55, range: 300, size: 48,
      hitsAir: true, root: true, text: 'Fast spears that root their target.' },
    priestess: { name: 'Priestess', family: 'Alliance', cost: 2, kind: 'ranged', dmg: 1, rate: 1, range: 260, size: 44,
      hitsAir: true, healer: true, elemental: true, text: 'Heals the most hurt mini near her.' },
    'gryphon-rider': { name: 'Gryphon Rider', family: 'Alliance', cost: 2, kind: 'flying', dmg: 1, rate: 0.8, size: 46, range: 240,
      text: 'Cheap flier that throws hammers at air and ground.' },
    harpies: { name: 'Harpies', family: 'Beast', cost: 3, kind: 'flying', hp: 1, dmg: 1, rate: 0.5, size: 32, count: 3,
      text: 'Three fast fliers, 1 heart each.' },
    drake: { name: 'Drake', family: 'Blackrock', cost: 4, kind: 'flying', dmg: 2, rate: 1, size: 58, range: 170, cleave: true,
      elemental: true, text: 'Breathes fire on everything near its target.' },
    'goblin-sapper': { name: 'Goblin Sapper', family: 'Horde', cost: 2, kind: 'siege', dmg: 3, size: 42,
      text: 'Runs at the next ground enemy or tower and blows up for 3 hearts.' },
    // three tiers: it stays in the hand after the first two casts, 1 heart and 1 Gold more each time
    'arcane-blast': { name: 'Arcane Blast', family: 'Alliance', cost: 1, kind: 'spell', dmg: 1, elemental: true,
      text: 'Blasts the nearest enemy for 1 heart, then 2, then 3: it stays in your hand, 1 Gold dearer each time.' },
    'chain-lightning': { name: 'Chain Lightning', family: 'Horde', cost: 2, kind: 'spell', dmg: 2, elemental: true,
      text: 'Zaps the 4 nearest enemies.' },
  };
  // What a ranged attack sends flying: the game's own projectile (sprites/shot-*.png, pointing right) drawn this long,
  // turning end over end when it spins; or a glowing ball of a color, where the game's projectile is an effect and
  // not a model, and for any shot while the sprites are missing.
  const SHOTS = {
    'darkspear-troll': { art: 'shot-darkspear-troll', len: 40, color: '#d8c9a4' },
    dryad: { art: 'shot-dryad', len: 46, color: '#9be38f' },
    'gryphon-rider': { art: 'shot-gryphon-rider', len: 22, spin: true, color: '#cfd6e6' },
    priestess: { color: '#fff3a0' },
    drake: { color: '#ff8a2b', size: 9 },
    murloc: { color: '#bfe6ff', size: 4 },
    'emerald-whelp': { color: '#7fe08a', size: 5 },
    'emerald-drake': { color: '#7fe08a', size: 9 },
    'skeleton-mage': { color: '#9fd8ff', size: 5 },
  };
  const SHOT_SPEED = 760;
  const JUMP = 0.09; // seconds lightning takes from one target to the next
  const POOL = Object.keys(MINIS);
  const DEFAULT_DECK = ['footmen', 'darkspear-troll', 'gryphon-rider', 'ghoul', 'goblin-sapper', 'arcane-blast'];
  // Minis that leaders and modifiers bring in, not in decks. face: the pictures that stand for it where it has no portrait, the first that
  // is there: a file next to the page (with a folder) or a portrait in the tracker's game data.
  const SUMMONS = {
    scarab: { name: 'Scarab', family: 'Undead', kind: 'melee', hp: 1, dmg: 1, rate: 0.6, size: 26, art: null },
    skeleton: { name: 'Skeleton', family: 'Undead', kind: 'melee', hp: 1, dmg: 1, rate: 0.6, size: 34, art: 'skeletons', unbound: true },
    murloc: { name: 'Murloc', family: 'Beast', kind: 'ranged', hp: 1, dmg: 1, rate: 0.7, range: 220, size: 34, hitsAir: true,
      art: 'murloc-tidehunters' },
    treant: { ...MINIS.treant, art: 'treant' },
    'emerald-whelp': { name: 'Emerald Whelp', family: 'Cenarion', face: ['sprites/cards/emerald-whelp', 'whelp-eggs'], kind: 'flying', hp: 1, dmg: 1, rate: 0.5, size: 34, range: 200, elemental: true,
      poison: true },
    'emerald-drake': { name: 'Emerald Drake', family: 'Cenarion', face: ['sprites/cards/emerald-drake', 'drake'], kind: 'flying', dmg: 2, rate: 1, size: 62, range: 170, elemental: true,
      cleave: true, poison: true },
    'spirit-wolf': { name: 'Feral Spirit', family: 'Horde', kind: 'melee', hp: 2, dmg: 1, rate: 0.6, size: 44, elemental: true },
    'fire-elemental': { name: 'Fire Elemental', family: 'Blackrock', kind: 'melee', dmg: 1, rate: 0.8, size: 56, elemental: true, poison: true,
      life: 12 }, // life: seconds until it is gone
    'skeleton-mage': { name: 'Skeletal Mage', family: 'Undead', face: ['skeleton-party'], kind: 'ranged', hp: 1, dmg: 1, rate: 0.9, range: 240, size: 36, hitsAir: true,
      chill: true, unbound: true },
    'mirror-image': { name: 'Mirror Image', family: 'Horde', kind: 'melee', hp: 1, dmg: 2, rate: 0.9, size: 60, art: 'grommash-hellscream' },
    drake: MINIS.drake,
    kobold: { name: 'Kobold Miner', family: 'Neutral', kind: 'melee', hp: 1, dmg: 1, rate: 0.8, size: 38, art: 'kobold-miner' },
    grunt: { name: 'Warsong Grunt', family: 'Horde', kind: 'melee', dmg: 2, rate: 0.9, size: 54, art: 'warsong-grunts' },
  };
  // Enemies have 3 hearts too, a giant and a tower 5. hit: hearts a blow takes from a mini; dmg: hearts it costs the leader.
  const ENEMIES = {
    quilboar: { walk: 40, size: 46, dmg: 1, hit: 1, rate: 0.8 },
    raptors: { walk: 95, size: 38, dmg: 1, hit: 1, rate: 0.6 },
    vultures: { walk: 85, size: 40, dmg: 1, hit: 1, rate: 0.8, air: true, alt: 56 },
    'witch-doctor': { walk: 0, size: 46, dmg: 1, fire: 1.8 }, // fire: stands off and shoots, a bolt this often
    'molten-giant': { hp: 5, walk: 18, size: 160, dmg: 2, hit: 2, rate: 1.4 },
    tower: { hp: 5, walk: 0, w: 84, h: 160, dmg: 1, tower: true },
  };
  // Every leader: the in-game Leader Ability as a passive, put into the rdmodule's terms.
  const LEADERS = [
    ['anub-arak', "Anub'arak", 'Undead', 'melee', 'Carrion Feast',
      'Your Undead and Beast minis bring a Scarab when they arrive and when they fall (12 at most).'],
    ['arthas-menethil', 'Arthas Menethil', 'Alliance', 'melee', 'Soulshatter',
      'Frozen enemies that are already hurt die from any hit.'],
    ['baron-rivendare', 'Baron Rivendare', 'Undead', 'melee', 'Army of the Dead',
      'Every 15 s, 2 Skeletons join you.'],
    ['bloodmage-thalnos', 'Bloodmage Thalnos', 'Undead', 'ranged', 'Dark Ritual',
      "Each spell you play makes Thalnos's card hit half a heart harder."],
    ['cairne-bloodhoof', 'Cairne Bloodhoof', 'Horde', 'melee', 'Earthen Might',
      'Your Horde minis have 1 more heart.'],
    ['cenarius', 'Cenarius', 'Cenarion', 'ranged', 'Grovekeeper',
      'Your Cenarion minis have 1 more heart.'],
    ['charlga-razorflank', 'Charlga Razorflank', 'Beast', 'ranged', 'Spirit Tangle',
      'Costs come from a hidden second deck: every card in your hand costs what is on top of it, and playing a card sends that cost to the bottom.'],
    ['emperor-thaurissan', 'Emperor Thaurissan', 'Blackrock', 'ranged', 'Fiery Weapon Enchant',
      'Your minis that are not Elemental set their targets on fire.'],
    ['general-drakkisath', 'General Drakkisath', 'Blackrock', 'melee', 'Banner of Flame',
      'Enemies take 50% more Elemental damage.'],
    ['grommash-hellscream', 'Grommash Hellscream', 'Horde', 'melee', 'For The Horde!',
      'Your minis attack 30% faster.'],
    ['hogger', 'Hogger', 'Beast', 'melee', 'Relentless',
      "Hogger's card hits 1 heart harder each time you play it, up to 5."],
    ['jaina-proudmoore', 'Jaina Proudmoore', 'Alliance', 'ranged', 'Arcane Brilliance',
      'Your spells deal 50% more damage.'],
    ['maiev-shadowsong', 'Maiev Shadowsong', 'Alliance', 'melee', 'Master Assassin',
      "Each card you play whose own cost is 2 Gold or less makes Maiev's card 1 cheaper, until you play it."],
    ['malfurion', 'Malfurion Stormrage', 'Alliance', 'ranged', 'Regeneration',
      'Your hurt Alliance and Cenarion minis heal over time.'],
    ['old-murk-eye', 'Old Murk-Eye', 'Beast', 'ranged', 'March of the Murlocs',
      "Murk-Eye's card starts the March: while it lasts, every Gold spent on other cards brings a Murloc."],
    ['onu', 'Onu, Ancient of Lore', 'Cenarion', 'melee', 'Safe Arbor',
      'Your minis arrive at their line instead of beside you.'],
    ['orgrim-doomhammer', 'Orgrim Doomhammer', 'Horde', 'melee', 'First Blood',
      'Your Horde and Blackrock minis deal double on their first hit.'],
    ['ragnaros', 'Ragnaros', 'Blackrock', 'melee', 'Molten Armor',
      'Your Armored minis burn those that hit them; an enemy that reaches you scorches all near it.'],
    ['rend-blackhand', 'Rend Blackhand', 'Blackrock', 'flying', 'Blacken the Skies',
      'Your Flying minis cost 1 less (not below 2).'],
    ['sneed', 'Sneed', 'Horde', 'melee', 'Sneed Before Greed',
      'Gain 2 more Gold whenever a tower falls.'],
    ['sylvanas-windrunner', 'Sylvanas Windrunner', 'Undead', 'ranged', 'Windrunner Warchief',
      'Your Horde and Undead minis reach their line twice as fast.'],
    ['thrall', 'Thrall', 'Horde', 'ranged', "Warchief's Presence",
      'Your Horde and Elemental minis hit 50% harder and take half damage from shots.'],
    ['tirion-fordring', 'Tirion Fordring', 'Alliance', 'melee', 'Holy Light',
      'Every 8 s, your minis regain 1 heart.'],
    ['ysera', 'Ysera the Dreamer', 'Cenarion', 'flying', 'Stuck in the Emerald Dream',
      "Ysera's card is a different dream each time: Emerald Whelps, Innervate, Emerald Drake, Hibernate."],
    // hidden until "youtakenocandle" is typed on the menu; its talents are the rdmodule's own, the mini has none
    ['kobold-miner', 'Kobold Miner', 'Neutral', 'melee', 'Miner',
      'Every 8 s, the Miner digs up 1 Gold.', true],
  ].map(([id, name, family, role, passive, passiveText, hidden]) => ({ id, name, family, role, passive, passiveText, hidden }));
  // Each leader's three talents, as in Warcraft Rumble (names and icons from the game's data). The leader's card is its
  // own move (Arthas's Remorseless Winter, Orgrim's Mak'gora), and the talent you pick changes it the way that talent
  // changes the leader in Warcraft Rumble; some talents also work all run long, as theirs do while the leader is in
  // play. [name, icon (talents/<icon>.webp in the tracker's game data, or a path there), the card's Gold cost, what it does].
  const TALENTS = {
    'anub-arak': [
      ['Regenerate', 'talent_regenerate', 4,
        'Burrow for 2 s, out of reach, and restore 1 heart as you come up.'],
      ['Explosive Shells', 'talent_explosiveshells', 3,
        'Burrow for 2 s and summon 2 Scarabs. All your Scarabs burst for 1 heart when they fall.'],
      ['Trap Door', 'talent_trapdoor', 5,
        'Burrow for 2 s, summon 6 Scarabs and stun the enemies in front of you for 2 s.'],
    ],
    'arthas-menethil': [
      ['Death Grip', 'talent_icytalons', 4,
        'Remorseless Winter: freeze every enemy for 2.5 s. Fliers are pulled to the ground and ranged enemies to your melee line.'],
      ['Necrotic Plague', 'talent_necroticplague', 4,
        'Remorseless Winter: freeze every enemy for 2.5 s. They are poisoned too, and Soulshatter also works on poisoned enemies.'],
      ['Purgatory', 'talent_purgatory', 4,
        'Remorseless Winter: freeze every enemy for 2.5 s. Once, your last hit leaves you unhurt for 3 s: fell an enemy in that time to live on.'],
    ],
    'baron-rivendare': [
      ['Death Pact', 'talent_deathpact', 2,
        'Give up a Skeleton to restore 1 heart. At full hearts or without one, summon 2 Skeletons.'],
      ['Skeletal Frenzy', 'talent_skeletalfrenzy', 3,
        'Summon 3 Skeletons at the front. All your Skeletons attack twice as fast.'],
      ['Chill Of The Grave', 'talent_chillofthegrave', 3,
        'Summon 3 Skeletal Mages, whose bolts chill. Army of the Dead brings them too.'],
    ],
    'bloodmage-thalnos': [
      ['Bane', 'talent_darkritual', 3,
        'Shadow bolt: 2 hearts to the nearest enemy, and 1 heart back to you if it falls. Playing a spell makes your minis attack 50% faster for 5 s.'],
      ['Drain Soul', 'talent_drainlife', 3,
        'Shadow bolt: 2 hearts to the nearest enemy, and 1 heart back to you if it falls. Then your next card also costs 1 less.'],
      ['Dominance', 'talent_dominance', 3,
        'Shadow bolt: 2 hearts to the nearest enemy, and 1 heart back to you if it falls. Spells that cost 2 or more count twice for Dark Ritual.'],
    ],
    'cairne-bloodhoof': [
      ['Reincarnation', 'talent_spell_nature_reincarnation', 4,
        'War Stomp: hit and stun the ground enemies in front of you for 2 s. Once, the hit that would end your run leaves you on 1 heart.'],
      ['Plainsrunning', 'talent_plainsrunning', 4,
        'War Stomp: hit and stun the ground enemies in front of you for 2 s. You run 20% faster.'],
      ['Aftershock', 'talent_aftershock', 4,
        'War Stomp: hit and stun the ground enemies in front of you for 2 s. When the stun ends they stay dazed for 5 s: slow to move and to strike.'],
    ],
    cenarius: [
      ['Revitalize', 'talent_revitalize', 4,
        'Tranquility: your minis regain hearts for 8 s.'],
      ['Force of Nature', 'talent_forceofnature', 4,
        'Tranquility: your minis regain hearts for 4 s; ground enemies are rooted for 3 s. A Treant joins you whenever a rooted enemy falls.'],
      ['Wild Growth', 'talent_wildgrowth', 4,
        'Tranquility: your minis regain hearts for 4 s, and every enemy is rooted for 5 s.'],
    ],
    'charlga-razorflank': [
      ["Nature's Grasp", 'talent_naturesgrasp', 2,
        'Root and hit the 3 nearest ground enemies for 3 s.'],
      ['Cavernous Mists', 'talent_burrowingtunnels', 1,
        'Root and hit the nearest ground enemy for 3 s. Costs 1 Gold less.'],
      ['Spirit Passage', 'talent_toxicbloom', 2,
        "Root and hit the nearest ground enemy for 3 s. Minis you pay 5 Gold or more for arrive with 1 more heart and can't be hurt for 3 s."],
    ],
    'emperor-thaurissan': [
      ['Incinerate', 'talent_incinerate', 4,
        'Lava Spike: 2 hearts to the nearest enemy and those beside it, and they burn until they fall.'],
      ['Hubris', 'talent_hubris', 4,
        'Lava Spike: 2 hearts to the nearest enemy and those beside it, set on fire. Your next mini that is not Elemental arrives with 2 more hearts.'],
      ["Moira's Wit", 'talent_moiras_wit', 4,
        'Lava Spike: 2 hearts to the nearest enemy and those beside it, set on fire. Every 6th burning enemy that falls restores 1 heart.'],
    ],
    'general-drakkisath': [
      ['Chromatic Scales', 'talent_chromaticscales', 3,
        'A flaming thrust: 2 hearts to the nearest enemy. Your minis take half damage from shots.'],
      ['Piercing Blows', 'talent_piercingblows', 4,
        'A flaming thrust through every enemy in the lane: 2 hearts each.'],
      ['Lasting Legacy', 'talent_lastinglegacy', 4,
        'A flaming thrust: 2 hearts to the nearest enemy. A banner makes Elemental damage hit half as hard again for 10 s.'],
    ],
    'grommash-hellscream': [
      ['Bladestorm', 'talent_sweepingstrikes', 4,
        'Hit every ground enemy in front of you for 2 hearts.'],
      ['Mirror Image', 'talent_bloodrage', 4,
        'Hit the nearest enemy for 2 hearts. Two mirror images join you: they hit hard and fall to one blow.'],
      ['Savage Strikes', 'talent_orcishfury', 3,
        'Hit the nearest enemy for 2 hearts, or 4 if it is already hurt.'],
    ],
    hogger: [
      ['Ham Hock', 'talent_hamhock', 3,
        'Mace cleave on the nearest enemy and those beside it. Restores half a heart.'],
      ['Spoiled Meat', 'talent_spoiledmeat', 3,
        'Mace cleave on the nearest enemy and those beside it. It poisons them.'],
      ['Fatal Frenzy', 'talent_fatalfrenzy', 3,
        'Mace cleave on the nearest enemy and those beside it. Your Beast minis gain 1 heart and attack 50% faster for 8 s.'],
    ],
    'jaina-proudmoore': [
      ['Blink', 'talent_blink', 3,
        'Frostbolt: 2 hearts to the nearest enemy, frozen for 2 s. You blink out of reach for 2 s.'],
      ['Clearcasting', 'talent_clearcasting', 3,
        'Frostbolt: 2 hearts to the nearest enemy, frozen for 2 s. A spell played right after it costs 1 Gold less (not below 1).'],
      ['Flurry', 'talent_flurry', 3,
        'Frostbolt that bursts: 2 hearts to the nearest enemy and those near it, frozen for 2 s.'],
    ],
    'maiev-shadowsong': [
      ['Enveloping Shadows', 'talent_envelopingshadows', 5,
        'Vanish for 2 s and strike the farthest enemy for 3 hearts. Your minis vanish too: nothing can hurt them for 3 s.'],
      ['Shadowstep', 'talent_shadowstep', 5,
        'Vanish for 2 s and strike the farthest enemy, every flier and every ranged enemy for 3 hearts.'],
      ['Remorseless', 'talent_remorseless', 5,
        'Vanish for 2 s and strike the farthest enemy for 3 hearts. If it falls, strike the next farthest, up to 3 strikes.'],
    ],
    malfurion: [
      ['Natural Salve', 'malfurionleader_talentnaturalsalve_icon', 3,
        'Seeds of Protection: each of your minis ignores the next hit. A seed that breaks also heals its mini fully.'],
      ['Deep Slumber', 'malfurionleader_talentdeepslumber_icon', 4,
        'Seeds of Protection: each of your minis ignores the next hit. Every enemy on screen sleeps for 4 s, or until hit.'],
      ['Germinate', 'malfurionleader_talentgerminate_icon', 4,
        'Seeds of Protection: each of your minis ignores the next hit. 10 s later every mini gets a fresh seed.'],
    ],
    'old-murk-eye': [
      ['Tip of the Spear', 'talent_tipofthespear', 3,
        'March of the Murlocs for 6 s. The Murlocs arrive at the front.'],
      ['Marathon Of The Murlocs', 'talent_marathonofmurlocs', 3,
        'March of the Murlocs for 11 s.'],
      ['Electric Eels', 'talent_electriceel', 4,
        'March of the Murlocs for 6 s. Lightning stuns the 3 nearest enemies for 1.5 s.'],
    ],
    onu: [
      ['From the Trees!', 'talent_fromthetrees', 3,
        'Slam: hit and stun the ground enemies in front of you for 1.5 s. Your minis deal double damage on their first hit.'],
      ['Barkskin', 'talent_barkskin', 3,
        'Slam: hit and stun the ground enemies in front of you for 1.5 s. Your minis arrive Armored for 8 s.'],
      ['Petrify', 'talent_petrify', 6,
        'Slam: hit and stun the ground enemies in front of you for 1.5 s. 3 Treants join you at the front.'],
    ],
    'orgrim-doomhammer': [
      ['Deathless Rage', 'doomhammerleader_talentdeathlessrage_icon', 3,
        "Mak'gora: smash the nearest enemy or tower for 4 hearts. You are out of reach and your minis attack 50% faster for 3.5 s."],
      ['Rally the Clan', 'doomhammerleader_talentrallytheclan_icon', 3,
        "Mak'gora: smash the nearest enemy or tower for 4 hearts. If it falls, your minis attack 50% faster for 10 s."],
      ["Conqueror's Diplomacy", 'doomhammerleader_talentconquerorsdiplomacy_icon', 3,
        "Mak'gora: smash the nearest enemy or tower for 4 hearts. An enemy that falls to it fights for you for 15 s."],
    ],
    ragnaros: [
      ['Concussive Blast', 'talent_blastwave', 5,
        'Blast Wave: 2 hearts to every enemy in front of you, and their shots are wiped out. They are stunned for 2 s.'],
      ['Radiant Flames', 'talent_radianflames', 5,
        'Blast Wave: 2 hearts to every enemy in front of you, and their shots are wiped out. Every 4 s, fire strikes the enemy nearest you for 1 heart.'],
      ['Sons of Flame', 'talent_sonsofflame', 6,
        'Blast Wave: 2 hearts to every enemy in front of you, and their shots are wiped out. Two Fire Elementals join you for 12 s.'],
    ],
    'rend-blackhand': [
      ['Flaming Soul', 'talent_flamingsoul', 5,
        'Dragon fire: 2 hearts to everything ahead, fliers too. A Living Bomb on the nearest enemy bursts 2 s later.'],
      ['Scale and Steel', 'talent_scaleandsteel', 5,
        'Dragon fire: 2 hearts to everything ahead, fliers too. The next hit on you is turned aside.'],
      ['Legionnaire', 'talent_legionnaire', 6,
        'Weaker dragon fire: 1 heart to everything ahead. A Drake joins you.'],
    ],
    sneed: [
      ['Mine Is Money, Friend!', 'talent_mineismoneyfriend', 3,
        "Sneed's saw: 3 hearts to a tower, or 2 to the nearest enemy. Gain 4 Gold over the next 10 s."],
      ['Lead with Greed', 'talent_selfdestruct', 2,
        "Sneed's saw: 3 hearts to a tower, or 2 to the nearest enemy. A falling tower gives 2 more Gold again."],
      ['Land Grab', 'talent_sneedlandgrab', 2,
        "Sneed's saw: 3 hearts to a tower, or 2 to the nearest enemy. It hits 1 heart harder for every tower that has fallen."],
    ],
    'sylvanas-windrunner': [
      ["Queen's Reach", 'talent_queensreach', 5,
        'Black Arrow flies on through every enemy in the lane: 3 hearts each.'],
      ["Banshee's Wail", 'talent_basheeswail', 5,
        'Black Arrow: 3 hearts to the nearest enemy. A scream stuns every enemy on screen for 3 s.'],
      ['Forsaken Fury', 'talent_forsakenfury', 3,
        'Black Arrow: 3 hearts to the nearest enemy. Your Horde and Undead minis attack 30% faster.'],
    ],
    thrall: [
      ['Totemic Mastery', 'totemicmasterytalent', 4,
        'Lightning hits the 3 nearest enemies. A totem heals your minis for 8 s.'],
      ['Feral Spirit', 'feralspirittalent', 4,
        'Lightning hits the 3 nearest enemies. Two Feral Spirits join you: quick wolves with 2 hearts.'],
      ['Call of the Horde', 'callofthehordetalent', 3,
        'Lightning hits the 3 nearest enemies. Each Horde mini you play strikes the nearest enemy and speeds your minis up for 3 s.'],
    ],
    'tirion-fordring': [
      ['By The Light', 'talent_layonhands', 3,
        'Fully heal your minis. Holy Light comes every 4 s instead of 8.'],
      ['Divine Shield', 'talent_divineshield', 3,
        'Fully heal your minis. When you fall to your last heart, a shield keeps you unhurt for 5 s.'],
      ['Consecrate', 'talent_consecrate', 3,
        'Fully heal your minis. Every 4 s, holy ground hits the ground enemies at your front for half a heart.'],
    ],
    'kobold-miner': [
      ['Gold Vein', 'icons/Miner', 1,
        'Pick: 2 hearts to the nearest enemy or tower, and 1 Gold if it falls. Then 2 more Gold over the next 5 s.'],
      ['You No Take Candle!', 'icons/Miner', 2,
        'Pick: 2 hearts to the nearest enemy or tower, and 1 Gold if it falls. The candle turns the next hit on you aside.'],
      ['Dig Crew', 'icons/Miner', 3,
        'Pick: 2 hearts to the nearest enemy or tower, and 1 Gold if it falls. Two Kobold Miners join you.'],
    ],
    ysera: [
      ['Recurring Dream', 'talent_recurringdream', 3,
        'A second Dream card joins your deck and turns through the dreams the other way.'],
      ['Corrupted Dream', 'talent_corrupteddream', 3,
        'Emerald Whelps and the Emerald Drake poison for twice as long.'],
      ['Shared Dream', 'talent_shareddream', 3,
        'Hibernate reaches every enemy on screen, not just the 3 nearest.'],
    ],
  };
  const LEADER_CARD = 'leader';
  // Ysera's second Dream card, with the Recurring Dream talent: it goes through the dreams the other way round.
  const SECOND_DREAM = 'leader2';
  const isLeaderCard = (id) => id === LEADER_CARD || id === SECOND_DREAM;
  // Ysera's card is a different one each time she plays it, in this order.
  const DREAMS = ['Emerald Whelps', 'Innervate', 'Emerald Drake', 'Hibernate'];

  // What each PvP modifier does here; anything not listed has no effect here.
  const TWISTS = {
    PvpModifier_Tower_Dragon: { tower: 'dragon', text: 'Towers breathe fire along the ground.' },
    PvpModifier_Tower_Rocket: { tower: 'rocket', text: 'Towers lob rockets that hit everything where they land.' },
    PvpModifier_Tower_Guard: { tower: 'guard', text: 'Towers fire fast bolts.' },
    PvpModifier_GoldRush: { text: 'Gold comes twice as fast.' },
    PvpModifier_BountyHunt: { text: '1 extra Gold for every 5 kills.' },
    PvpModifier_AdrenalineRush: { text: 'Gold comes faster as you lose hearts.' },
    PvpModifier_FirstStrike: { text: 'Minis deal double damage on their first hit.' },
    PvpModifier_Fortifications: { text: 'Towers have twice the health.' },
    PvpModifier_HeavyMortar: { text: 'Towers have three times the health.' },
    PvpModifier_CleanFight: { text: 'No spells: they stay out of your hand.' },
    PvpModifier_HerosResolve: { text: 'Your leader card costs 1 Gold less each time you play it.' },
    PvpModifier_CollateralDamage: { text: 'A falling tower hurts enemies near it.' },
    PvpModifier_Stonebind: { text: 'A falling tower leaves a stone that heals 1 heart.' },
    PvpModifier_Vanilla: { text: 'No twist. A plain run.' },
  };

  // ---------- today ----------
  const dayKey = () => new Date().toISOString().slice(0, 10);
  const today = { state: 'loading', mods: [] }; // state: loading, ready, failed
  const has = (id) => today.mods.some((m) => m.id === id);
  const towerKind = () => today.mods.map((m) => TWISTS[m.id]?.tower).find(Boolean) || 'plain';

  async function loadToday() {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 6000);
    try {
      const res = await fetch(`${DATA}pvp.json`, { cache: 'no-cache', signal: stop.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const pvp = await res.json();
      const now = Date.now();
      const season = (pvp.seasons || []).find((s) => Date.parse(s.start) <= now && now < Date.parse(s.end));
      const rot = season?.rotation;
      if (!rot?.sets?.length) throw new Error('no rotation');
      const period = rot.periodDays * 86400000, t0 = Date.parse(rot.start);
      const k = Math.floor((now - t0) / period), n = rot.sets.length;
      today.mods = rot.sets[((k % n) + n) % n].map((id) => ({ id,
        name: pvp.modifiers?.[id]?.name || id.replace(/^PvpModifier_/, ''),
        icon: pvp.modifiers?.[id]?.icon ? `pvp/${pvp.modifiers[id].icon}.webp` : null,
        text: TWISTS[id]?.text || 'No effect here.' }));
      today.state = 'ready';
    } catch {
      today.mods = [];
      today.state = 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- saved choices and scores ----------
  // The Kobold Miner joins the leaders once "youtakenocandle" has been typed on the menu; that is remembered.
  const SECRET = 'youtakenocandle';
  let found = store.get('kobold', false), typed = '';
  const leaderCount = () => LEADERS.length - (found ? 0 : 1);
  let pick = clamp(LEADERS.findIndex((l) => l.id === store.get('leader', '')), 0, leaderCount() - 1);
  let deck = store.get('deck', DEFAULT_DECK).filter((id) => MINIS[id]);
  const talents = store.get('talents', {}); // leader id -> which of its three talents is picked
  const talentOf = (l) => clamp(talents[l.id] | 0, 0, 2);
  if (deck.length !== 6) deck = [...DEFAULT_DECK];
  let draft = []; // the deck being edited
  const best = store.get('best', {});
  let daily = store.get('daily', { day: '', best: {} });
  function bestToday(id) {
    if (daily.day !== dayKey()) daily = { day: dayKey(), best: {} };
    return daily.best[id] || 0;
  }
  function saveScore(id, score) {
    const out = { ever: score > (best[id] || 0), today: score > bestToday(id) };
    if (out.ever) { best[id] = score; store.set('best', best); }
    if (out.today) { daily.best[id] = score; store.set('daily', daily); }
    return out;
  }

  // ---------- run state ----------
  let mode = 'load'; // load, menu, deck, play, pause, over
  let reveal = 0; // seconds left of the menu fading in after the loading screen
  let run = null;
  let clock = 0; // seconds, for animation
  let shake = 0;
  let note = null; // short message on the menu screens

  const leader = () => run.leader;
  const isLeader = (id) => run.leader.id === id;
  const tal = (id, i) => run.leader.id === id && run.talent === i; // this leader with its talent number i picked

  function newRun() {
    const l = LEADERS[pick];
    const seed = hashStr(`${dayKey()}|rdmodule`);
    const deckRng = seeded(seed ^ 0x9e3779b9);
    let ids = deck.filter((id) => !(MINIS[id].kind === 'spell' && has('PvpModifier_CleanFight')));
    if (ids.length < 3) ids = ids.concat(['ghoul', 'gryphon-rider', 'darkspear-troll'].slice(0, 3 - ids.length));
    const talent = talentOf(l);
    ids.push(LEADER_CARD);
    if (l.id === 'ysera' && talent === 0) ids.push(SECOND_DREAM); // Recurring Dream
    const shuffle = (list) => { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(deckRng() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } return list; };
    shuffle(ids);
    // Charlga's Spirit Tangle: her cards' Gold costs, as a deck of their own in another order. Every card in hand costs
    // the one on top; playing a card sends it to the bottom.
    const costs = l.id === 'charlga-razorflank' ? shuffle(ids.map((id) => (MINIS[id] ? MINIS[id].cost : TALENTS[l.id][talent][2]))) : null;
    run = {
      leader: l, talent, costs, rng: seeded(seed),
      // what leaders and talents keep track of. Seconds left: minis attack faster, Beasts attack faster, minis can't
      // be hurt, minis regain hearts, Elemental damage hits harder, the March of the Murlocs, Arthas's Purgatory.
      haste: 0, frenzy: 0, veil: 0, totem: 0, banner: 0, march: 0, purgatory: 0,
      // then: things to do after a delay ({ t, fn }), the second repeating timer, times Hogger's card was played, cheap
      // cards played for Maiev, seconds since the Kobold Miner last dug, Arcane Blast's tier (0 to 2), burning enemies fallen for Moira's Wit, and one-off flags
      later: [], timer2: 0, mine: 0, arcane: 0, plays: 0, cheap: 0, wit: 0, hubris: false, clear: false, guard: false, reborn: false, purged: false,
      p: { x: LEADER_X, y: GROUND, w: 46, h: 64, hp: 3, inv: 0, lunge: 0, deploy: Math.min(DEPLOY_MAX, clip(l.id, 'deploy')) },
      hand: ids.slice(0, 3), queue: ids.slice(3),
      gold: 4, goldT: 0, spd: 0, traveled: 0, bg: 0,
      nextSpawn: 700, nextTower: 400 * M,
      enemies: [], minis: [], shots: [], bolts: [], fx: [], bursts: [], texts: [], stones: [], corpses: [],
      kills: 0, bounty: 0, score: 0, resolve: 0, dream: 0, dream2: 0, owed: 0, owedT: 0, unhurt: 0, unhurtKind: null, stalled: false, time: 0,
      discount: 0, ritual: 0, towersDown: 0, timer: 0, saved: null,
    };
  }

  // ---------- spawning ----------
  function addEnemy(type, x) {
    const d = ENEMIES[type];
    let hp = d.hp || HEARTS;
    if (d.tower) hp *= has('PvpModifier_HeavyMortar') ? 3 : has('PvpModifier_Fortifications') ? 2 : 1;
    const { tall, w, h } = d.tower ? { tall: d.h, w: d.w, h: d.h } : dims(type, d.size);
    const e = { type, x, y: d.air ? GROUND - d.alt : GROUND, w, h, tall, hp, max: hp, air: !!d.air, t: Math.random() * 3, atk: 0,
      fire: 1 + Math.random(), windup: 0, kind: d.tower ? towerKind() : null, hold: 0, holdKind: null, daze: 0, burn: 0, burnT: 0,
      lunge: 0, flash: 0 };
    run.enemies.push(e);
    return e;
  }

  function spawnWave() {
    const r = run, m = r.traveled / M, rng = r.rng;
    const pool = [['quilboar', 3]];
    if (m > 60) pool.push(['vultures', 2]);
    if (m > 120) pool.push(['raptors', 1.6]);
    if (m > 160) pool.push(['witch-doctor', 2]);
    if (m > 300) pool.push(['molten-giant', 1.2]);
    if (m > 500) pool.push(['pair', 1.2]);
    let total = 0;
    for (const [, w] of pool) total += w;
    // the further the run, the more come at once
    const n = 1 + Math.floor((m / 1200) * (0.5 + rng()));
    for (let i = 0, x = W + 40; i < n; i++, x += 90) {
      let roll = rng() * total, type = 'quilboar';
      for (const [t, w] of pool) { if ((roll -= w) < 0) { type = t; break; } }
      if (type === 'pair') { addEnemy('quilboar', x); type = 'vultures'; x += 140; }
      addEnemy(type, x);
      if (type === 'vultures') addEnemy(type, x += 70); // they fly in pairs
    }
    const d = clamp(m / 1500, 0, 1);
    r.nextSpawn = r.traveled + lerp(700, 400, d) + rng() * 300;
  }

  // paid: the Gold spent on it when it comes from a card in your hand
  function addMini(id, def, x, paid) {
    const r = run;
    const count = def.count || 1;
    let hp = def.hp || HEARTS;
    if (isLeader('cairne-bloodhoof') && def.family === 'Horde') hp++;
    if (isLeader('cenarius') && def.family === 'Cenarion') hp++;
    const passage = tal('charlga-razorflank', 2) && paid >= 5; // Spirit Passage
    if (passage) hp++;
    const line = lineOf(def);
    const { tall, w, h } = dims(def.art || id, def.size);
    const deploy = Math.min(DEPLOY_MAX, clip(def.art || id, 'deploy')); // it lands or climbs out before it moves
    for (let i = 0; i < count; i++) {
      const air = def.kind === 'flying';
      const start = isLeader('onu') && def.kind !== 'siege' ? line - 30 - i * 26 : x - i * 22;
      // seed: ignores the next hit; safe, bark: seconds it can't be hurt, is Armored; age: seconds on the field
      r.minis.push({ id, def, x: start, y: air ? GROUND - 110 - i * 8 : GROUND, w, h, tall, hp, max: hp, air,
        cd: 0, first: true, t: Math.random() * 3, flash: 0, lunge: 0, heal: 1, cast: 0, deploy, charged: !def.charge,
        seed: false, safe: passage ? 3 : 0, bark: tal('onu', 1) ? 8 : 0, age: 0 });
      if (tal('onu', 1)) burstOn('armor', r.minis[r.minis.length - 1]);
    }
    if (isLeader('anub-arak') && (def.family === 'Undead' || def.family === 'Beast') && id !== 'scarab') summon('scarab', 1);
    if (tal('thrall', 2) && paid !== undefined && def.family === 'Horde') { // Call of the Horde
      const e = nearestAhead(9999, true);
      if (e) { burstOn('horde-call', e); damage(e, 1, { elemental: true }); }
      r.haste = Math.max(r.haste, 3);
    }
  }

  // the effect new minis arrive in, for those added since there were `had` of them
  function arrive(had, key) { for (const m of run.minis.slice(had)) burstOn(key, m); }

  function lineOf(def) {
    if (def.kind === 'ranged') return RANGED_LINE;
    if (def.kind === 'flying') return def.range ? MELEE_LINE - 150 : MELEE_LINE - 40;
    return MELEE_LINE;
  }

  // more: changes to the summoned minis, such as more hearts or hits that poison
  function summon(id, n, atLine, more) {
    const r = run, def = more ? { ...SUMMONS[id], ...more } : SUMMONS[id];
    if (id === 'scarab' && r.minis.filter((m) => m.id === 'scarab').length >= 12) return;
    if (!sfx(`${def.art || id}.ready`, 0.5)) sfx('ui.deploy', 0.3);
    const had = r.minis.length;
    for (let i = 0; i < n; i++) addMini(id, def, atLine ? lineOf(def) - 40 - i * 30 : r.p.x + 10 - i * 26);
    arrive(had, SPAWN_FX[id] || 'deploy');
  }

  // ---------- attacks ----------
  // Starts an attack: its frames play over their own length, though no longer than `limit` (the time to the next
  // attack), and hit() lands part-way through, as the weapon comes down. id is the attacker's sprite.
  function swing(who, id, limit, hit) {
    who.lungeT = Math.min(sheets[id]?.anims.attack?.[2] || ATTACK_TIME, limit, SWING_MAX);
    sfx(`${id}.attack`, 0.3);
    burstOn(unitFx[id]?.cast, who);
    who.lunge = who.lungeT;
    (who.strikes ||= []).push({ t: who.lungeT * STRIKE, hit });
  }
  function strike(who, dt) {
    if (!who.strikes?.length) return;
    for (const k of who.strikes) k.t -= dt;
    const due = who.strikes.filter((k) => k.t <= 0);
    who.strikes = who.strikes.filter((k) => k.t > 0);
    for (const k of due) k.hit();
  }
  const attackPose = (who) => ({ anim: 'attack', p: 1 - who.lunge / (who.lungeT || ATTACK_TIME) });

  // ---------- cards ----------
  // What a card shows: a mini, or the picked leader's own card.
  function cardDef(id) {
    if (id === 'arcane-blast' && run?.arcane) return { ...MINIS[id], name: `Arcane Blast ${['I', 'II', 'III'][run.arcane]}` };
    if (!isLeaderCard(id)) return MINIS[id];
    const l = LEADERS[pick], dream = l.id === 'ysera' ? dreamOf(id) : null;
    // Ysera's cards have their own pictures (sprites/cards, next to the page); without them the card shows her portrait.
    const t = TALENTS[l.id][run ? run.talent : talentOf(l)];
    return { name: dream || t[0], family: l.family, cost: t[2], kind: 'leader', art: l.id,
      icon: dream && `sprites/cards/${dream.toLowerCase().replace(/s$/, '').replace(' ', '-')}.webp` };
  }
  // The dream a Dream card holds now: the first card goes forward through DREAMS from Emerald Whelps, the second
  // backward from Hibernate, each by its own count of plays.
  function dreamOf(id) {
    const n = DREAMS.length, k = run ? (id === SECOND_DREAM ? run.dream2 : run.dream) : 0;
    return DREAMS[id === SECOND_DREAM ? (((n - 1 - k) % n) + n) % n : k % n];
  }
  function cardCost(i) {
    const r = run, id = r.hand[i];
    if (!id) return 0;
    const def = cardDef(id);
    let c = def.cost;
    if (id === 'arcane-blast') c += r.arcane; // each tier costs 1 more
    if (r.costs) c = r.costs[0]; // Spirit Tangle
    if (isLeader('rend-blackhand') && def.kind === 'flying') c = Math.max(Math.min(c, 2), c - 1);
    if (isLeaderCard(id)) c = Math.max(1, c - r.resolve - r.cheap);
    if (r.clear && def.kind === 'spell') c = Math.max(Math.min(c, 1), c - 1); // Clearcasting
    return Math.max(0, c - r.discount);
  }

  function playCard(i) {
    const r = run, id = r.hand[i];
    if (!id) return;
    const cost = cardCost(i);
    const rc = cardRect(i);
    if (r.gold < cost) { float(rc.x + rc.w / 2, rc.y - 8, 'Not enough Gold', '#ffd0d0'); sfx('ui.nogold'); return; }
    r.gold -= cost;
    sfx('ui.card');
    // Arcane Blast stays for its next tier after the first two casts; any other card played puts a charged one away
    const stays = id === 'arcane-blast' && r.arcane < 2;
    if (!stays) { r.queue.push(id); r.hand[i] = r.queue.shift(); }
    if (id !== 'arcane-blast') dropArcane();
    if (r.costs) r.costs.push(r.costs.shift());
    r.discount = 0;
    r.clear = false;
    if (isLeaderCard(id)) { r.cheap = 0; useAbility(id); return; }
    if (isLeader('maiev-shadowsong') && cardDef(id).cost <= 2) r.cheap++; // its own cost, not a discounted one
    cast(id, cost);
    if (id === 'arcane-blast') r.arcane = stays ? r.arcane + 1 : 0;
    if (r.march > 0 && cost > 0) summon('murloc', cost, tal('old-murk-eye', 0)); // March of the Murlocs
  }

  // A charged Arcane Blast leaves the hand, back at its first tier: another card was played, or Tab or a right click.
  function dropArcane() {
    const r = run, i = r.hand.indexOf('arcane-blast');
    if (!r.arcane) return;
    r.arcane = 0;
    if (i >= 0) { r.queue.push('arcane-blast'); r.hand[i] = r.queue.shift(); }
  }

  function cast(id, paid) {
    const r = run, def = MINIS[id];
    if (def.kind === 'spell') {
      let n = def.dmg + (id === 'arcane-blast' ? r.arcane : 0);
      if (isLeader('jaina-proudmoore')) n *= 1.5;
      if (id === 'arcane-blast') {
        const e = nearestAhead(9999, true);
        if (e) { burstOn('arcane', e, 0.35 + r.arcane * 0.12); damage(e, n, { elemental: true, spell: true }); }
      } else {
        let from = { x: r.p.x + r.p.w, y: r.p.y - 40 };
        const hit = new Set();
        for (let k = 0; k < 4; k++) {
          const e = r.enemies.filter((o) => o.hp > 0 && !hit.has(o) && o.x > r.p.x)
            .sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))[0];
          if (!e) break;
          hit.add(e);
          from = { x: e.x + e.w / 2, y: e.y - e.h / 2 };
          // it jumps on from one to the next: each is struck a moment after the one before
          r.later.push({ t: k * JUMP, fn: () => { burstOn('lightning', e); damage(e, n, { elemental: true, spell: true }); } });
        }
      }
      sfx(`spell.${id}`, 0.5);
      if (isLeader('bloodmage-thalnos')) r.ritual += tal('bloodmage-thalnos', 2) && def.cost >= 2 ? 2 : 1; // Dark Ritual, Dominance
      if (tal('bloodmage-thalnos', 0)) { r.haste = Math.max(r.haste, 5); sparkle('#d0303a'); } // Bane
    } else {
      const proud = r.hubris && !def.elemental, had = r.minis.length; // Hubris
      addMini(id, proud ? { ...def, hp: (def.hp || HEARTS) + 2 } : def, r.p.x + 10, paid);
      if (proud) r.hubris = false;
      arrive(had, 'deploy');
      puff(r.p.x + 30, GROUND, '#e8e1c4', 8);
      if (!sfx(`${def.art || id}.ready`, 0.6)) sfx('ui.deploy');
    }
  }

  // ---------- leader card ----------
  function useAbility(id) {
    const r = run, p = r.p;
    const l = leader();
    sfx(`${l.id}.ready`, 0.6);
    const ahead = () => r.enemies.filter((e) => e.hp > 0 && e.x > p.x - 20);
    const foes = () => ahead().filter((e) => !ENEMIES[e.type].tower);
    const ground = () => foes().filter((e) => !e.air);
    const front = () => ground().filter((e) => e.x < p.x + NEAR + 60); // the ground enemies at your lines
    const nearest = (n) => foes().sort((a, b) => a.x - b.x).slice(0, n);
    const farthest = () => foes().sort((a, b) => b.x - a.x)[0];
    const shield = (t, kind) => { r.unhurt = t; r.unhurtKind = kind; };
    const HOLD_FX = { frost: 'frost-status', root: 'roots', stun: 'stun', sleep: 'sleep' };
    const freeze = (list, t, kind) => { for (const e of list) if (!ENEMIES[e.type].tower) { e.hold = t; e.holdKind = kind; burstOn(HOLD_FX[kind], e); } };
    const LASTS_FX = { haste: 'bloodlust', frenzy: 'bloodlust', veil: 'stealth' };
    const lasts = (what, t, color) => {
      r[what] = Math.max(r[what], t); sparkle(color);
      if (LASTS_FX[what]) for (const m of r.minis) if (what !== 'frenzy' || m.def.family === 'Beast') burstOn(LASTS_FX[what], m);
    };
    const later = (t, fn) => r.later.push({ t, fn });
    // lightning and the like on several enemies: each in its turn, a moment after the one before
    const chain = (list, strike) => list.forEach((e, k) => later(k * JUMP, () => { if (e.hp > 0) strike(e); }));
    // one hit on the nearest enemy or tower; returns it when it fell
    const hit = (n, o = {}) => {
      const e = nearestAhead(9999, true);
      if (!e) return null;
      burstOn(LEADER_HIT[l.id] || 'sharp', e); damage(e, typeof n === 'function' ? n(e) : n, o);
      return e.hp <= 0 ? e : null;
    };
    const burrow = () => { shield(2, 'burrow'); later(2, () => burstOn('emerge', p)); };
    const winter = () => { freeze(foes(), 2.5, 'frost'); snow(); };
    const shadowBolt = () => { const e = hit(2 + r.ritual * 0.5, { elemental: true }); if (e) heal(1); return e; };
    const stomp = () => { for (const e of front()) { damage(e, 1, {}); freeze([e], 2, 'stun'); } shake = 0.3; };
    const grasp = (n) => { chain(ground().sort((a, b) => a.x - b.x).slice(0, n), (e) => { damage(e, 1, {}); freeze([e], 3, 'root'); }); };
    const spike = (burn) => {
      const e = nearestAhead(9999, true);
      if (!e) return;
      burstOn('lava-spike', e);
      for (const o of ahead()) if (Math.abs(o.x - e.x) < 110) damage(o, 2, { elemental: true, burn });
      shake = 0.25;
    };
    const cleave = (o = {}) => {
      const e = nearestAhead(9999, true), n = Math.min(5, 1 + r.plays++);
      if (!e) return;
      for (const near of ahead()) if (Math.abs(near.x - e.x) < 90 && (!near.air || near === e)) { burstOn('crit', near); damage(near, n, o); }
      shake = 0.25;
    };
    const frostbolt = (burst) => {
      const e = nearestAhead(9999, true);
      if (!e) return;
      const list = [e, ...(burst ? ahead().filter((o) => o !== e && Math.abs(o.x - e.x) < 130) : [])];
      for (const o of list) damage(o, 2, { elemental: true });
      freeze(list, 2, 'frost');
      burstOn(burst ? 'ice-burst' : 'ice', e);
    };
    const assassinate = (e) => { if (!e) return false; burstOn('assassinate', e); damage(e, 3, {}); return e.hp <= 0; };
    const seeds = () => { for (const m of r.minis) { m.seed = true; burstOn('seed', m); } sparkle('#9be38f'); };
    const slam = () => { for (const e of front()) { damage(e, 1, {}); freeze([e], 1.5, 'stun'); } shake = 0.3; };
    const makgora = () => { const e = hit(4, {}); shake = 0.3; return e; };
    const blastWave = () => {
      const list = ahead().filter((e) => e.x < p.x + NEAR + 60);
      for (const e of list) damage(e, 2, { elemental: true });
      r.shots = [];
      shake = 0.3;
      return list;
    };
    const dragonFire = (n) => area(p.x + 40, p.x + NEAR + 60, n, { elemental: true, air: true });
    const saw = () => hit((e) => (e.type === 'tower' ? 3 : 2) + (tal('sneed', 2) ? r.towersDown : 0), {});
    const arrow = () => hit(3, { elemental: true });
    const lightning = () => chain(nearest(3), (e) => { burstOn('lightning', e); damage(e, 1, { elemental: true }); });
    const layOnHands = () => { for (const m of r.minis) { m.hp = m.max; burstOn('heal', m); } sparkle('#ffe9a0'); };
    // what the card does, done at the moment the leader's own clip for it strikes
    const act = () => {
      // the card's own effect, on the leader or at the front
      for (const [key, where] of [...(CARD_FX[l.id] || []), ...(CARD_FX[`${l.id} ${r.talent}`] || [])]) {
        if (where === 'self') burstOn(key, p); else burst(key, MELEE_LINE, GROUND);
      }
      switch (`${l.id} ${r.talent}`) {
        case 'anub-arak 0': burrow(); later(2, () => heal(1)); break;
        case 'anub-arak 1': burrow(); summon('scarab', 2); break;
        case 'anub-arak 2': burrow(); summon('scarab', 6); freeze(front(), 2, 'stun'); break;
        case 'arthas-menethil 0':
          winter();
          for (const e of foes()) {
            if (e.air) { e.air = false; e.y = GROUND; } else if (ENEMIES[e.type].fire) e.x = Math.min(e.x, MELEE_LINE + 70);
          }
          break;
        case 'arthas-menethil 1': winter(); for (const e of foes()) e.burn = Math.max(e.burn, 4); break;
        case 'arthas-menethil 2': winter(); break;
        case 'baron-rivendare 0': {
          const given = p.hp < 3 && r.minis.find((m) => m.hp > 0 && /^skeleton/.test(m.id));
          if (given) { fall(given); heal(1); } else summon('skeleton', 2, true);
          break;
        }
        case 'baron-rivendare 1': summon('skeleton', 3, true); break;
        case 'baron-rivendare 2': summon('skeleton-mage', 3); break;
        case 'bloodmage-thalnos 0': shadowBolt(); break;
        case 'bloodmage-thalnos 1': shadowBolt(); r.discount = 1; break;
        case 'bloodmage-thalnos 2': shadowBolt(); break;
        case 'cairne-bloodhoof 0': case 'cairne-bloodhoof 1': case 'cairne-bloodhoof 2': stomp(); break;
        case 'cenarius 0': lasts('totem', 8, '#9be38f'); break;
        case 'cenarius 1': lasts('totem', 4, '#9be38f'); freeze(ground(), 3, 'root'); break;
        case 'cenarius 2': lasts('totem', 4, '#9be38f'); freeze(foes(), 5, 'root'); break;
        case 'charlga-razorflank 0': grasp(3); break;
        case 'charlga-razorflank 1': case 'charlga-razorflank 2': grasp(1); break;
        case 'emperor-thaurissan 0': spike(9999); break;
        case 'emperor-thaurissan 1': spike(true); r.hubris = true; break;
        case 'emperor-thaurissan 2': spike(true); break;
        case 'general-drakkisath 0': hit(2, { elemental: true }); break;
        case 'general-drakkisath 1': line(2, '#ff8a3c'); break;
        case 'general-drakkisath 2': hit(2, { elemental: true }); r.banner = 10; float(p.x + 30, p.y - 100, 'Banner of Flame', '#ffb08a'); break;
        case 'grommash-hellscream 0': for (const e of front()) damage(e, 2, {}); shake = 0.3; break;
        case 'grommash-hellscream 1': hit(2); summon('mirror-image', 2); break;
        case 'grommash-hellscream 2': hit((e) => (e.hp < e.max ? 4 : 2)); break;
        case 'hogger 0': cleave(); heal(0.5); break;
        case 'hogger 1': cleave({ burn: 4 }); break;
        case 'hogger 2':
          cleave();
          for (const m of r.minis) if (m.def.family === 'Beast') { m.max++; m.hp++; }
          lasts('frenzy', 8, '#ffcf6b'); break;
        case 'jaina-proudmoore 0': frostbolt(); shield(2, 'stealth'); break;
        case 'jaina-proudmoore 1': frostbolt(); r.clear = true; break;
        case 'jaina-proudmoore 2': frostbolt(true); break;
        case 'maiev-shadowsong 0': shield(2, 'stealth'); assassinate(farthest()); lasts('veil', 3, '#8a7fc0'); break;
        case 'maiev-shadowsong 1': {
          shield(2, 'stealth');
          const far = farthest();
          for (const e of foes()) if (e === far || e.air || ENEMIES[e.type].fire) assassinate(e);
          break;
        }
        case 'maiev-shadowsong 2': shield(2, 'stealth'); for (let k = 0; k < 3 && assassinate(farthest()); k++); break;
        case 'malfurion 0': seeds(); break;
        case 'malfurion 1': seeds(); freeze(foes(), 4, 'sleep'); break;
        case 'malfurion 2': seeds(); later(10, seeds); break;
        case 'old-murk-eye 0': lasts('march', 6, '#bfe6ff'); break;
        case 'old-murk-eye 1': lasts('march', 11, '#bfe6ff'); break;
        case 'old-murk-eye 2': { lasts('march', 6, '#bfe6ff'); chain(nearest(3), (e) => { burstOn('eel', e); freeze([e], 1.5, 'stun'); }); break; }
        case 'onu 0': case 'onu 1': slam(); break;
        case 'onu 2': slam(); summon('treant', 3, true); break;
        case 'orgrim-doomhammer 0': makgora(); shield(3.5, 'stealth'); r.haste = Math.max(r.haste, 3.5); break;
        case 'orgrim-doomhammer 1': if (makgora()) { burstOn('warcry', p); lasts('haste', 10, '#ffcf6b'); } break;
        case 'orgrim-doomhammer 2': {
          const e = makgora(), d = e && ENEMIES[e.type];
          // the fallen enemy, on your side for a while
          if (e && !d.tower) {
            addMini(e.type, { name: e.type, family: 'Horde', kind: d.fire ? 'ranged' : e.air ? 'flying' : 'melee', dmg: d.hit || 1,
              rate: d.rate || 1, range: d.fire ? 260 : undefined, size: d.size, life: 15 }, e.x);
          }
          break;
        }
        case 'ragnaros 0': freeze(blastWave(), 2, 'stun'); break;
        case 'ragnaros 1': blastWave(); break;
        case 'ragnaros 2': blastWave(); summon('fire-elemental', 2); break;
        case 'rend-blackhand 0': {
          dragonFire(2);
          const e = nearestAhead(9999, true);
          if (e) later(2, () => { for (const o of r.enemies) if (o.hp > 0 && Math.abs(o.x - e.x) < 110) damage(o, 2, { elemental: true }); burst('big-explosion', e.x + e.w / 2, GROUND - 20); shake = 0.25; });
          break;
        }
        case 'rend-blackhand 1': dragonFire(2); r.guard = true; break;
        case 'rend-blackhand 2': dragonFire(1); summon('drake', 1); break;
        case 'sneed 0': saw(); r.owed += 4; break;
        case 'sneed 1': case 'sneed 2': saw(); break;
        case 'sylvanas-windrunner 0': line(3, '#bfe0a0'); break;
        case 'sylvanas-windrunner 1': arrow(); freeze(foes(), 3, 'stun'); break;
        case 'sylvanas-windrunner 2': arrow(); break;
        case 'thrall 0': lightning(); lasts('totem', 8, '#9be38f'); break;
        case 'thrall 1': lightning(); summon('spirit-wolf', 2); break;
        case 'thrall 2': lightning(); break;
        case 'tirion-fordring 0': case 'tirion-fordring 1': case 'tirion-fordring 2': layOnHands(); break;
        case 'kobold-miner 0': case 'kobold-miner 1': case 'kobold-miner 2':
          if (hit(2, {})) { r.gold = Math.min(10, r.gold + 1); float(p.x + 30, p.y - 90, '+1 Gold', '#ffe28a'); }
          if (r.talent === 0) r.owed += 2; else if (r.talent === 1) r.guard = true; else summon('kobold', 2);
          break;
        default: { // Ysera
          const dream = dreamOf(id), venom = r.talent === 1 ? { venom: true } : null;
          if (id === SECOND_DREAM) r.dream2++; else r.dream++;
          if (dream === 'Emerald Whelps') summon('emerald-whelp', 3, false, venom);
          else if (dream === 'Emerald Drake') summon('emerald-drake', 1, false, venom);
          else if (dream === 'Hibernate') freeze(r.talent === 2 ? foes() : nearest(3), 4, 'sleep');
          else { r.owed += 4; sparkle('#9be38f'); } // Innervate: 4 Gold over 10 s
        }
      }
    };
    // Grommash spins for Bladestorm and swings his axe for the rest
    p.act = tal('grommash-hellscream', 0) && clip(l.id, 'cast') ? 'cast' : 'attack';
    swing(p, l.id, 1.4, act);
    if (has('PvpModifier_HerosResolve')) r.resolve++;
  }

  function nearestAhead(range, withTowers) {
    const p = run.p;
    return run.enemies.filter((e) => e.hp > 0 && e.x > p.x && e.x - p.x < range && (withTowers || !ENEMIES[e.type].tower))
      .sort((a, b) => a.x - b.x)[0] || null;
  }
  function area(x0, x1, n, o) {
    const r = run;
    for (const e of r.enemies) if (e.hp > 0 && e.x + e.w > x0 && e.x < x1 && (o.air || !e.air)) damage(e, n, o);
    for (let i = 0; i < 30; i++) {
      r.fx.push({ x: lerp(x0, x1, Math.random()), y: GROUND - Math.random() * 120, vx: 0, vy: -60 - Math.random() * 80,
        life: 0.6, max: 0.6, size: 10 + Math.random() * 16, color: Math.random() < 0.5 ? '#ffb347' : '#ff6a2b' });
    }
    shake = 0.25;
  }
  function line(n, color) {
    const r = run, p = r.p;
    for (const e of r.enemies) if (e.hp > 0 && e.x > p.x) damage(e, n, { elemental: true });
    r.fx.push({ line: true, x: p.x + p.w, y: p.y - 34, x2: W, y2: p.y - 34, life: 0.3, max: 0.3, color, width: 6 });
  }
  function heal(n) {
    const p = run.p;
    if (p.hp < 3) { p.hp = Math.min(3, p.hp + n); float(p.x + 30, p.y - 90, n < 1 ? '+½ heart' : `+${n} heart${n > 1 ? 's' : ''}`, '#ffd0e6'); }
  }

  // ---------- combat ----------
  function damage(e, n, o = {}) {
    const r = run, tower = e.type === 'tower';
    if (e.hp <= 0) return;
    if (isLeader('general-drakkisath') && o.elemental) n *= 1.5; // Banner of Flame
    if (r.banner > 0 && o.elemental) n *= 1.5; // Lasting Legacy
    // Soulshatter: a frozen enemy that is already hurt dies; with Necrotic Plague a poisoned one too
    if (isLeader('arthas-menethil') && !tower && e.hp < e.max
      && ((e.hold > 0 && e.holdKind === 'frost') || (tal('arthas-menethil', 1) && e.burn > 0))) n = Math.max(n, e.hp);
    if (e.holdKind === 'sleep') { e.hold = 0; e.holdKind = null; }
    e.hp -= n;
    e.flash = 0.12;
    if (o.burn) {
      if (e.burn <= 0) burstOn(o.burn === 4 ? 'poisoned' : 'burning', e);
      e.burn = Math.max(e.burn, o.burn === true ? 2 : o.burn); // seconds of burning
    }
    if (e.hp <= 0) kill(e);
  }

  function kill(e) {
    const r = run;
    r.kills++;
    const tower = e.type === 'tower';
    r.score += tower ? 50 : 10;
    puff(e.x + e.w / 2, e.y - e.h / 2, tower ? '#9a9486' : '#d9d2bf', tower ? 24 : 10);
    if (!tower) { corpse(e.type, e, { enemy: true, air: e.air }); burst('poof', e.x + e.w / 2, e.y - e.h / 2); }
    if (!sfx(tower ? 'tower.fall' : `${e.type}.death`)) sfx('death', 0.35);
    if (tower) sfx('gold.coin', 0.5);
    if (r.purgatory > 0) { r.purgatory = 0; r.p.hp = 1; float(r.p.x + 30, r.p.y - 100, 'Purgatory', '#cfe8ff'); }
    if (tal('cenarius', 1) && e.hold > 0 && e.holdKind === 'root') summon('treant', 1, true); // Force of Nature
    if (tal('emperor-thaurissan', 2) && e.burn > 0 && ++r.wit >= 6) { r.wit = 0; heal(1); } // Moira's Wit
    if (tower) {
      r.towersDown++;
      r.gold = Math.min(10, r.gold + 3);
      float(e.x + e.w / 2, e.y - e.h - 10, '+3 Gold', '#ffe28a');
      if (isLeader('sneed')) { // Sneed Before Greed, Lead with Greed
        const n = tal('sneed', 1) ? 4 : 2;
        r.gold = Math.min(10, r.gold + n); float(e.x + e.w / 2, e.y - e.h - 34, `+${n} Sneed`, '#ffe28a');
        burst('coins', e.x + e.w / 2, GROUND);
      }
      shake = 0.3;
      if (has('PvpModifier_CollateralDamage')) {
        for (const o of r.enemies) if (o !== e && Math.abs(o.x - e.x) < 320) damage(o, 2);
        float(e.x + e.w / 2, e.y - e.h - 58, 'Collateral!', '#ffb08a');
      }
      if (has('PvpModifier_Stonebind')) r.stones.push({ x: e.x + 22, y: GROUND, w: 40, h: 36 });
      r.nextSpawn = r.traveled + 420;
    }
    if (has('PvpModifier_BountyHunt') && ++r.bounty >= 5) {
      r.bounty = 0;
      r.gold = Math.min(10, r.gold + 1);
      float(e.x + e.w / 2, e.y - e.h - 24, '+1 Bounty', '#ffe28a');
    }
  }

  function hurtPlayer(n) {
    const r = run, p = r.p;
    if (p.inv > 0 || r.unhurt > 0 || r.purgatory > 0) return false;
    if (r.guard) { r.guard = false; p.inv = 1; float(p.x + 30, p.y - 100, 'Turned aside', '#ffb08a'); return true; } // Scale and Steel
    p.hp -= n;
    p.inv = 1.2;
    shake = 0.3;
    puff(p.x + p.w / 2, p.y - p.h / 2, '#ff6b6b', 10);
    sfx('tower.hit', 0.5);
    if (isLeader('ragnaros')) { // Molten Armor
      for (const e of r.enemies) if (e.hp > 0 && Math.abs(e.x - p.x) < 180) { burstOn('fire-small', e); damage(e, 1, { elemental: true }); }
    }
    if (p.hp <= 0 && tal('cairne-bloodhoof', 0) && !r.reborn) { r.reborn = true; p.hp = 1; p.inv = 2; burstOn('resurrect', p); float(p.x + 30, p.y - 100, 'Reincarnation', '#ffe9b0'); }
    if (p.hp <= 0 && tal('arthas-menethil', 2) && !r.purged) { r.purged = true; p.hp = 0; r.purgatory = 3; return true; } // a kill in time saves you
    if (p.hp > 0 && p.hp <= 1 && tal('tirion-fordring', 1)) { r.unhurt = 5; r.unhurtKind = 'shield'; } // Divine Shield
    if (p.hp <= 0) endRun();
    return true;
  }

  // shot: it came from a tower or another ranged enemy
  function hurtMini(m, n, attacker, shot) {
    const r = run, d = m.def;
    if (r.veil > 0 || m.safe > 0) return;
    if (m.seed) { // Seeds of Protection; Natural Salve
      m.seed = false;
      if (tal('malfurion', 0)) { m.hp = m.max; burstOn('nature-heal', m); }
      puff(m.x + m.w / 2, m.y - m.h / 2, '#9be38f', 8);
      return;
    }
    if (d.armored || m.bark > 0) n *= 0.5;
    // Chromatic Scales; Warchief's Presence
    if (shot && (tal('general-drakkisath', 0) || (isLeader('thrall') && (d.family === 'Horde' || d.elemental)))) n *= 0.5;
    m.hp -= n;
    m.flash = 0.12;
    if (attacker && isLeader('ragnaros') && d.armored) attacker.burn = Math.max(attacker.burn, 2); // Molten Armor
    if (m.hp <= 0) fall(m);
  }

  // A mini is gone: what it leaves, and what its going sets off.
  function fall(m) {
    const r = run, d = m.def;
    m.hp = 0;
    puff(m.x + m.w / 2, m.y - m.h / 2, '#e8e1c4', 8);
    if (m.id === 'scarab' && tal('anub-arak', 1)) { // Explosive Shells
      burst('poison', m.x + m.w / 2, m.y - m.h / 2);
      for (const e of r.enemies) if (e.hp > 0 && Math.abs(e.x + e.w / 2 - (m.x + m.w / 2)) < 90) damage(e, 1, {});
    }
    corpse(d.art === undefined ? m.id : d.art, m, { family: d.family, air: m.air });
    burst('poof', m.x + m.w / 2, m.y - m.h / 2);
    if (!sfx(`${d.art === undefined ? m.id : d.art || m.id}.death`, 0.35)) sfx('death', 0.3);
    if (isLeader('anub-arak') && (d.family === 'Undead' || d.family === 'Beast') && m.id !== 'scarab') summon('scarab', 1);
  }

  // What a fallen unit leaves for a moment: its death clip when it has one, or else it tips over and fades.
  function corpse(art, u, more) {
    const fall = Math.min(DEATH_MAX, clip(art || 'scarab', 'death'));
    run.corpses.push({ art, x: u.x, y: u.y, w: u.w, h: u.h, tall: u.tall, fall: fall > 0, life: fall || 0.4, max: fall || 0.4, ...more });
  }

  function endRun() {
    const r = run;
    mode = 'over';
    sfx('over', 0.5);
    r.score = Math.floor(r.score);
    r.saved = saveScore(r.leader.id, r.score);
  }

  // ---------- effects ----------
  function puff(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      run.fx.push({ x, y, vx: (Math.random() - 0.5) * 240, vy: -Math.random() * 220, life: 0.5, max: 0.5,
        size: 3 + Math.random() * 5, color, grav: true });
    }
  }
  function float(x, y, text, color) { run.texts.push({ x, y, text, color, life: 1 }); }
  function snow() {
    for (let i = 0; i < 40; i++) {
      run.fx.push({ x: Math.random() * W, y: Math.random() * GROUND, vx: 0, vy: 30, life: 0.9, max: 0.9, size: 3 + Math.random() * 5,
        color: '#e3f3ff' });
    }
  }
  function sparkle(color) {
    for (const m of run.minis) puff(m.x + m.w / 2, m.y - m.h / 2, color, 4);
    puff(run.p.x + 23, run.p.y - 32, color, 8);
  }

  // seconds per Gold
  function goldRate() {
    let rate = 1.4;
    if (has('PvpModifier_GoldRush')) rate /= 2;
    if (has('PvpModifier_AdrenalineRush')) rate /= 1 + 0.5 * (3 - run.p.hp);
    return rate;
  }

  // ---------- update ----------
  function update(dt) {
    const r = run, p = r.p;
    r.time += dt;

    // speed: a standing tower stops the lane at whoever is first in its way, the leader or a mini
    let spd = (220 + Math.min(240, (r.traveled / M) * 0.14)) * (tal('cairne-bloodhoof', 1) ? 1.2 : 1); // Plainsrunning
    const tower = r.enemies.find((e) => e.type === 'tower' && e.hp > 0);
    if (tower) {
      let front = p.x + p.w;
      for (const m of r.minis) if (m.hp > 0 && m.def.kind !== 'siege' && m.x < tower.x) front = Math.max(front, m.x + m.w + 4);
      const gap = tower.x - front;
      if (gap <= spd * dt) spd = Math.max(0, gap / dt);
    }
    if (p.deploy > 0) { p.deploy -= dt; spd = 0; } // the leader arrives first
    r.stalled = spd < 1;
    r.spd = spd;
    r.traveled += spd * dt;
    r.bg += spd * dt;
    r.score += (spd * dt) / M;

    // timers
    r.unhurt = Math.max(0, r.unhurt - dt);
    if (r.unhurt <= 0) r.unhurtKind = null;
    p.inv = Math.max(0, p.inv - dt);
    for (const k of ['haste', 'frenzy', 'veil', 'totem', 'banner', 'march']) r[k] = Math.max(0, r[k] - dt);
    if (r.purgatory > 0 && (r.purgatory -= dt) <= 0) { endRun(); return; } // nothing fell in time
    for (const k of r.later) if ((k.t -= dt) <= 0) k.fn();
    r.later = r.later.filter((k) => k.t > 0);
    p.lunge = Math.max(0, p.lunge - dt);
    strike(p, dt);
    r.timer += dt;
    if (isLeader('baron-rivendare') && r.timer >= 15) { r.timer = 0; summon(tal('baron-rivendare', 2) ? 'skeleton-mage' : 'skeleton', 2); }
    if (isLeader('tirion-fordring') && r.timer >= (tal('tirion-fordring', 0) ? 4 : 8)) { // Holy Light; By the Light
      r.timer = 0;
      for (const m of r.minis) { if (m.hp < m.max) burstOn('heal', m); m.hp = Math.min(m.max, m.hp + 1); }
      sparkle('#ffe9a0');
    }
    r.timer2 += dt;
    if (r.timer2 >= 4) {
      r.timer2 = 0;
      if (tal('ragnaros', 1)) { // Radiant Flames
        const e = nearestAhead(9999, false);
        if (e) { burstOn('fire-small', e); damage(e, 1, { elemental: true }); }
      }
      if (tal('tirion-fordring', 2)) { // Consecrate
        for (const e of r.enemies) if (e.hp > 0 && !e.air && e.type !== 'tower' && e.x < p.x + NEAR + 60) damage(e, 0.5, {});
        burst('consecrate', MELEE_LINE, GROUND);
      }
    }

    // gold
    const rate = goldRate();
    if (r.gold < 10) {
      r.goldT += dt;
      while (r.goldT >= rate && r.gold < 10) { r.goldT -= rate; if (++r.gold === 10) sfx('gold.max', 0.3); }
    } else r.goldT = 0;
    if (isLeader('kobold-miner') && (r.mine += dt) >= 8) { r.mine = 0; r.gold = Math.min(10, r.gold + 1); float(46, 500, '+1 Gold', '#ffe28a'); }
    if (r.owed > 0) {
      r.owedT += dt;
      if (r.owedT >= 2.5) { r.owedT -= 2.5; r.owed--; r.gold = Math.min(10, r.gold + 1); float(46, 500, '+1 Gold', '#ffe28a'); }
    } else r.owedT = 0;


    // spawning
    if (!tower && r.traveled >= r.nextTower) {
      addEnemy('tower', W + 60);
      r.nextTower = r.traveled + 600 * M;
    } else if (!tower && r.traveled >= r.nextSpawn) spawnWave();

    const scroll = (o, vx) => { o.x += (vx - spd) * dt; };

    // enemies
    for (const e of r.enemies) {
      const d = ENEMIES[e.type];
      e.t += dt;
      e.flash = Math.max(0, e.flash - dt);
      e.lunge = Math.max(0, e.lunge - dt);
      if (e.hp <= 0) continue;
      strike(e, dt);
      if (e.burn > 0) {
        e.burn -= dt;
        e.burnT += dt;
        if (e.burnT >= 1) { e.burnT = 0; damage(e, 0.5, { elemental: true }); if (e.hp <= 0) continue; }
      }
      e.daze = Math.max(0, e.daze - dt);
      if (e.hold > 0 && (e.hold -= dt) <= 0) {
        if (e.holdKind === 'stun' && tal('cairne-bloodhoof', 2)) e.daze = 5; // Aftershock
        e.hold = 0; e.holdKind = null;
      }
      const held2 = e.hold > 0;
      // a mini in its way holds it where they meet, while the lane moves on under them: ground enemies are held by
      // ground minis, fliers by any mini, and those that can strike fight the one holding them
      const blocker = d.tower ? null : r.minis.find((m) => (e.air || !m.air) && m.hp > 0 && e.x < m.x + m.w && e.x + e.w > m.x);
      const foe = d.hit ? blocker : null;
      scroll(e, blocker ? spd : held2 || d.tower ? 0 : -d.walk * (e.daze > 0 ? 0.5 : 1));
      if (e.air) e.y = GROUND - d.alt + Math.sin(e.t * 5) * 3;
      if (held2) continue;
      if (foe) {
        e.atk -= dt;
        if (e.atk <= 0) { e.atk = d.rate * (e.daze > 0 ? 2 : 1); swing(e, e.type, d.rate, () => { if (foe.hp > 0) { sfx(`${e.type}.hit`, 0.25); burstOn(unitFx[e.type]?.impact || 'sharp', foe); hurtMini(foe, d.hit, e); } }); }
      }
      if (d.fire && e.x < W - 30 && e.x > p.x + 80) {
        e.fire -= dt;
        if (e.fire <= 0) {
          e.fire = d.fire;
          swing(e, e.type, d.fire, () => r.shots.push({ kind: 'bolt', x: e.x - 10, y: GROUND - 40, w: 16, h: 6, vx: -280, dmg: 1 }));
        }
      }
      if (d.tower && e.x < W - 80) towerFire(e, dt);
      // touching the leader
      if (!d.tower && overlap(e, p)) {
        const k = r.unhurtKind;
        if (k === 'burrow' || k === 'stealth') continue;
        if (k === 'shield') { damage(e, 99, {}); continue; }
        if (hurtPlayer(d.dmg)) {
          e.hp = 0; // (it got through: gone without counting as a kill)
          puff(e.x + e.w / 2, e.y - e.h / 2, '#d9d2bf', 8);
        }
      }
    }

    // minis
    for (const m of r.minis) {
      const d = m.def;
      m.t += dt;
      m.flash = Math.max(0, m.flash - dt);
      m.lunge = Math.max(0, m.lunge - dt);
      if (m.hp <= 0) continue;
      strike(m, dt);
      m.cast = Math.max(0, m.cast - dt);
      m.safe = Math.max(0, m.safe - dt);
      m.bark = Math.max(0, m.bark - dt);
      m.age += dt;
      if (d.life && m.age >= d.life) { fall(m); continue; }
      if (r.totem > 0) {
        if (m.hp < m.max && Math.floor(m.t * 1.5) !== Math.floor((m.t - dt) * 1.5)) burstOn('nature-heal', m);
        m.hp = Math.min(m.max, m.hp + 0.5 * dt);
      }
      if (m.deploy > 0) { m.deploy -= dt; m.still = false; scroll(m, spd); continue; }
      if (isLeader('malfurion') && (d.family === 'Alliance' || d.family === 'Cenarion') && m.hp < m.max) m.hp = Math.min(m.max, m.hp + 0.25 * dt);
      const range = d.range || 8;
      const hitsAir = d.hitsAir || d.kind === 'flying';
      let target = null, near = Infinity;
      const behind = m.x + m.w < p.x;
      for (const e of behind ? [] : r.enemies) {
        if (e.hp <= 0 || (e.air && !hitsAir)) continue;
        const gap = e.x - (m.x + m.w);
        if (gap < -e.w - m.w || gap > range) continue;
        if (gap < near) { near = gap; target = e; }
      }
      let adv = ADVANCE;
      if (isLeader('sylvanas-windrunner') && (d.family === 'Horde' || d.family === 'Undead')) adv *= 2; // Windrunner Warchief
      if (!m.charged) adv = 160;
      let vx;
      if (target) vx = spd; // holds its place while it fights
      else if (behind) vx = spd + 140;
      else if (d.kind === 'siege') vx = spd + 140;
      else vx = m.x + m.w / 2 < lineOf(d) ? spd + adv : spd;
      scroll(m, vx);
      m.still = !!target && r.stalled;
      m.x = Math.max(m.x, 12);
      if (tower && d.kind !== 'siege') m.x = Math.min(m.x, tower.x - m.w - 4);
      if (d.healer) {
        m.heal -= dt;
        if (m.heal <= 0) {
          m.heal = 2.5;
          const hurt = r.minis.filter((o) => o !== m && o.hp > 0 && o.hp < o.max && Math.abs(o.x - m.x) < 320).sort((a, b) => a.hp / a.max - b.hp / b.max)[0];
          if (hurt) {
            hurt.hp = Math.min(hurt.max, hurt.hp + 1);
            burstOn('heal', hurt);
            burstOn('heal-cast', m);
            m.cast = Math.min(CAST_MAX, clip(m.id, 'cast'));
          }
        }
      }
      if (!target) continue;
      if (d.kind === 'siege') {
        let n = d.dmg;
        if (m.first && has('PvpModifier_FirstStrike')) n *= 2;
        // the blast hits everything on the ground nearby
        for (const e of r.enemies) {
          if (e.hp > 0 && !e.air && Math.abs(e.x + e.w / 2 - (target.x + target.w / 2)) < 110) damage(e, n, {});
        }
        m.hp = 0;
        burst('explosion', m.x + m.w, GROUND - 20);
        shake = 0.25;
        continue;
      }
      m.cd -= dt;
      if (m.cd > 0) continue;
      let rateMul = 1;
      if (isLeader('grommash-hellscream')) rateMul = 1.3; // For The Horde!
      if (tal('sylvanas-windrunner', 2) && (d.family === 'Horde' || d.family === 'Undead')) rateMul = 1.3; // Forsaken Fury
      if (tal('baron-rivendare', 1) && /^skeleton/.test(m.id)) rateMul = 2; // Skeletal Frenzy
      if (r.haste > 0 || (r.frenzy > 0 && d.family === 'Beast')) rateMul *= 1.5;
      m.cd = d.rate / rateMul;
      const land = () => {
        if (target.hp <= 0) return;
        let n = d.dmg;
        const charging = !m.charged;
        if (charging) { n *= 2; m.charged = true; }
        if (m.first && has('PvpModifier_FirstStrike')) n *= 2;
        if (m.first && isLeader('orgrim-doomhammer') && (d.family === 'Horde' || d.family === 'Blackrock')) n *= 2;
        if (m.first && tal('onu', 0)) n *= 2; // From the Trees!
        if (isLeader('thrall') && (d.family === 'Horde' || d.elemental)) n *= 1.5;
        m.first = false;
        sfx(`${d.art === undefined ? m.id : d.art || m.id}.hit`, 0.25);
        const o = { elemental: d.elemental, burn: d.venom ? 4 : d.poison || (isLeader('emperor-thaurissan') && !d.elemental) };
        burstOn(charging ? 'charge' : unitFx[d.art === undefined ? m.id : d.art || m.id]?.impact || HIT_FX[m.id] || 'sharp', target);
        if (d.cleave) {
          for (const e of r.enemies) {
            if (e.hp > 0 && (!e.air || hitsAir) && Math.abs(e.x - target.x) < 70) damage(e, n, o);
          }
        } else damage(target, n, o);
        if (d.root && target.hp > 0 && !ENEMIES[target.type].tower) { target.hold = Math.max(target.hold, 0.6); target.holdKind = 'root'; }
        if (d.chill && target.hp > 0 && !ENEMIES[target.type].tower) { target.hold = Math.max(target.hold, 0.5); target.holdKind = 'frost'; }
      };
      // a ranged attack lets its projectile fly as the swing comes down; the hit lands when that arrives
      swing(m, d.art === undefined ? m.id : d.art || m.id, m.cd, !d.range ? land : () => {
        if (m.hp > 0 && target.hp > 0) r.bolts.push({ x: m.x + m.w, y: m.y - m.tall * 0.55, a: 0, t: 0, target, land, shot: SHOTS[m.id] || {} });
      });
    }

    // your minis' projectiles: each flies at its target and lands its hit there
    for (const b of r.bolts) {
      const t = b.target, dx = t.x + t.w / 2 - b.x, dy = t.y - t.h / 2 - b.y, dist = Math.hypot(dx, dy);
      b.t += dt;
      if (t.hp <= 0) b.done = true;
      else if (dist <= SHOT_SPEED * dt) { b.done = true; b.land(); }
      else { b.a = Math.atan2(dy, dx); b.x += (dx / dist) * SHOT_SPEED * dt; b.y += (dy / dist) * SHOT_SPEED * dt; }
    }

    // the enemies' shots
    for (const s of r.shots) {
      if (s.kind === 'rocket') {
        s.t -= dt;
        scroll(s, 0);
        if (s.t <= 0) {
          s.done = true;
          sfx('tower.rocket.boom');
          burst('explosion', s.x, GROUND - 20);
          shake = 0.2;
          const blast = { x: s.x - 60, y: GROUND, w: 120, h: 60 };
          if (overlap(blast, p) && !['burrow', 'stealth'].includes(r.unhurtKind)) hurtPlayer(1);
          for (const m of r.minis) if (!m.air && overlap(blast, m)) hurtMini(m, 1, null, true);
        }
        continue;
      }
      scroll(s, s.vx);
      if (s.x < -60 || s.x > W + 60) { s.done = true; continue; }
      const m = r.minis.find((o) => !o.air && o.hp > 0 && overlap(s, o));
      if (m) { if (!s.art) burstOn('curse', m); hurtMini(m, s.dmg, null, true); s.done = true; continue; }
      if (overlap(s, p) && !['burrow', 'stealth'].includes(r.unhurtKind)) { hurtPlayer(s.dmg); s.done = true; }
    }

    // stones left by fallen towers
    for (const st of r.stones) {
      scroll(st, 0);
      if (overlap(st, p)) { st.done = true; heal(1); puff(st.x + st.w / 2, GROUND - 20, '#a7d4ff', 10); }
    }

    // effects
    for (const f of r.fx) {
      f.life -= dt;
      if (!f.line) {
        f.x += (f.vx - (f.grav ? spd * 0.5 : 0)) * dt;
        f.y += f.vy * dt;
        if (f.grav) f.vy += 700 * dt;
      }
    }
    for (const c of r.corpses) { c.life -= dt; c.x -= spd * dt; }
    for (const b of r.bursts) { b.t += dt; if (!b.on) b.x += (b.vx - spd) * dt; }
    for (const t of r.texts) { t.life -= dt; t.y -= 30 * dt; }

    r.enemies = r.enemies.filter((e) => e.hp > 0 && e.x > -220);
    r.minis = r.minis.filter((m) => m.hp > 0);
    r.shots = r.shots.filter((s) => !s.done);
    r.bolts = r.bolts.filter((b) => !b.done);
    r.stones = r.stones.filter((s) => !s.done && s.x > -60);
    r.fx = r.fx.filter((f) => f.life > 0);
    r.bursts = r.bursts.filter((b) => b.t < effects[b.key].seconds);
    r.corpses = r.corpses.filter((c) => c.life > 0);
    r.texts = r.texts.filter((t) => t.life > 0);
  }

  function towerFire(e, dt) {
    const r = run, p = r.p;
    // each shot shows 0.6 s ahead (the tower glows)
    if (e.windup > 0) {
      e.windup -= dt;
      if (e.windup > 0) return;
    } else {
      e.fire -= dt;
      if (e.fire <= 0) e.windup = 0.6;
      return;
    }
    sfx(`tower.${e.kind}.shot`, 0.35);
    if (e.kind === 'dragon') {
      e.fire = 2.4;
      r.shots.push({ kind: 'fire', x: e.x - 40, y: GROUND, w: 52, h: 26, vx: -250, dmg: 1 });
    } else if (e.kind === 'rocket') {
      e.fire = 2.6;
      // at the ground mini nearest the tower, or at the leader when none stands in the way
      const front = r.minis.filter((m) => !m.air && m.hp > 0 && m.x < e.x).sort((a, b) => b.x - a.x)[0] || p;
      const tx = front.x + front.w / 2 + (Math.random() - 0.5) * 30;
      r.shots.push({ kind: 'rocket', x: tx, y: GROUND, w: 0, h: 0, t: 0.9, max: 0.9, fromX: e.x + 40 });
    } else {
      e.fire = e.kind === 'guard' ? 1.1 : 2.2;
      r.shots.push({ kind: 'bolt', art: 'shot-tower-guard', x: e.x - 16, y: GROUND - 40, w: 18, h: 6, vx: e.kind === 'guard' ? -400 : -300, dmg: 1 });
    }
  }

  // ---------- drawing: scenery ----------
  // Back to front: sky, sun and clouds, two rows of hills, then three rows of trees and props from one of the game's
  // maps (sprites/bg-*.png, cut-outs seen from the side), each standing along a grass bank and moving faster than the one
  // behind it, and last the lane. Without the pictures the banks carry plain trees.
  function drawScenery(off) {
    const sky = ctx.createLinearGradient(0, 0, 0, GROUND);
    sky.addColorStop(0, '#4a8fd6'); sky.addColorStop(0.55, '#a5d6f0'); sky.addColorStop(1, '#f4eecd');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, GROUND);
    const sun = ctx.createRadialGradient(1040, 100, 0, 1040, 100, 240);
    sun.addColorStop(0, 'rgba(255,250,222,1)'); sun.addColorStop(0.14, 'rgba(255,246,205,0.95)');
    sun.addColorStop(0.2, 'rgba(255,244,200,0.35)'); sun.addColorStop(1, 'rgba(255,244,200,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(800, 0, 480, 340);
    for (let i = 0; i < 6; i++) {
      const span = W + 500, x = ((i * 397 - off * (0.03 + (i % 3) * 0.012)) % span + span) % span - 250;
      cloud(x, 50 + (i * 67) % 150, 0.7 + (i % 3) * 0.3);
    }
    layer(off * 0.06, shade(190, 330, '#9db9d8', '#c3dcea'), (x) => 250 + Math.sin(x * 0.006) * 55 + Math.sin(x * 0.017) * 22);
    layer(off * 0.14, shade(280, 400, '#86b98a', '#b4d9a4'), (x) => 325 + Math.sin(x * 0.01) * 28 + Math.sin(x * 0.023) * 12);
    // each row stands along the top of its own grass bank, lighter toward the back
    bank(off * 0.26, GROUND - 100, '#a3d481', '#86c463', 4);
    if (!strip('bg-hogger-far', off * 0.26, GROUND - 90, 0.44, 0.5)) pines(off * 0.26, GROUND - 100, 0.8, '#6fa27a');
    bank(off * 0.48, GROUND - 68, '#86c65c', '#6db447', 4);
    if (!strip('bg-hogger-mid', off * 0.48, GROUND - 56, 0.5, 0.32)) pines(off * 0.48, GROUND - 66, 1.2, '#4f8a4a');
    bank(off * 0.74, GROUND - 36, '#72b944', '#5aa636', 3);
    // the lane the units walk on is the map's own painted ground; the near trees stand along its far edge
    lane(off);
    strip('bg-hogger-near', off * 0.74, GROUND - 18, 0.62, 0.2);
  }

  // The lane: a band of the map's painted ground, laid end to end (every other one mirrored, so the joins match),
  // lightened to sit with the hills and shaded where it runs under the trees. Plain grass until the picture is in.
  const LANE_TOP = GROUND - 30, LANE_BAND = [350, 120]; // the band of the picture used: its top and height
  let laneTile = null;
  function lane(off) {
    const im = sprite('bg-hogger-lane'), h = H - LANE_TOP;
    if (!im) { ctx.fillStyle = '#5c9a34'; ctx.fillRect(0, LANE_TOP, W, h); return; }
    if (!laneTile) {
      const w = Math.round(im.width * 0.6);
      laneTile = document.createElement('canvas');
      laneTile.width = w * 2; laneTile.height = h;
      const c = laneTile.getContext('2d');
      c.drawImage(im, 0, LANE_BAND[0], im.width, LANE_BAND[1], 0, 0, w, h);
      c.translate(w * 2, 0); c.scale(-1, 1);
      c.drawImage(im, 0, LANE_BAND[0], im.width, LANE_BAND[1], 0, 0, w, h);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = 'rgba(190,230,110,0.2)'; c.fillRect(0, 0, w * 2, h);
      const shadow = c.createLinearGradient(0, 0, 0, 22);
      shadow.addColorStop(0, 'rgba(24,60,18,0.55)'); shadow.addColorStop(1, 'rgba(24,60,18,0)');
      c.fillStyle = shadow; c.fillRect(0, 0, w * 2, 22);
    }
    const w = laneTile.width;
    for (let x = -(((off % w) + w) % w); x < W; x += w) ctx.drawImage(laneTile, Math.round(x), LANE_TOP);
  }

  const shade = (y0, y1, top, bottom) => {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, top); g.addColorStop(1, bottom);
    return g;
  };

  // A row of hills: f gives the top at each x; it is filled down to the ground.
  function layer(off, color, f) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, GROUND);
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, f(x + off));
    ctx.lineTo(W, GROUND);
    ctx.fill();
  }

  // A grass bank with a gently uneven top, from y down to the ground.
  function bank(off, y, top, bottom, wave = 7) {
    layer(off, shade(y - wave, GROUND, top, bottom), (x) => y + Math.sin(x * 0.011) * wave + Math.sin(x * 0.029) * wave * 0.45);
  }

  function cloud(x, y, k) {
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.beginPath();
    for (const [dx, dy, r] of [[0, 0, 26], [30, -12, 32], [66, -4, 28], [96, 4, 20], [44, 8, 30]]) {
      ctx.moveTo(x + (dx + r) * k, y + dy * k);
      ctx.ellipse(x + dx * k, y + dy * k, r * k, r * k * 0.62, 0, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  // One row of the map: the picture repeated along the lane with a small gap, its foot at
  // `base`. haze (0..1) fades it toward the sky's color, more for the rows farther back. False until it has loaded.
  const strips = {};
  function strip(id, off, base, scale, haze) {
    const im = sprite(id);
    if (!im) return false;
    let c = strips[id];
    if (!c) {
      c = strips[id] = document.createElement('canvas');
      c.width = Math.round(im.width * scale); c.height = Math.round(im.height * scale);
      const cx = c.getContext('2d');
      cx.drawImage(im, 0, 0, c.width, c.height);
      cx.globalCompositeOperation = 'source-atop';
      cx.fillStyle = `rgba(196,226,238,${haze})`;
      cx.fillRect(0, 0, c.width, c.height);
    }
    const step = c.width + 40;
    for (let i = Math.floor(off / step); i * step - off < W; i++) ctx.drawImage(c, Math.round(i * step - off), base - c.height);
    return true;
  }

  // Plain trees along a bank, for when there are no map pictures.
  function pines(off, y, k, color) {
    ctx.fillStyle = color;
    for (let i = -1; i < W / 80 + 2; i++) {
      const x = i * 80 - (off % 80), n = Math.floor((off + i * 80) / 80), h = (40 + ((n * 37) % 30)) * k;
      ctx.beginPath(); ctx.moveTo(x, y + 6); ctx.lineTo(x + 22 * k, y + 6 - h); ctx.lineTo(x + 44 * k, y + 6); ctx.fill();
    }
  }

  // ---------- drawing: units ----------
  // A unit is its portrait in a round frame: it bobs while walking, lunges when it attacks and flashes when hit.
  function token(art, cx, cy, d, ringColor, o = {}) {
    const image = art ? img(`art/${art}.webp`) : null;
    ctx.save();
    ctx.translate(cx, cy);
    if (o.flip) ctx.scale(-1, 1);
    if (o.wings) {
      const flap = Math.sin(clock * 16 + (o.seed || 0)) * 0.5;
      ctx.fillStyle = ringColor;
      for (const s of [-1, 1]) {
        ctx.save();
        ctx.scale(s, 1);
        ctx.rotate(-0.3 + flap);
        ctx.beginPath(); ctx.ellipse(d * 0.62, -d * 0.1, d * 0.42, d * 0.16, -0.4, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }
    ctx.beginPath(); ctx.arc(0, 0, d / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#2a2d40'; ctx.fill();
    if (image) {
      ctx.save();
      ctx.clip();
      ctx.drawImage(image, -d / 2, -d / 2, d, d);
      ctx.restore();
    } else if (o.fallback) o.fallback(d);
    ctx.lineWidth = Math.max(3, d * 0.08);
    ctx.strokeStyle = ringColor;
    ctx.beginPath(); ctx.arc(0, 0, d / 2, 0, Math.PI * 2); ctx.stroke();
    if (o.flash) { ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath(); ctx.arc(0, 0, d / 2, 0, Math.PI * 2); ctx.fill(); }
    if (o.tint) { ctx.fillStyle = o.tint; ctx.beginPath(); ctx.arc(0, 0, d / 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  // Draws a frame image stretched over a box, keeping its corners (c: corner size in the image, b: on screen).
  function nineSlice(im, x, y, w, h, c, b) {
    const sw = im.naturalWidth, sh = im.naturalHeight;
    const sx = [0, c, sw - c], sy = [0, c, sh - c], sW = [c, sw - 2 * c, c], sH = [c, sh - 2 * c, c];
    const dx = [x, x + b, x + w - b], dy = [y, y + b, y + h - b], dW = [b, w - 2 * b, b], dH = [b, h - 2 * b, b];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i !== 1 || j !== 1) ctx.drawImage(im, sx[i], sy[j], sW[i], sH[j], dx[i], dy[j], dW[i], dH[j]);
      }
    }
  }

  // A leader: its portrait in its family's card frame.
  function leaderToken(l, cx, cy, s, o = {}) {
    const art = img(`art/${l.id}.webp`), frame = img(`ui/frame-${l.family.toLowerCase()}.webp`);
    const h = s / 2, b = s * 0.17, inset = b * 0.4;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath(); ctx.roundRect(-h + inset, -h + inset, s - inset * 2, s - inset * 2, s * 0.12);
    ctx.fillStyle = '#1a1e38'; ctx.fill();
    if (art) { ctx.save(); ctx.clip(); ctx.drawImage(art, -h + inset, -h + inset, s - inset * 2, s - inset * 2); ctx.restore(); }
    if (frame) nineSlice(frame, -h, -h, s, s, 48, b);
    else { ctx.lineWidth = b * 0.6; ctx.strokeStyle = FAMILY[l.family]; ctx.stroke(); }
    if (o.tint) { ctx.fillStyle = o.tint; ctx.beginPath(); ctx.roundRect(-h, -h, s, s, s * 0.14); ctx.fill(); }
    ctx.restore();
  }

  function shadow(cx, d, airborne) {
    ctx.fillStyle = `rgba(0,0,0,${airborne ? 0.12 : 0.22})`;
    ctx.beginPath(); ctx.ellipse(cx, GROUND + 2, d * 0.42, d * 0.1, 0, 0, Math.PI * 2); ctx.fill();
  }

  const scarab = (d) => {
    ctx.fillStyle = '#4a3b6b'; ctx.beginPath(); ctx.ellipse(0, 2, d * 0.32, d * 0.24, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#7fe08a'; ctx.fillRect(d * 0.12, -d * 0.08, 3, 3);
  };

  function drawLeader(p) {
    const r = run, l = r.leader, d = 64;
    const cx = p.x + p.w / 2 + (p.lunge > 0 ? 8 : 0);
    const walking = !r.stalled;
    const cy = p.y - 34 - (walking ? Math.abs(Math.sin(r.time * 10)) * 4 : 0) - (l.role === 'flying' ? 10 : 0);
    shadow(cx, d, false);
    ctx.save();
    const k = r.unhurtKind;
    if (k === 'burrow') { ctx.globalAlpha = 0.25; }
    if (k === 'stealth') { ctx.globalAlpha = 0.35; }
    if (p.inv > 0 && !k && Math.floor(r.time * 12) % 2) ctx.globalAlpha = 0.4;
    const pose = p.deploy > 0 ? { anim: 'deploy', p: 1 - p.deploy / Math.min(DEPLOY_MAX, clip(l.id, 'deploy')) }
      : p.lunge > 0 ? { ...attackPose(p), anim: p.act || 'attack' } : { anim: r.stalled ? 'idle' : 'move', t: r.time };
    if (drawSprite(l.id, p.x + p.w / 2, p.y - (l.role === 'flying' ? 14 : 0), dims(l.id, 66).tall, pose)) {
      // drawn
    } else leaderToken(l, cx, cy, d);
    ctx.restore();
    if (k === 'shield') {
      ctx.strokeStyle = 'rgba(255, 236, 150, 0.9)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, cy, d * 0.68, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawMini(m) {
    const d = m.def;
    const cx = m.x + m.w / 2 + (m.lunge > 0 ? 6 : 0);
    const bob = Math.abs(Math.sin(m.t * 9)) * 3;
    const cy = m.y - m.h / 2 - bob;
    shadow(cx, m.w * 1.3, m.air);
    const art = d.art === undefined ? m.id : d.art || m.id;
    // it drops in from above while it deploys
    const drop = m.deploy > 0 ? (m.deploy / Math.min(DEPLOY_MAX, clip(art, 'deploy'))) ** 2 * 80 : 0;
    if (drawSprite(art, m.x + m.w / 2, m.y + (m.air ? 10 : 0) - (m.air ? Math.sin(m.t * 5) * 4 : 0) - drop, m.tall,
      { ...(m.deploy > 0 ? { anim: 'deploy', p: 1 - m.deploy / Math.min(DEPLOY_MAX, clip(art, 'deploy')) }
        : m.lunge > 0 ? attackPose(m)
        : m.cast > 0 ? { anim: 'cast', p: 1 - m.cast / Math.min(CAST_MAX, clip(art, 'cast')) }
        : { anim: m.still ? 'idle' : !m.charged && clip(art, 'charge') ? 'charge' : 'move', t: m.t }),
        tint: m.flash > 0 ? HIT_TINT : null })) {
      // drawn
    } else {
      token(d.art === undefined ? m.id : d.art, cx, cy, d.size, FAMILY[d.family], { flash: m.flash > 0, wings: m.air,
        seed: m.t, fallback: m.id === 'scarab' ? scarab : null });
    }
    hearts(m, m.x + m.w / 2, m.y + (m.air ? 10 : 0) - m.tall - 14);
    // a seed or bark on it, above its hearts
    if (m.seed) icon('SeedsofProtection', m.x + m.w / 2 - 7, m.y + (m.air ? 10 : 0) - m.tall - 30, 14);
    else if (m.bark > 0 || m.safe > 0) icon(m.safe > 0 ? 'Stealth' : 'Armored', m.x + m.w / 2 - 7, m.y + (m.air ? 10 : 0) - m.tall - 30, 14);
  }

  function drawEnemy(e) {
    if (e.type === 'tower') { drawTower(e); return; }
    const d = ENEMIES[e.type];
    const cx = e.x + e.w / 2 - (e.lunge > 0 ? 6 : 0);
    const moving = e.hold <= 0 && d.walk > 0;
    const cy = e.y - e.h / 2 - (moving ? Math.abs(Math.sin(e.t * 9)) * 3 : 0);
    shadow(cx, e.w * 1.3, e.air);
    const tint = e.holdKind === 'frost' ? 'rgba(170,220,255,0.45)' : e.holdKind === 'root' ? 'rgba(90,160,60,0.35)'
      : e.holdKind === 'sleep' ? 'rgba(120,90,200,0.35)' : e.holdKind === 'stun' ? 'rgba(255,230,120,0.35)' : e.burn > 0 ? 'rgba(255,120,40,0.25)' : null;
    if (!drawSprite(e.type, e.x + e.w / 2, e.y + (e.air ? 10 : 0), e.tall,
      { ...(e.lunge > 0 ? attackPose(e) : { anim: moving ? 'move' : 'idle', t: e.t }),
        flip: true, tint: e.flash > 0 ? HIT_TINT : tint })) {
      token(e.type, cx, cy, d.size, '#d63a3a', { flip: true, flash: e.flash > 0, wings: e.air, seed: e.t, tint });
    }
    if (e.holdKind === 'sleep') text('z', cx + d.size * 0.4, cy - d.size * 0.4, 16, '#fff', 'center', 800);
    hearts(e, e.x + e.w / 2, e.y + (e.air ? 10 : 0) - e.tall - 14);
  }

  function drawTower(e) {
    const { x, y, w, h } = e;
    // the light that grows where its shot will come from (a dragon tower's low down, the others' at gy)
    const glow = (gy) => {
      if (e.windup <= 0) return;
      const k = 1 - e.windup / 0.6;
      ctx.fillStyle = e.kind === 'dragon' || e.kind === 'rocket' ? '#ff8a2b' : '#fff4c0';
      ctx.globalAlpha = 0.5 + k * 0.5;
      ctx.beginPath(); ctx.arc(x - 4, e.kind === 'dragon' ? y - 14 : gy, 4 + k * 10, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    };
    if (drawSprite(`tower-${e.kind === 'plain' ? 'guard' : e.kind}`, x + w / 2, y + 4, h + 60, { flip: true, tint: e.flash > 0 ? HIT_TINT : null })) {
      glow(y - h - 20);
      hearts(e, x + w / 2, y - h - 78);
      return;
    }
    const tone = { dragon: '#a0574a', rocket: '#6f7a86', guard: '#566f9e', plain: '#8a8476' }[e.kind];
    ctx.save();
    if (e.flash > 0) ctx.globalAlpha = 0.7;
    ctx.fillStyle = '#6f6a5f'; ctx.fillRect(x - 6, y - 16, w + 12, 16);
    ctx.fillStyle = tone; ctx.fillRect(x, y - h + 30, w, h - 46);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) ctx.fillRect(x + 6 + c * 26 + (r % 2) * 10, y - 30 - r * 22, 18, 3);
    ctx.fillStyle = '#4a4540';
    for (let i = 0; i < 4; i++) ctx.fillRect(x - 4 + i * 25, y - h + 18, 16, 14);
    ctx.fillRect(x - 4, y - h + 28, w + 8, 6);
    ctx.fillStyle = '#222'; ctx.beginPath(); ctx.roundRect(x + w / 2 - 10, y - h + 52, 20, 28, [10, 10, 0, 0]); ctx.fill();
    ctx.restore();
    const crest = { dragon: 'PvPCard_Tex_Tower_Dragon', rocket: 'PvPCard_Tex_Tower_Rocket', guard: 'PvPCard_Tex_Tower_Guard' }[e.kind];
    const image = crest ? img(`pvp/${crest}.webp`) : null;
    if (image) ctx.drawImage(image, x + w / 2 - 34, y - h - 58, 68, 68);
    else { ctx.fillStyle = '#6b4a2b'; ctx.fillRect(x + w / 2, y - h - 14, 3, 32); ctx.fillStyle = '#c44'; ctx.fillRect(x + w / 2 + 3, y - h - 14, 18, 11); }
    glow(y - 40);
    hearts(e, x + w / 2, y - h - 74);
  }

  // A projectile sprite with its point at (x, y), turned to angle a; false while there is no sprite.
  function drawMissile(id, x, y, a, len, centered) {
    const im = sprite(id);
    if (!im) return false;
    const k = len / im.width;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.drawImage(im, centered ? -len / 2 : -len, -im.height * k / 2, len, im.height * k);
    ctx.restore();
    return true;
  }
  function drawBolt(b) {
    const o = b.shot;
    if (o.art && drawMissile(o.art, b.x, b.y, o.spin ? b.t * 16 : b.a, o.len, o.spin)) return;
    const size = o.size || 6, cos = Math.cos(b.a), sin = Math.sin(b.a);
    ctx.strokeStyle = o.color || '#f3e7c4'; ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.globalAlpha = 0.45;
    ctx.beginPath(); ctx.moveTo(b.x - cos * size * 3, b.y - sin * size * 3); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.globalAlpha = 1; ctx.lineCap = 'butt';
    ctx.fillStyle = o.color || '#f3e7c4'; ctx.beginPath(); ctx.arc(b.x, b.y, size, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.arc(b.x, b.y, size * 0.45, 0, Math.PI * 2); ctx.fill();
  }

  function drawShot(s) {
    const r = run;
    if (s.art && drawMissile(s.art, s.x, s.y - s.h / 2, Math.PI, 64)) return;
    if (s.kind === 'bolt') {
      ctx.fillStyle = '#3a2a1a'; ctx.fillRect(s.x, s.y - s.h, s.w, 3);
      ctx.fillStyle = '#ddd'; ctx.fillRect(s.x - 4, s.y - s.h - 1, 5, 5);
    } else if (s.kind === 'fire') {
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = i % 2 ? '#ffb347' : '#ff5a1f';
        const f = Math.sin(r.time * 30 + i) * 4;
        ctx.beginPath(); ctx.ellipse(s.x + 8 + i * 12, s.y - 10, 10, 13 + f, 0, 0, Math.PI * 2); ctx.fill();
      }
    } else if (s.kind === 'rocket') {
      const k = 1 - s.t / s.max;
      ctx.fillStyle = `rgba(0,0,0,${0.15 + k * 0.3})`;
      ctx.beginPath(); ctx.ellipse(s.x, GROUND + 2, 14 + k * 30, 5 + k * 4, 0, 0, Math.PI * 2); ctx.fill();
      const rx = lerp(s.fromX, s.x, k), ry = lerp(GROUND - 180, GROUND, k) - Math.sin(k * Math.PI) * 140;
      ctx.fillStyle = '#c9ced6'; ctx.beginPath(); ctx.ellipse(rx, ry, 10, 5, k * 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff9a3c'; ctx.beginPath(); ctx.arc(rx + 8, ry - 4, 4, 0, Math.PI * 2); ctx.fill();
    }
  }

  // A unit's hearts in a row above it, the last one part full when it has taken less than a whole hit. Units with a
  // single heart show none: any hit takes them out.
  function hearts(u, cx, y) {
    if (u.max <= 1) return;
    const n = Math.ceil(u.max), s = n > 6 ? 9 : 12, gap = s + 2;
    for (let i = 0; i < n; i++) heart(cx - ((n - 1) * gap) / 2 + i * gap, y, s, clamp(u.hp - i, 0, 1));
  }

  // ---------- drawing: cards and HUD ----------
  // A card in the game's faction frame (frame art 279x406; its window starts about 9% in).
  function card(id, x, y, w, cost, o = {}) {
    const def = cardDef(id), h = w * 406 / 279;
    const frame = img(`ui/frame-${def.family.toLowerCase()}.webp`);
    const art = (def.icon && img(def.icon, '')) || img(`art/${def.art || id}.webp`);
    ctx.save();
    if (o.dim) ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#1a1e38';
    ctx.beginPath(); ctx.roundRect(x + w * 0.06, y + h * 0.06, w * 0.88, h * 0.88, w * 0.1); ctx.fill();
    if (art) {
      ctx.save();
      ctx.beginPath(); ctx.roundRect(x + w * 0.08, y + h * 0.075, w * 0.84, h * 0.86, w * 0.1); ctx.clip();
      const fit = w * 0.84 / Math.max(art.naturalWidth, art.naturalHeight), aw = art.naturalWidth * fit, ah = art.naturalHeight * fit;
      ctx.drawImage(art, x + w / 2 - aw / 2, y + h * 0.075 + (w * 0.84 - ah) / 2, aw, ah);
      const g = ctx.createLinearGradient(0, y + h * 0.5, 0, y + h);
      g.addColorStop(0, 'rgba(16,18,36,0)'); g.addColorStop(0.35, 'rgba(16,18,36,0.95)');
      ctx.fillStyle = g; ctx.fillRect(x, y + h * 0.5, w, h * 0.5);
      ctx.restore();
    }
    if (frame) ctx.drawImage(frame, x, y, w, h);
    else { ctx.strokeStyle = FAMILY[def.family]; ctx.lineWidth = 4; ctx.beginPath(); ctx.roundRect(x + 2, y + 2, w - 4, h - 4, 8); ctx.stroke(); }
    ctx.restore();
    if (o.dim) ctx.globalAlpha = 0.6;
    coin(x + w * 0.2, y + w * 0.2, Math.max(9, w * 0.13), cost);
    const size = clamp(w * 0.12, 9, 14);
    wrapCenter(def.name, x + w / 2, y + h * 0.74, w * 0.8, size, '#fff');
    ctx.globalAlpha = 1;
    icon(KIND_ICON[def.kind], x + w * 0.1, y + h - h * 0.19, w * 0.17); // what kind of card it is
    if (o.key) text(o.key, x + w - w * 0.16, y + h - h * 0.08, 11, '#ccc', 'center');
    if (o.check) {
      // in the deck: the game's Squad icon on a dark disc
      ctx.fillStyle = '#2e1b0e'; ctx.beginPath(); ctx.arc(x + w - 13, y + 13, 12, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 2; ctx.stroke();
      if (!icon('Squad', x + w - 22, y + 4, 18)) text('✓', x + w - 13, y + 18, 14, '#f2c14e', 'center', 800);
    }
    return h;
  }

  const CARD_W = 82;
  const cardRect = (i) => ({ x: 350 + i * 94, y: 478, w: CARD_W, h: CARD_W * 406 / 279 });

  // A heart with its point at the bottom; full is how much of it is red, 0 to 1, filled from the left.
  function heart(x, y, s, full) {
    const shape = () => {
      ctx.beginPath();
      ctx.moveTo(x, y + s * 0.35);
      ctx.bezierCurveTo(x, y, x - s * 0.5, y, x - s * 0.5, y + s * 0.35);
      ctx.bezierCurveTo(x - s * 0.5, y + s * 0.65, x, y + s * 0.8, x, y + s);
      ctx.bezierCurveTo(x, y + s * 0.8, x + s * 0.5, y + s * 0.65, x + s * 0.5, y + s * 0.35);
      ctx.bezierCurveTo(x + s * 0.5, y, x, y, x, y + s * 0.35);
    };
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    shape(); ctx.fill();
    const f = clamp(Number(full), 0, 1);
    if (f <= 0) return;
    ctx.save();
    shape(); ctx.clip();
    ctx.fillStyle = '#e8414d';
    ctx.fillRect(x - s * 0.5, y, s * f, s);
    ctx.restore();
  }

  // A Gold coin with a number on it: the game's coin when it has loaded, a plain disc until then.
  function coin(x, y, r, label) {
    const image = img('currency/coins.png');
    if (image) ctx.drawImage(image, x - r * 1.2, y - r * 1.25, r * 2.4, r * 2.4 * image.naturalHeight / image.naturalWidth);
    else {
      ctx.fillStyle = '#f2c14e'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#9a6b12'; ctx.lineWidth = 2; ctx.stroke();
    }
    if (label != null) {
      ctx.font = font(r * 1.15, 800); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (image) { ctx.strokeStyle = '#5a3a06'; ctx.lineWidth = Math.max(2, r * 0.22); ctx.lineJoin = 'round'; ctx.strokeText(label, x, y + 1); }
      ctx.fillStyle = image ? '#fff' : '#4a3208';
      ctx.fillText(label, x, y + 1);
      ctx.textBaseline = 'alphabetic';
    }
  }

  // One of the game's small white icons (icons/<name> in the tracker's game data) in a box of side s; false until it has loaded.
  function icon(name, x, y, s) {
    const image = img(`icons/${name}${name === 'Leader' ? '.png' : '.webp'}`);
    if (!image) return false;
    const k = s / Math.max(image.naturalWidth, image.naturalHeight);
    ctx.drawImage(image, x + (s - image.naturalWidth * k) / 2, y + (s - image.naturalHeight * k) / 2, image.naturalWidth * k, image.naturalHeight * k);
    return true;
  }
  const KIND_ICON = { melee: 'Melee', ranged: 'Ranged', flying: 'Flying', siege: 'Siege', spell: 'Spell', leader: 'Leader' };

  // A panel of the game's wood, with a dark rim; plain dark until the texture has loaded.
  function panel(x, y, w, h, alpha = 0.55) {
    const wood = img('ui/wood.webp');
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 10);
    if (!wood) { ctx.fillStyle = `rgba(20, 22, 34, ${alpha})`; ctx.fill(); ctx.restore(); return; }
    ctx.clip();
    const tw = 375, th = 184;
    for (let ty = y; ty < y + h; ty += th) for (let tx = x - (x % tw); tx < x + w; tx += tw) ctx.drawImage(wood, tx, ty, tw, th);
    ctx.fillStyle = `rgba(24, 14, 8, ${0.25 + alpha * 0.45})`;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    ctx.lineWidth = 3; ctx.strokeStyle = '#2e1b0e';
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255, 214, 150, 0.35)';
    ctx.beginPath(); ctx.roundRect(x + 2.5, y + 2.5, w - 5, h - 5, 8); ctx.stroke();
  }
  // Behind the menus: the lane itself, drifting by, darker toward the edges so the panels stand out.
  function backdrop(dim) {
    drawScenery(clock * 22);
    ctx.fillStyle = `rgba(14,22,38,${dim * 0.45})`; ctx.fillRect(0, 0, W, H);
    const edge = ctx.createRadialGradient(W / 2, H * 0.42, H * 0.3, W / 2, H * 0.42, W * 0.72);
    edge.addColorStop(0, 'rgba(10,16,30,0)'); edge.addColorStop(1, `rgba(10,16,30,${Math.min(0.9, dim + 0.2)})`);
    ctx.fillStyle = edge; ctx.fillRect(0, 0, W, H);
  }

  function text(s, x, y, size, color = '#fff', align = 'left', weight = 600) {
    ctx.font = font(size, weight); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, x, y);
  }

  function wrapLines(s, w, size, weight) {
    ctx.font = font(size, weight);
    const lines = [];
    let line = '';
    for (const word of s.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > w && line) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
  function wrap(s, x, y, w, size, color, weight = 500) {
    const lines = wrapLines(s, w, size, weight);
    lines.forEach((l, i) => text(l, x, y + i * (size + 4), size, color, 'left', weight));
    return lines.length * (size + 4);
  }
  function wrapCenter(s, x, y, w, size, color) {
    const lines = wrapLines(s, w, size, 700);
    lines.forEach((l, i) => text(l, x, y + i * (size + 2), size, color, 'center', 700));
  }

  function modIcon(m, x, y, s) {
    const image = m.icon ? img(m.icon) : null;
    if (image) ctx.drawImage(image, x, y, s, s);
    else { ctx.fillStyle = '#555'; ctx.beginPath(); ctx.roundRect(x, y, s, s, 4); ctx.fill(); }
  }

  function drawHud() {
    const r = run, p = r.p, l = r.leader;
    panel(12, 10, 336, 48);
    // the leader's portrait in the game's round frame (the frame's middle is filled, so the portrait goes on top)
    const face = img(`art/${l.id}.webp`), rim = img('pvp/PVPPortraitFrame_Default.webp');
    if (rim) ctx.drawImage(rim, 299, 10, 46, 46 * rim.naturalHeight / rim.naturalWidth);
    if (face) {
      ctx.save();
      ctx.beginPath(); ctx.arc(322, 35, 14, 0, Math.PI * 2); ctx.clip();
      const k = 30 / Math.min(face.naturalWidth, face.naturalHeight);
      ctx.drawImage(face, 322 - face.naturalWidth * k / 2, 20, face.naturalWidth * k, face.naturalHeight * k);
      ctx.restore();
    }
    for (let i = 0; i < 3; i++) heart(36 + i * 30, 22, 24, p.hp - i);
    text(`${fmt(r.traveled / M)} m`, 132, 33, 16);
    text(`Score ${fmt(r.score)}`, 132, 50, 13, '#ffe28a');
    ctx.font = font(12); ctx.fillStyle = '#ddd'; ctx.textAlign = 'left';
    ctx.fillText(l.name, 220, 33, 74); // squeezed to fit before the portrait
    // your minis on the battlefield: one chip for each kind, with how many
    const kinds = new Map();
    for (const m of r.minis) if (m.hp > 0) kinds.set(m.id, { def: m.def, n: (kinds.get(m.id)?.n || 0) + 1 });
    let kx = 12;
    for (const [id, { def, n }] of kinds) {
      panel(kx, 64, 62, 32, 0.6);
      const own = def.art === undefined ? id : def.art;
      const face = (def.face || (own ? [own] : [])).map((f) => (f.includes('/') ? img(`${f}.webp`, '') : img(`art/${f}.webp`))).find(Boolean);
      ctx.save();
      ctx.beginPath(); ctx.arc(kx + 17, 80, 12, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = FAMILY[def.family] || '#555'; ctx.fillRect(kx + 5, 68, 24, 24);
      if (face) { const k = 24 / Math.min(face.naturalWidth, face.naturalHeight); ctx.drawImage(face, kx + 17 - face.naturalWidth * k / 2, 68, face.naturalWidth * k, face.naturalHeight * k); }
      ctx.restore();
      text(`×${n}`, kx + 34, 85, 14, '#fff', 'left', 700);
      kx += 66;
    }
    // what is at work for a while, each with its seconds left
    for (const [what, name] of [['haste', 'Bloodlust'], ['frenzy', 'Bloodlust'], ['veil', 'Stealth'], ['totem', 'Tranquility'],
      ['banner', 'Burn'], ['march', 'Squad'], ['unhurt', 'Armored']]) {
      if (!(r[what] > 0)) continue;
      panel(kx, 64, 58, 32, 0.6);
      icon(name, kx + 6, 69, 22);
      text(`${Math.ceil(r[what])}s`, kx + 32, 85, 13, '#ffe9b0', 'left', 700);
      kx += 62;
    }
    // twist chips
    let x = W - 12;
    ctx.font = font(12, 700);
    for (const m of [...today.mods].reverse()) {
      const w = ctx.measureText(m.name).width + 44;
      x -= w;
      panel(x, 10, w, 32, 0.6);
      modIcon(m, x + 4, 12, 28);
      text(m.name, x + 36, 31, 12, '#ffe9b0', 'left', 700);
      x -= 6;
    }
    const bar2 = img('ui/topbar-wood.webp');
    if (bar2) {
      ctx.drawImage(bar2, 0, 476, W, H - 476);
      ctx.fillStyle = 'rgba(24,14,8,0.25)'; ctx.fillRect(0, 476, W, H - 476);
      ctx.fillStyle = '#2e1b0e'; ctx.fillRect(0, 474, W, 4);
    }
    // gold
    panel(12, 490, 322, 96);
    coin(46, 538, 22, r.gold);
    for (let i = 0; i < 10; i++) {
      const gx = 80 + i * 24;
      ctx.fillStyle = i < r.gold ? '#f2c14e' : 'rgba(255,255,255,0.12)';
      ctx.beginPath(); ctx.roundRect(gx, 528, 20, 20, 4); ctx.fill();
      if (i === r.gold && r.gold < 10) {
        const f = r.goldT / goldRate();
        ctx.fillStyle = 'rgba(242,193,78,0.55)';
        ctx.beginPath(); ctx.roundRect(gx, 548 - 20 * f, 20, 20 * f, 4); ctx.fill();
      }
    }
    text('Gold', 80, 516, 12, '#ffe9b0');
    // cards
    for (let i = 0; i < 3; i++) {
      const id = r.hand[i];
      if (!id) continue;
      const rc = cardRect(i), cost = cardCost(i);
      card(id, rc.x, rc.y, rc.w, cost, { dim: r.gold < cost, key: String(i + 1) });
    }
    if (r.queue[0]) {
      text('Next', 670, 494, 11, '#ccc', 'center');
      card(r.queue[0], 640, 500, 60, cardDef(r.queue[0]).cost, { dim: true });
    }
  }

  // ---------- drawing: screens ----------
  function drawPlay() {
    const r = run;
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - 0.5) * 30 * shake, (Math.random() - 0.5) * 30 * shake);
    drawScenery(r.bg);
    for (const st of r.stones) {
      if (drawSprite('meeting-stone', st.x + st.w / 2, st.y + 4, 70)) continue; // the game's Meeting Stone
      ctx.fillStyle = '#8a93a6'; ctx.beginPath(); ctx.roundRect(st.x, st.y - st.h, st.w, st.h, 8); ctx.fill();
      ctx.fillStyle = '#a7d4ff'; ctx.fillRect(st.x + 15, st.y - st.h + 8, 10, 14);
    }
    for (const e of r.enemies) if (e.type === 'tower') drawEnemy(e);
    for (const c of r.corpses) {
      const gone = 1 - c.life / c.max;
      if (drawSprite(c.art || 'scarab', c.x + c.w / 2, c.y + (c.air ? 10 + gone * 40 : 0), c.tall,
        c.fall ? { anim: 'death', p: gone, flip: c.enemy, alpha: Math.min(1, (1 - gone) * 4) }
          : { flip: c.enemy, lean: -1.4 * gone, alpha: 1 - gone * gone })) continue;
      ctx.globalAlpha = clamp(c.life / c.max, 0, 1);
      const d = c.tall * 0.7 * (0.6 + 0.4 * c.life / c.max);
      token(c.art, c.x + c.w / 2, c.y - c.h / 2 + (1 - c.life / c.max) * 10, d, c.enemy ? '#d63a3a' : FAMILY[c.family],
        { flip: c.enemy, tint: 'rgba(0,0,0,0.35)', fallback: c.art ? null : scarab });
      ctx.globalAlpha = 1;
    }
    for (const m of r.minis) if (!m.air) drawMini(m);
    for (const e of r.enemies) if (e.type !== 'tower' && !e.air) drawEnemy(e);
    drawLeader(r.p);
    for (const m of r.minis) if (m.air) drawMini(m);
    for (const e of r.enemies) if (e.air) drawEnemy(e);
    for (const s of r.shots) drawShot(s);
    for (const b of r.bolts) drawBolt(b);
    for (const f of r.fx) {
      ctx.globalAlpha = clamp(f.life / f.max, 0, 1);
      if (f.line) {
        ctx.strokeStyle = f.color; ctx.lineWidth = f.width || 2;
        ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.x2, f.y2); ctx.stroke();
      } else {
        ctx.fillStyle = f.color; ctx.fillRect(f.x - f.size / 2, f.y - f.size / 2, f.size, f.size);
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'screen';
    for (const b of r.bursts) {
      const sh = effects[b.key], im = sprite(`fx-${b.key}`);
      if (!im) continue;
      const f = Math.min(sh.frames - 1, Math.floor(b.t / sh.seconds * sh.frames)), [cw, ch] = sh.cell;
      const k = Math.min(UNIT_PX / sh.unit * b.size * (FX_SIZE[b.key] || 1), FX_MAX / cw);
      const x = b.on ? b.on.x + b.on.w / 2 : b.x, y = b.on ? b.on.y - (FX_AT_FEET.has(b.key) ? 0 : b.on.h / 2) : b.y;
      ctx.globalAlpha = FX_ALPHA[b.key] || 1;
      ctx.drawImage(im, (f % sh.cols) * cw, Math.floor(f / sh.cols) * ch, cw, ch, x - sh.at[0] * k, y - sh.at[1] * k, cw * k, ch * k);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    for (const t of r.texts) {
      ctx.globalAlpha = clamp(t.life, 0, 1);
      text(t.text, t.x, t.y, 14, t.color, 'center', 700);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    drawHud();
    if (r.time < 4) {
      ctx.globalAlpha = clamp(4 - r.time, 0, 1);
      panel(W / 2 - 280, 110, 560, 64);
      text('Play cards with 1 2 3, or click them', W / 2, 136, 15, '#fff', 'center');
      text('Your minis fight for you: keep some between you and the enemy.', W / 2, 160, 12, '#ccc', 'center', 500);
      ctx.globalAlpha = 1;
    }
  }

  // menu layout
  // two rows of twelve; the hidden one stands apart, above them
  const leaderRect = (i) => (i < 24 ? { x: 40 + (i % 12) * 66, y: 96 + Math.floor(i / 12) * 66, w: 60, h: 60 } : { x: 772, y: 30, w: 52, h: 52 });
  const talentRect = (i) => ({ x: 166 + i * 218, y: 300, w: 210, h: 34 });
  const deckRect = (i) => ({ x: 40 + i * 88, y: 400, w: 80 });
  const editBtn = { x: 672, y: 440, w: 152, h: 46 };
  const runBtn = { x: 860, y: 470, w: 380, h: 64 };

  function button(b, label, primary, enabled = true) {
    ctx.save();
    ctx.globalAlpha = enabled ? 1 : 0.45;
    const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
    if (primary) { g.addColorStop(0, '#ffd866'); g.addColorStop(1, '#e89a1f'); } else { g.addColorStop(0, '#6a4526'); g.addColorStop(1, '#49301a'); }
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 10); ctx.fill();
    ctx.strokeStyle = primary ? '#8a4f0c' : '#2e1b0e'; ctx.lineWidth = 3; ctx.stroke();
    text(label, b.x + b.w / 2, b.y + b.h / 2 + 7, primary ? 22 : 16, primary ? '#3a2208' : '#f3ead6', 'center', 800);
    ctx.restore();
  }

  function drawMenu() {
    backdrop(0.55);
    text('rdmodule', 40, 66, 40, '#ffe28a', 'left', 800);
    const rule = img('ui/divider.webp');
    if (rule) ctx.drawImage(rule, 40, 76, 700, 10);
    text('Run the lane. Spend Gold on minis. Beat today’s twist.', 310, 62, 16, '#fff', 'left', 500);
    // leaders
    LEADERS.slice(0, leaderCount()).forEach((l, i) => {
      const rc = leaderRect(i), sel = i === pick;
      leaderToken(l, rc.x + rc.w / 2, rc.y + rc.h / 2, rc.w - 4);
      if (sel) { ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 3; ctx.beginPath(); ctx.roundRect(rc.x - 3, rc.y - 3, rc.w + 6, rc.h + 6, 10); ctx.stroke(); }
    });
    // chosen leader
    const l = LEADERS[pick];
    panel(40, 236, 784, 142, 0.75);
    leaderToken(l, 100, 300, 96);
    text(l.name, 166, 266, 22, '#fff', 'left', 800);
    const fx = 166 + ctx.measureText(l.name).width + 14;
    text(l.family, fx + (icon(l.family, fx, 253, 16) ? 20 : 0), 266, 13, FAMILY[l.family], 'left', 700);
    text(`Passive · ${l.passive}`, 166, 288, 14, '#ffe9b0', 'left', 700);
    // the passive's text beside its name, in the largest size that fits the panel
    const px = 166 + ctx.measureText(`Passive · ${l.passive}`).width + 12;
    let size = 12;
    while (size > 9 && (ctx.font = font(size, 500), ctx.measureText(l.passiveText).width) > 812 - px) size -= 0.5;
    text(l.passiveText, px, 288, size, '#ddd', 'left', 500);
    // its three talents: the picked one is the leader's card
    const now = talentOf(l);
    TALENTS[l.id].forEach(([name, icon], i) => {
      const rc = talentRect(i), image = img(`${icon.includes('/') ? icon : `talents/${icon}`}.webp`);
      panel(rc.x, rc.y, rc.w, rc.h, i === now ? 0.95 : 0.45);
      if (i === now) { ctx.strokeStyle = '#f2c14e'; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(rc.x, rc.y, rc.w, rc.h, 10); ctx.stroke(); }
      if (image) ctx.drawImage(image, rc.x + 4, rc.y + 3, rc.h - 6, rc.h - 6);
      text(name, rc.x + rc.h + 2, rc.y + 21, 13, i === now ? '#fff' : '#bbb', 'left', 700);
    });
    const t = TALENTS[l.id][now];
    wrap(`Card, ${t[2]} Gold · ${t[3]}`, 166, 352, 646, 12, '#ddd');
    // deck
    text('Your deck', 40, 394, 15, '#fff', 'left', 700);
    [...deck, LEADER_CARD].forEach((id, i) => { const rc = deckRect(i); card(id, rc.x, rc.y, rc.w, cardDef(id).cost); });
    button(editBtn, 'Edit deck', false);
    // today
    panel(860, 96, 380, 244, 0.75);
    text(`Today’s twist · ${dayKey()} (UTC)`, 878, 122, 14, '#ffe9b0', 'left', 700);
    if (today.state === 'loading') text('Loading today’s PvP modifiers…', 878, 154, 14, '#ddd', 'left', 500);
    else if (today.state === 'failed') wrap('Couldn’t load today’s PvP modifiers, so this is a plain run.', 878, 154, 340, 14, '#ddd');
    else {
      let y = 138;
      for (const m of today.mods) {
        modIcon(m, 878, y, 48);
        text(m.name, 936, y + 18, 14, '#fff', 'left', 700);
        wrap(m.text, 936, y + 36, 290, 12, '#ddd');
        y += 66;
      }
    }
    panel(860, 350, 380, 104, 0.75);
    text(l.name, 878, 376, 14, '#fff', 'left', 700);
    text(`Best today  ${fmt(bestToday(l.id))}`, 878, 404, 15, '#fff', 'left', 600);
    text(`Best ever  ${fmt(best[l.id] || 0)}`, 878, 432, 15, '#bbb', 'left', 600);
    button(runBtn, 'Run  (Enter)', true);
    text(`Pick a leader (← →) and one of its talents (1 2 3). Same course for everyone today; scores stay on this PC. S: sound ${muted ? 'off' : 'on'}.`, 40, 580, 13, '#ccc', 'left', 500);
  }

  // deck editor layout
  const poolRect = (i) => ({ x: 56 + (i % 8) * 150, y: 62 + Math.floor(i / 8) * 208, w: 110 });
  const slotRect = (i) => ({ x: 40 + i * 86, y: 492, w: 70 });
  const doneBtn = { x: 1040, y: 520, w: 200, h: 52 };

  function drawDeck() {
    backdrop(0.78);
    text('Edit deck', 40, 48, 28, '#ffe28a', 'left', 800);
    text(`Pick 6 of these 15 minis. ${draft.length} of 6 picked.`, 200, 46, 15, '#fff', 'left', 500);
    POOL.forEach((id, i) => {
      const rc = poolRect(i), def = MINIS[id], inDeck = draft.includes(id);
      const h = card(id, rc.x, rc.y, rc.w, def.cost, { check: inDeck, dim: !inDeck && draft.length >= 6 });
      text(`${def.family} · ${def.kind[0].toUpperCase()}${def.kind.slice(1)}`, rc.x + rc.w / 2, rc.y + h + 13, 11, FAMILY[def.family], 'center', 700);
      wrapLines(def.text, 144, 10, 500).forEach((s, n) => text(s, rc.x + rc.w / 2, rc.y + h + 27 + n * 13, 10, '#ccc', 'center', 500));
    });
    for (let i = 0; i < 6; i++) {
      const rc = slotRect(i), id = draft[i];
      if (id) card(id, rc.x, rc.y, rc.w, MINIS[id].cost);
      else { ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.roundRect(rc.x, rc.y, rc.w, rc.w * 406 / 279, 8); ctx.stroke(); ctx.setLineDash([]); }
    }
    text('Click a mini to add or remove it.', 580, 532, 13, '#ccc', 'left', 500);
    if (note && note.until > clock) text(note.text, 580, 558, 14, '#ffd0d0', 'left', 600);
    button(doneBtn, 'Done', true, draft.length === 6);
  }

  function drawOver() {
    drawPlay();
    const r = run;
    ctx.fillStyle = 'rgba(10,12,20,0.55)'; ctx.fillRect(0, 0, W, H);
    panel(W / 2 - 230, 110, 460, 270, 0.88);
    leaderToken(r.leader, W / 2, 160, 64);
    text('Run over', W / 2, 228, 30, '#ffe28a', 'center', 800);
    text(`Score ${fmt(r.score)}`, W / 2, 264, 22, '#fff', 'center', 700);
    text(`${fmt(r.traveled / M)} m · ${r.kills} kills · ${r.leader.name}`, W / 2, 290, 14, '#ddd', 'center', 500);
    const msg = r.saved?.ever ? 'New best ever!' : r.saved?.today ? 'New best today!' : `Best today ${fmt(bestToday(r.leader.id))}`;
    text(msg, W / 2, 320, 16, r.saved?.ever || r.saved?.today ? '#7fe08a' : '#bbb', 'center', 700);
    text('Enter or click: run again · M: menu', W / 2, 356, 14, '#fff', 'center', 600);
  }

  // The loading screen: it waits for the lists, today's twist, the menu's pictures and its music, then for a key or a
  // click, which browsers want before any music may play. Nothing waits longer than 8 s.
  function loading() {
    const parts = [waiting === 0, today.state !== 'loading', !!sprite('bg-hogger-near'), !!img('ui/wood.webp'),
      !takes['music.menu'] || !!held['music.menu-1']];
    const done = parts.filter(Boolean).length;
    return clock > 8 ? 1 : done / parts.length;
  }
  function drawLoad() {
    const f = loading();
    ctx.fillStyle = '#1b1f2e'; ctx.fillRect(0, 0, W, H);
    text('rdmodule', W / 2, 250, 64, '#ffe28a', 'center', 800);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.roundRect(W / 2 - 180, 300, 360, 12, 6); ctx.fill();
    ctx.fillStyle = '#f2c14e'; ctx.beginPath(); ctx.roundRect(W / 2 - 180, 300, 360 * f, 12, 6); ctx.fill();
    if (f < 1) text('Loading…', W / 2, 350, 16, '#ccc', 'center', 500);
    else { ctx.globalAlpha = 0.6 + Math.sin(clock * 4) * 0.4; text('Press any key or click to start', W / 2, 350, 18, '#fff', 'center', 700); ctx.globalAlpha = 1; }
  }
  function enter() {
    if (loading() < 1) return;
    ready(['music.alliance', 'music.horde']); // behind the menu, for the run to come
    reveal = 0.6;
    sfx('ui.start', 0.4);
    mode = 'menu';
  }

  function drawPause() {
    drawPlay();
    ctx.fillStyle = 'rgba(10,12,20,0.5)'; ctx.fillRect(0, 0, W, H);
    text('Paused', W / 2, H / 2 - 10, 34, '#fff', 'center', 800);
    text('P, Esc or click to go on · M: menu', W / 2, H / 2 + 22, 14, '#ddd', 'center', 500);
  }

  // ---------- input ----------
  function start() {
    store.set('leader', LEADERS[pick].id);
    newRun();
    ready(['spell.arcane-blast', 'spell.chain-lightning', ...Object.keys(takes).filter((k) => /^tower\./.test(k)),
      ...[run.leader.id, ...deck, ...Object.keys(SUMMONS), ...Object.keys(ENEMIES)].flatMap((id) => {
        const art = (MINIS[id] || SUMMONS[id] || {}).art || id;
        return ['ready', 'attack', 'hit', 'death'].map((what) => `${art}.${what}`);
      })]);
    mode = 'play';
    sfx('ui.start', 0.5);
    sfx(`${run.leader.id}.ready`, 0.6);
  }

  function pickTalent(i) { talents[LEADERS[pick].id] = i; store.set('talents', talents); sfx('ui.click'); }
  function openDeck() { draft = [...deck]; note = null; mode = 'deck'; }
  function closeDeck() {
    if (draft.length !== 6) { note = { text: 'A deck needs 6 minis.', until: clock + 2 }; return; }
    deck = [...draft];
    store.set('deck', deck);
    mode = 'menu';
  }
  function toggleDraft(id) {
    if (draft.includes(id)) draft = draft.filter((d) => d !== id);
    else if (draft.length < 6) draft.push(id);
    else note = { text: 'The deck is full: remove a mini first.', until: clock + 2 };
  }

  addEventListener('keydown', (ev) => {
    const k = ev.key;
    if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(k)) ev.preventDefault();
    if (ev.repeat && mode !== 'play') return;
    if (mode === 'load') { enter(); return; }
    if ((k === 's' || k === 'S') && !ev.repeat) { muted = !muted; store.set('muted', muted); return; }
    if (mode === 'menu') {
      if (k.length === 1) typed = (typed + k.toLowerCase()).slice(-SECRET.length);
      if (typed === SECRET && !found) { found = true; store.set('kobold', true); pick = LEADERS.length - 1; }
      if (k === 'ArrowLeft') pick = (pick + leaderCount() - 1) % leaderCount();
      else if (k === 'ArrowRight') pick = (pick + 1) % leaderCount();
      else if ((k === 'ArrowUp' || k === 'ArrowDown') && pick < 24) pick = (pick + 12) % 24;
      else if (k === 'Enter' || k === ' ') start();
      else if ((k === 'd' || k === 'D') && !SECRET.startsWith(typed.slice(-13))) openDeck();
      else if (k >= '1' && k <= '3') pickTalent(Number(k) - 1);
    } else if (mode === 'deck') {
      if (k === 'Enter' || k === 'Escape') closeDeck();
    } else if (mode === 'play') {
      if (k >= '1' && k <= '3' && !ev.repeat) playCard(Number(k) - 1);
      else if (k === 'Tab') dropArcane();
      else if (k === 'p' || k === 'P' || k === 'Escape') mode = 'pause';
    } else if (mode === 'pause') {
      if (k === 'p' || k === 'P' || k === 'Escape' || k === 'Enter') mode = 'play';
      else if (k === 'm' || k === 'M') mode = 'menu';
    } else if (mode === 'over') {
      if (k === 'Enter' || k === ' ') start();
      else if (k === 'm' || k === 'M' || k === 'Escape') mode = 'menu';
    }
  });
  addEventListener('blur', () => { if (mode === 'play') mode = 'pause'; });
  document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'play') mode = 'pause'; });

  function toGame(ev) {
    const rc = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - rc.left) / rc.width) * W, y: ((ev.clientY - rc.top) / rc.height) * H };
  }
  const inRect = (pt, rc) => pt.x >= rc.x && pt.x <= rc.x + rc.w && pt.y >= rc.y && pt.y <= rc.y + (rc.h ?? rc.w * 406 / 279);

  canvas.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    canvas.focus();
    if (mode === 'load') { enter(); return; }
    if (ev.button === 2) { if (mode === 'play') dropArcane(); return; } // a right click puts a charged Arcane Blast away
    const pt = toGame(ev);
    if (mode === 'menu') {
      for (let i = 0; i < leaderCount(); i++) if (inRect(pt, leaderRect(i))) { pick = i; sfx('ui.select'); return; }
      for (let i = 0; i < 3; i++) if (inRect(pt, talentRect(i))) { pickTalent(i); return; }
      if (inRect(pt, editBtn) || deck.some((_, i) => inRect(pt, deckRect(i)))) { openDeck(); return; }
      if (inRect(pt, runBtn)) start();
      return;
    }
    if (mode === 'deck') {
      for (let i = 0; i < POOL.length; i++) if (inRect(pt, poolRect(i))) { toggleDraft(POOL[i]); return; }
      for (let i = 0; i < draft.length; i++) if (inRect(pt, slotRect(i))) { draft.splice(i, 1); return; }
      if (inRect(pt, doneBtn)) closeDeck();
      return;
    }
    if (mode === 'over') { start(); return; }
    if (mode === 'pause') { mode = 'play'; return; }
    for (let i = 0; i < 3; i++) if (inRect(pt, cardRect(i))) { playCard(i); return; }
  });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  // ---------- frame ----------
  function resize() {
    const vw = innerWidth, vh = innerHeight - 20; // room for the line under the canvas
    const s = Math.min(vw / W, vh / H);
    const dpr = devicePixelRatio || 1;
    canvas.style.width = `${Math.floor(W * s)}px`;
    canvas.style.height = `${Math.floor(H * s)}px`;
    canvas.width = Math.round(W * s * dpr);
    canvas.height = Math.round(H * s * dpr);
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
  }
  addEventListener('resize', resize);
  resize();
  canvas.tabIndex = 0;

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    clock += dt;
    shake = Math.max(0, shake - dt);
    if (mode === 'play') update(dt);
    // the menu's music on the menu and in the deck builder, the battle music in a run, silence once it is over
    const horde = run && ['Horde', 'Blackrock', 'Beast', 'Undead'].includes(run.leader.family);
    playMusic(mode === 'menu' || mode === 'deck' ? 'music.menu' : mode === 'over' || mode === 'load' ? null : horde ? 'music.horde' : 'music.alliance');
    fadeMusic(dt, mode === 'pause');
    if (mode === 'load') drawLoad();
    else if (mode === 'menu') drawMenu();
    else if (mode === 'deck') drawDeck();
    else if (mode === 'play') drawPlay();
    else if (mode === 'pause') drawPause();
    else drawOver();
    if (reveal > 0) { // the menu comes up out of the loading screen's dark
      reveal -= dt;
      ctx.fillStyle = `rgba(27,31,46,${clamp(reveal / 0.6, 0, 1)})`; ctx.fillRect(0, 0, W, H);
    }
    requestAnimationFrame(frame);
  }
  loadToday();
  requestAnimationFrame(frame);
})();
