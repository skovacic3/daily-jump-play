'use strict';

// ============================================================
// Grid + view.  The whole level is one screen: no camera, ever.
// ============================================================
const TILE = 30;
const COLS = 32;
const ROWS = 18;
const VIEW_W = COLS * TILE;      // 960
const VIEW_H = ROWS * TILE;      // 540
const DT = 1 / 120;              // fixed physics step

const CEIL_ROW = 0;
const TOP_ROW = 2;               // row 1 stays empty so the HUD never hides a ledge
const FLOOR_ROW = ROWS - 2;      // 16 — the ground you spawn on
const BEDROCK_ROW = ROWS - 1;    // 17 — under the floor, so pit spikes have something to sit on

const EMPTY = 0;
const SOLID = 1;
const SPIKE_UP = 2;              // tip up, mounted on the tile below
const SPIKE_DOWN = 3;            // tip down, mounted on the tile above
const SPIKE_RIGHT = 4;           // tip right, mounted on the tile to the left
const SPIKE_LEFT = 5;            // tip left, mounted on the tile to the right
const SPIKE_LEN = 14;
const SPRING = 6;                 // solid, and its top launches you: land on it, fly
const ONEWAY = 7;                 // a plank: jump up through it, land on top of it
// On/off blocks: every jump you make swaps which colour is solid.  Red is solid
// while you've jumped an even number of times (so at the start), blue while odd.
const SWITCH_A = 8;
const SWITCH_B = 9;
const isSwitch = (c) => c === SWITCH_A || c === SWITCH_B;
// Conveyor belts: solid, and standing on one carries you along (run against it to
// slow down; jump off it and you keep its speed).  Stored as ':' and ';' (48 + code).
const BELT_L = 10;
const BELT_R = 11;
const isBelt = (c) => c === BELT_L || c === BELT_R;
const isSpike = (c) => c >= SPIKE_UP && c <= SPIKE_LEFT;

// Clawd's proportions: wider than tall.  Still 6px narrower than a tile, so a
// 1-tile gap is passable.
const PLAYER_W = 24;
const PLAYER_H = 20;

const EPOCH_UTC = Date.UTC(2026, 9, 12); // Daily Jump #1

// ============================================================
// Tuning
// ============================================================
const PHYS = {
  gravity: 2300,
  fallGravityMult: 1.3,          // fall faster than you rise — snappier arcs
  apexGravityMult: 0.55,         // brief hang at the top of a held jump
  apexThreshold: 110,            // |vy| below this counts as "at the apex"
  jumpCut: 0.45,                 // releasing jump while rising multiplies vy by this, once
  maxFall: 900,
  jumpV: 720,                    // full held jump rises ~115px ~= 3.8 tiles
  maxSpeed: 330,
  beltV: 160, // a conveyor's push, added to your run (so 490 with it, 170 against)
  groundAccel: 3600,
  groundFriction: 4200,
  airAccel: 2400,
  airFriction: 500,
  turnMult: 1.8,                 // extra accel when reversing, so turnarounds are instant
  coyoteTime: 0.09,
  jumpBuffer: 0.12,
  wallSlide: 140,                // slide speed while pressing into a wall
  wallSlideDecel: 3200,          // how fast a falling hit on a wall brakes down to that
  wallStick: 0.1,                // pressing away from a wall holds you on it this long,
                                 // so "away + jump" gets the big kick, not a plain drop
  wallCoyote: 0.1,               // grace period after leaving a wall
  // Wall kicks depend on what you're holding when you jump:
  //   toward the wall -> climb kick: mostly up, small push, re-grab the same wall
  //   nothing         -> neutral kick
  //   away            -> leap: long push away from the wall
  climbKick: { vx: 170, vy: 730, lock: 0.05 },
  neutralKick: { vx: 250, vy: 700, lock: 0.09 },
  leapKick: { vx: 390, vy: 660, lock: 0.12 },
  cornerNudge: 7,                // px you get slid around a ceiling corner instead of bonking
  // Corner kick: brushing the *underside* corner of a ledge with just your head
  // (solid beside you only in the top `cornerBand` px, open air below) lets you kick
  // off it like a mid-air double jump — but only within `cornerWindow` of the touch.
  // A real wall gives you 0.1s of grace; a corner gives you a few frames.
  cornerBand: 8,                 // "head height": the top 8px of a 20px-tall player
  cornerWindow: 0.08,            // with a quick re-tap this leaves ~3 frames at 60fps (measured)
  cornerKick: { vx: 230, vy: 780, lock: 0.08 }, // a touch more lift than a ground jump
  springV: 1010,                 // a spring launch: ~1.4x a full jump's height
  updraft: 4200,                 // updraft lift (px/s²): beats gravity, so you rise...
  updraftMax: 400,               // ...but never faster than this (< jumpV: the solver's bound holds)
};

const LEVELS = [
  {
    name: 'Warmup', safetyPad: 8, tolerance: 0.3, dividers: [1, 1], minTurns: 2, springs: [0, 1], planks: 0.25, switchRooms: 0.25, beltRooms: 0.2, updrafts: [0, 1], routeSpikes: 6, routeSaws: 0, routeMargin: 12, chain: [2, 3], shaft: 1, goalMinHeight: 2, attempts: 26, minChunks: 22,
    ledges: [4, 6], ledgeMax: 7, pillars: [1, 2], pits: [0, 1],
    topSpikes: 0.2, ceilSpikes: 0, wallSpikes: 0, saws: null,
    goalHeightBias: 1.2,
  },
  {
    name: 'Grinder', safetyPad: 6, tolerance: 0.2, dividers: [1, 2], minTurns: 3, springs: [1, 1], lockChance: 0.4, planks: 0.3, switchRooms: 0.35, beltRooms: 0.3, updrafts: [0, 1], routeSpikes: 11, routeSaws: 1, routeMargin: 9, chain: [3, 4], shaft: 1, goalMinHeight: 2, attempts: 24, minChunks: 26,
    ledges: [5, 8], ledgeMax: 5, pillars: [2, 3], pits: [1, 3],
    topSpikes: 0.45, ceilSpikes: 3, wallSpikes: 2, saws: [1, 2],
    goalHeightBias: 1.8,
  },
  {
    name: 'Gauntlet', safetyPad: 4, tolerance: 0.12, dividers: [2, 2], minTurns: 4, springs: [1, 2], lockChance: 0.5, planks: 0.3, switchRooms: 0.45, beltRooms: 0.35, updrafts: [1, 1], routeSpikes: 16, routeSaws: 2, routeMargin: 7, chain: [3, 5], shaft: 1, goalMinHeight: 2, attempts: 28, minChunks: 28,
    ledges: [6, 9], ledgeMax: 4, pillars: [3, 4], pits: [2, 4],
    topSpikes: 0.6, ceilSpikes: 5, wallSpikes: 4, saws: [2, 3],
    goalHeightBias: 2.6,
  },
];

// The bonus room: optional, unlocked by finishing the day's three, for the people who
// want more.  Denser and tighter than the Gauntlet (route keeps only a 3px pad), but
// held to the same rules: proven beatable by the solver, no corner kick required.
const BONUS_ROOM = 3;
const BONUS = {
  name: 'Nightmare', safetyPad: 3, dividers: [2, 2], minTurns: 4, springs: [1, 2], lockChance: 0.6, planks: 0.3, switchRooms: 0.5, beltRooms: 0.4, updrafts: [1, 2], routeSpikes: 24, routeSaws: 3, routeMargin: 5, chain: [4, 5], shaft: 1, goalMinHeight: 3, attempts: 28, minChunks: 28,
  ledges: [7, 10], ledgeMax: 4, pillars: [3, 5], pits: [3, 5],
  topSpikes: 0.75, ceilSpikes: 7, wallSpikes: 6, saws: [3, 4],
  goalHeightBias: 3.2,
};
const cfgFor = (index) => (index === BONUS_ROOM ? BONUS : LEVELS[index]);

// Daily twists: some days bend the physics for all of that day's rooms.  The rooms are
// generated, solved and verified *with* the twist, so every one is still proven fair.
const TWISTS = {
  moon: { name: 'Moon', icon: '🌙', desc: 'low gravity — floaty, long jumps', mod: { gravity: 0.7, maxFall: 0.75 } },
  ice: { name: 'Ice', icon: '🧊', desc: 'slippery floors — plan your stops', mod: { groundFriction: 0.12, groundAccel: 0.45, turnMult: 0.55 } },
  turbo: { name: 'Turbo', icon: '⚡', desc: 'everything runs faster', mod: { maxSpeed: 1.3, groundAccel: 1.35, airAccel: 1.3 } },
};
const TWIST_KEYS = Object.keys(TWISTS);
const physCache = new Map();
function physFor(twist) {
  if (!twist || !TWISTS[twist]) return PHYS;
  if (!physCache.has(twist)) {
    const out = { ...PHYS };
    for (const [k, m] of Object.entries(TWISTS[twist].mod)) out[k] = PHYS[k] * m;
    physCache.set(twist, out);
  }
  return physCache.get(twist);
}
// Three days in seven get a twist, decided by the date like everything else.
function twistForDay(dateKey) {
  const r = hashString(`daily-jump/twist/${dateKey}`) % 7;
  return r < TWIST_KEYS.length ? TWIST_KEYS[r] : null;
}

// ============================================================
// Themes — purely visual; each day deals 3 of these out to its rooms
// ============================================================
// Readability rule: platforms are the darkest thing on screen (near-black `fill`
// with glowing edges), and every backdrop is hazed with `fog` = [colour, alpha].
// The haze only ever adds light, so no background pixel can drop below the haze
// alone over black — that floor is what keeps platforms from blending into the
// scenery, whatever the scenery happens to be.  (Canvas blends in sRGB, not linear
// light, so a faint haze adds less brightness than the alpha suggests: the floor
// is lin(alpha * fog), which is why the greener themes need more alpha.)  Measured per theme with
// scratchpad/contrast.js (screenshots + luminance next to every exposed platform).
// Daytime themes use `glow: false` and dark outlines on hazards (`spikeLine`,
// `sawLine`): on a bright sky, glowing white spikes would vanish, but a red spike
// with a dark rim reads against both the sky and the near-black platforms.
const THEMES = {
  cloudSea: {
    icon: '☁️', name: 'Cloud Sea', backdrop: 'cloudSea', tiles: 'cap', cap: 'grass', ambience: 'clouds', glow: false,
    sky: ['#4ea6f2', '#8fd0ff', '#dff3ff'], fill: '#120f0c', fog: ['#e6f6ff', 0.12], edge: '#6cc04a', edge2: '#3d8a2e',
    spike: '#d62828', spikeLine: '#3a0509', saw: '#5d6b7a', sawLine: '#161b22',
  },
  tropicSea: {
    icon: '🌴', name: 'Tropic Sea', backdrop: 'sea', tiles: 'cap', cap: 'sand', ambience: 'gulls', glow: false,
    sky: ['#2f86d6', '#79c3ef', '#d2f0ff'], fill: '#0f0d0b', fog: ['#d2f0ff', 0.1], edge: '#f0d9a0', edge2: '#b8945a',
    spike: '#d62828', spikeLine: '#3a0509', saw: '#5d6b7a', sawLine: '#161b22',
  },
  alpineDawn: {
    icon: '🏔️', name: 'Alpine Dawn', backdrop: 'alps', tiles: 'cap', cap: 'grass', ambience: 'birds', glow: false,
    sky: ['#6f9fd6', '#e9b3c8', '#ffe2c4'], fill: '#0d0e0c', fog: ['#ffe2c4', 0.12], edge: '#86d95f', edge2: '#3f8a3c',
    spike: '#d62828', spikeLine: '#3a0509', saw: '#5d6b7a', sawLine: '#161b22',
  },
  duneSea: {
    icon: '🌙', name: 'Dune Sea', backdrop: 'dunes', tiles: 'cap', cap: 'sand', ambience: 'sand',
    sky: ['#0f0b29', '#36265e', '#93558a'], fill: '#0b0910', fog: ['#9a86c8', 0.28], edge: '#e2bf8f', edge2: '#a07a52',
    spike: '#f6ead2', saw: '#f6ead2',
  },
  auroraTundra: {
    icon: '🌌', name: 'Aurora Tundra', backdrop: 'tundra', tiles: 'cap', cap: 'snow', ambience: 'snow',
    sky: ['#040816', '#0b1d38', '#1d3a5e'], fill: '#06080f', fog: ['#5577aa', 0.32], edge: '#f1f6ff', edge2: '#9fb4d8',
    spike: '#a6eaff', saw: '#dff7ff',
  },
  goldenSavanna: {
    icon: '🌅', name: 'Golden Savanna', backdrop: 'savanna', tiles: 'cap', cap: 'grass', ambience: 'motes', glow: false,
    sky: ['#ff9e5e', '#ffc477', '#fff0b8'], fill: '#120c07', fog: ['#fff0b8', 0.1], edge: '#d9b45e', edge2: '#9a7a2e',
    spike: '#d62828', spikeLine: '#3a0509', saw: '#5d6b7a', sawLine: '#161b22',
  },
  synthwave: {
    icon: '🌇', name: 'Synthwave', backdrop: 'sunset', tiles: 'neon', ambience: 'stars',
    sky: ['#0b0221', '#3b0b5c', '#ff6a3d'], fill: '#090312', fog: ['#8a4aa0', 0.48], edge: '#ff7edb', edge2: '#ffb347',
    spike: '#ffd23f', saw: '#ff7edb',
  },
  sakura: {
    icon: '⛩️', name: 'Sakura Night', backdrop: 'shrine', tiles: 'stone', ambience: 'petals',
    sky: ['#070b1f', '#1b2250', '#4b3a70'], fill: '#09080e', fog: ['#6a6ab0', 0.37], edge: '#ffb7d5', edge2: '#6c5a86',
    spike: '#f6f0ff', saw: '#ffffff', // white, not pink: saws must never blend into blossoms
  },
};
const THEME_KEYS = Object.keys(THEMES);

// ============================================================
// Daily seed
// ============================================================
function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dateKeyFor(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayNumberFor(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH_UTC) / 864e5) + 1;
}

// The date key `days` away from `dateKey` (calendar arithmetic, no time zones).
function shiftDateKey(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 864e5);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// Daily streak from the set of days you finished the daily run.  Like Wordle, an
// unplayed *today* doesn't break it yet — `current` counts back from yesterday and
// `atRisk` says today is still open.  `best` is the longest run ever.
function streakFrom(today, days) {
  const has = (k) => days.has(k);
  const atRisk = !has(today);
  let current = 0;
  for (let k = atRisk ? shiftDateKey(today, -1) : today; has(k); k = shiftDateKey(k, -1)) current++;
  let best = current;
  for (const k of days) {
    if (has(shiftDateKey(k, -1))) continue; // only count from the start of each run
    let n = 0;
    for (let j = k; has(j); j = shiftDateKey(j, 1)) n++;
    if (n > best) best = n;
  }
  return { current, best, atRisk };
}

// The bonus room's theme: one the day's three rooms didn't get.
function bonusTheme(dateKey) {
  const used = themesForDay(dateKey);
  const rest = THEME_KEYS.filter((k) => !used.includes(k));
  return rest[hashString(`daily-jump/bonus-theme/${dateKey}`) % rest.length];
}

function levelSeed(dateKey, levelIndex) {
  return hashString(`daily-jump/${dateKey}/${levelIndex}`);
}

// Three different themes for the day's three rooms, same for everyone.
function themesForDay(dateKey) {
  const rng = mulberry32(hashString(`daily-jump/themes/${dateKey}`));
  const keys = THEME_KEYS.slice();
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return keys.slice(0, 3);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// PORTABLE MATH: everything above boot() — generation, physics, verification —
// runs in every browser *and* on the server, which re-simulates submitted runs.
// It must give bit-identical results in every JS engine, so it sticks to + - * /
// and Math.sqrt (all exactly rounded by IEEE 754).  Math.hypot / sin / cos / pow
// and friends are allowed to differ between engines, so they stay out of here.

// ============================================================
// Tile queries
// ============================================================
function cellAt(level, cx, cy) {
  if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return SOLID;
  return level.grid[cy * COLS + cx];
}

function solidAt(level, cx, cy) {
  const c = cellAt(level, cx, cy);
  return c === SOLID || c === SPRING || c === BELT_L || c === BELT_R;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Hitboxes are inset so the very tip of a spike doesn't count — the game should feel fair.
function spikeRect(code, cx, cy) {
  const x0 = cx * TILE;
  const y0 = cy * TILE;
  const d = SPIKE_LEN - 4;
  switch (code) {
    case SPIKE_UP: return { x: x0 + 3, y: y0 + TILE - d, w: TILE - 6, h: d };
    case SPIKE_DOWN: return { x: x0 + 3, y: y0, w: TILE - 6, h: d };
    case SPIKE_RIGHT: return { x: x0, y: y0 + 3, w: d, h: TILE - 6 };
    default: return { x: x0 + TILE - d, y: y0 + 3, w: d, h: TILE - 6 };
  }
}

function tileRange(p) {
  return {
    cx0: Math.max(0, Math.floor(p.x / TILE)),
    cx1: Math.min(COLS - 1, Math.floor((p.x + p.w - 0.001) / TILE)),
    cy0: Math.max(0, Math.floor(p.y / TILE)),
    cy1: Math.min(ROWS - 1, Math.floor((p.y + p.h - 0.001) / TILE)),
  };
}

function hitsSpikes(p, level) {
  const { cx0, cx1, cy0, cy1 } = tileRange(p);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = level.grid[cy * COLS + cx];
      if (isSpike(c) && overlaps(p, spikeRect(c, cx, cy))) return true;
    }
  }
  return false;
}

// ============================================================
// Saws — circular blades patrolling a straight line
// ============================================================
const triWave = (t) => {
  const f = ((t % 1) + 1) % 1;
  return f < 0.5 ? f * 2 : 2 - f * 2;
};

function sawPos(s, t) {
  const u = triWave(t * s.speed + s.phase);
  return { x: s.x0 + (s.x1 - s.x0) * u, y: s.y0 + (s.y1 - s.y0) * u };
}

function circleHitsRect(cx, cy, r, p) {
  const nx = clamp(cx, p.x, p.x + p.w);
  const ny = clamp(cy, p.y, p.y + p.h);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

function hitsSaws(p, level, t) {
  for (const s of level.saws) {
    const pos = sawPos(s, t);
    if (circleHitsRect(pos.x, pos.y, s.r * 0.78, p)) return true;
  }
  return false;
}

// What the game kills you with: spikes, live saws, falling out of the world.
function hitsHazard(p, level, t) {
  if (p.y > VIEW_H + 80) return true;
  if (hitsSpikes(p, level)) return true;
  return hitsSaws(p, level, t);
}

// What the solver kills itself with: spikes, plus the *entire* sweep of every saw.
// Finding a route that never enters a saw's path proves the room is beatable no
// matter where the blades happen to be, so no daily level can hinge on timing luck.
// While a room is being built, `level.searchPad` fattens the player by that many px
// for this test, so the route that proves the room beatable keeps that much
// clearance from every spike and saw path.  Without it the solver's line brushes
// hazards pixel-close, and a one-frame timing slip kills a human on it.
function hitsStaticHazard(p, level) {
  const pad = level.searchPad || 0;
  const q = pad ? { x: p.x - pad, y: p.y - pad, w: p.w + 2 * pad, h: p.h + 2 * pad } : p;
  if (hitsSpikes(q, level)) return true;
  const m = level.botMask;
  if (!m) return false;
  const { cx0, cx1, cy0, cy1 } = tileRange(q);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) if (m[cy * COLS + cx]) return true;
  }
  return false;
}

function buildBotMask(saws) {
  const m = new Uint8Array(COLS * ROWS);
  for (const s of saws) {
    const len = Math.sqrt((s.x1 - s.x0) ** 2 + (s.y1 - s.y0) ** 2); // not Math.hypot: see PORTABLE MATH
    const steps = Math.max(1, Math.ceil(len / 4));
    const r = s.r * 0.78;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const px = s.x0 + (s.x1 - s.x0) * u;
      const py = s.y0 + (s.y1 - s.y0) * u;
      const cx0 = Math.max(0, Math.floor((px - r) / TILE));
      const cx1 = Math.min(COLS - 1, Math.floor((px + r) / TILE));
      const cy0 = Math.max(0, Math.floor((py - r) / TILE));
      const cy1 = Math.min(ROWS - 1, Math.floor((py + r) / TILE));
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) m[cy * COLS + cx] = 1;
      }
    }
  }
  return m;
}

// ============================================================
// Clawd, the Claude mascot — the player sprite, as pixel art
// ============================================================
// Drawn on a 2px grid, laid out after the Claude Code logo
//    ▐▛███▜▌
//   ▝▜█████▛▘
//     ▘▘ ▝▝
// a 12x8 body (3:2, wider than tall), eye notches near the top inner corners, arm
// nubs at mid-height, and two pairs of stubby legs with a gap between them.  The
// body + legs fill the 24x20 hitbox exactly; only the arm nubs poke out (4px each
// side), which can make a spike look closer than it is but never the reverse.
const CLAWD_UNIT = 2;
const CLAWD_W = 16;
const CLAWD_H = 10;

// legPose: 'stand' (all four down), 'air' (all tucked), 0 or 1 (walk cycle: that
// pair of legs lifted).  cling: -1/1 when hugging a wall on that side — the arm on
// that side goes up and plants its hand on the wall (the nub reaches 4px past the
// hitbox, so it visibly touches), `grip` 0/1 slips it a notch as you slide, the
// feet on that side tuck against the wall, and he looks away from it, at where
// he's about to jump.  Returns rects in grid units: { x, y, w, h, part }.
function clawdRects(facing, legPose, cling = 0, grip = 0) {
  const rects = [];
  const r = (x, y, w, h, part) => rects.push({ x, y, w, h, part });
  for (const [lx, pair] of [[3, 0], [5, 1], [10, 0], [12, 1]]) {
    const wallFoot = cling !== 0 && (cling < 0 ? lx < 8 : lx > 8);
    const lifted = wallFoot || legPose === 'air' || legPose === pair;
    r(lx, 8, 1, lifted ? 1 : 2, 'body');
  }
  if (cling) {
    r(cling < 0 ? 0 : 14, 1 + grip, 2, 2, 'body'); // hand up on the wall
    r(cling < 0 ? 14 : 0, 5, 2, 2, 'body');        // free arm hangs a bit lower
  } else {
    r(0, 4, 2, 2, 'body');   // arm nubs
    r(14, 4, 2, 2, 'body');
  }
  r(2, 0, 12, 8, 'body');  // body
  r(2, 7, 12, 1, 'shade'); // underside
  // eyes: tall notches that glance the way you're facing (away from a wall you cling to)
  const look = cling ? -cling : facing;
  const shift = look > 0 ? 1 : look < 0 ? -1 : 0;
  r(4 + shift, 2, 1, 2, 'eye');
  r(11 + shift, 2, 1, 2, 'eye');
  return rects;
}

// `outline`: a 1px dark edge so Clawd's orange never sinks into a golden or orange sky.
const CLAWD_COLORS = { body: '#d97757', shade: '#b4583b', eye: '#1b1b2f', outline: '#3a1a0e' };
const GHOST_COLORS = { body: '#9ad1ff', shade: '#74aedb', eye: '#ffffff', outline: '#1d3a5c' };
const SHARD_GOLD = '#ffb547';
const GOLD_COLORS = { body: '#ffd166', shade: '#d4a537', eye: '#3a2a00', outline: '#5c4300' };   // #1 of the day
const CHALLENGE_COLORS = { body: '#c77dff', shade: '#9b5ad1', eye: '#1b1b2f', outline: '#3a1d5c' }; // a friend's challenge
const SILVER_COLORS = { body: '#dfe3ee', shade: '#a9afbf', eye: '#1b1b2f', outline: '#3c4152' }; // the run just above yours

// ============================================================
// Player physics — ground jump, variable height, wall slide, wall jump
// ============================================================
// Spawns are always on the floor, so a fresh player starts out standing.  Starting
// airborne cost a one-step jump delay on the first frame only — which the ghost
// always paid and a player who waited at spawn didn't, so idling could beat it.
function makePlayer(spawn) {
  return {
    x: spawn.x, y: spawn.y, w: PLAYER_W, h: PLAYER_H,
    vx: 0, vy: 0, facing: 1,
    onGround: true, coyote: PHYS.coyoteTime, jumpBuffer: 0, cuttable: false,
    wallLeft: false, wallRight: false, wallSide: 0, wallCoyote: 0, wallStick: 0,
    cornerSide: 0, cornerCoyote: 0, cornerKickSide: 0,
    kickLock: 0, kickDir: 0,
    sliding: false, clinging: 0, landed: false, jumped: false, wallJumped: false, cornerKicked: false,
    hasKey: false, gotKey: false,
    phase: 0, // on/off blocks: which colour is solid (flips on each jump in a room that has them)
  };
}

function clonePlayer(p) {
  return {
    x: p.x, y: p.y, w: p.w, h: p.h,
    vx: p.vx, vy: p.vy, facing: p.facing,
    onGround: p.onGround, coyote: p.coyote, jumpBuffer: p.jumpBuffer, cuttable: p.cuttable,
    wallLeft: p.wallLeft, wallRight: p.wallRight, wallSide: p.wallSide,
    wallCoyote: p.wallCoyote, wallStick: p.wallStick,
    cornerSide: p.cornerSide, cornerCoyote: p.cornerCoyote, cornerKickSide: p.cornerKickSide,
    kickLock: p.kickLock, kickDir: p.kickDir,
    sliding: p.sliding, landed: p.landed, jumped: p.jumped, wallJumped: p.wallJumped,
    cornerKicked: p.cornerKicked, clinging: p.clinging,
    jumpHeldPrev: p.jumpHeldPrev,
    hasKey: p.hasKey,
    phase: p.phase,
  };
}

function approach(v, target, delta) {
  return v < target ? Math.min(v + delta, target) : Math.max(v - delta, target);
}

function rectHitsSolid(solid, x, y, w, h) {
  const cx0 = Math.floor(x / TILE);
  const cx1 = Math.floor((x + w - 0.001) / TILE);
  const cy0 = Math.floor(y / TILE);
  const cy1 = Math.floor((y + h - 0.001) / TILE);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) if (solid(cx, cy)) return true;
  }
  return false;
}

// input: { left, right, jumpHeld, jumpPressed }
function stepPlayer(p, input, level, dt) {
  const PHYS_ = level.phys || PHYS; // a day's twist (moon, ice, turbo) bends the physics
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (dir !== 0) p.facing = dir;

  // --- wall contact ---
  const touchSide = p.wallLeft ? -1 : p.wallRight ? 1 : 0;
  const onWall = !p.onGround && touchSide !== 0;
  if (onWall && dir === -touchSide) p.wallStick -= dt;
  else p.wallStick = PHYS_.wallStick;
  const stuck = onWall && dir === -touchSide && p.wallStick > 0;

  // A conveyor under your feet (from last step's ground): its speed is where you settle.
  let belt = 0;
  if (level.belts && p.onGround) {
    const by = Math.floor((p.y + p.h + 1) / TILE);
    const mid = cellAt(level, Math.floor((p.x + p.w / 2) / TILE), by);
    const c = isBelt(mid) ? mid : [Math.floor(p.x / TILE), Math.floor((p.x + p.w - 0.001) / TILE)].map((x) => cellAt(level, x, by)).find(isBelt);
    if (c) belt = c === BELT_R ? PHYS_.beltV : -PHYS_.beltV;
  }

  // --- horizontal ---
  p.kickLock = Math.max(0, p.kickLock - dt);
  // A kick only locks out input that would undo it; steering with the kick, or
  // anything once the (short) lock ends, applies straight away.
  const locked = p.kickLock > 0 && dir === -p.kickDir;
  if (stuck) {
    p.vx = 0;
  } else if (dir !== 0 && !locked) {
    if (!p.onGround && Math.abs(p.vx) > PHYS_.maxSpeed && Math.sign(p.vx) === dir) {
      // Faster than you could run (a leap kick): keep the momentum, bleed it gently.
      p.vx = approach(p.vx, dir * PHYS_.maxSpeed, PHYS_.airFriction * dt);
    } else {
      let a = p.onGround ? PHYS_.groundAccel : PHYS_.airAccel;
      if (p.vx !== 0 && Math.sign(p.vx) !== dir) a *= PHYS_.turnMult;
      p.vx = approach(p.vx, dir * PHYS_.maxSpeed + belt, a * dt);
    }
  } else if (dir === 0) {
    p.vx = approach(p.vx, belt, (p.onGround ? PHYS_.groundFriction : PHYS_.airFriction) * dt);
  }

  // --- jumping ---
  p.coyote = p.onGround ? PHYS_.coyoteTime : p.coyote - dt;
  if (touchSide !== 0) {
    p.wallCoyote = PHYS_.wallCoyote;
    p.wallSide = touchSide;
  } else {
    p.wallCoyote -= dt;
  }
  if (!p.onGround && p.cornerSide !== 0) {
    p.cornerCoyote = PHYS_.cornerWindow;
    p.cornerKickSide = p.cornerSide;
  } else {
    p.cornerCoyote -= dt;
  }
  p.jumpBuffer = input.jumpPressed ? PHYS_.jumpBuffer : p.jumpBuffer - dt;

  p.jumped = false;
  p.wallJumped = false;
  p.sprung = false;
  p.inUpdraft = false;
  p.cornerKicked = false;
  if (p.jumpBuffer > 0) {
    if (p.coyote > 0) {
      p.vy = -PHYS_.jumpV;
      p.jumpBuffer = 0;
      p.coyote = 0;
      p.onGround = false;
      p.jumped = true;
      p.cuttable = true;
    } else if (!p.onGround && p.wallCoyote > 0) {
      const away = -p.wallSide;
      const kick = dir === p.wallSide ? PHYS_.climbKick : dir === away ? PHYS_.leapKick : PHYS_.neutralKick;
      p.vy = -kick.vy;
      p.vx = away * kick.vx;
      p.facing = away;
      p.kickLock = kick.lock;
      p.kickDir = away;
      p.wallCoyote = 0;
      p.wallStick = PHYS_.wallStick;
      p.jumpBuffer = 0;
      p.jumped = true;
      p.wallJumped = true;
      p.cuttable = true;
    } else if (!p.onGround && p.cornerCoyote > 0 && !level.noCornerKick) {
      const away = -p.cornerKickSide;
      const kick = PHYS_.cornerKick;
      p.vy = -kick.vy;
      p.vx = away * kick.vx;
      p.facing = away;
      p.kickLock = kick.lock;
      p.kickDir = away;
      p.cornerCoyote = 0;
      p.wallCoyote = 0;
      p.jumpBuffer = 0;
      p.jumped = true;
      p.cornerKicked = true;
      p.cuttable = true;
    }
  }

  // On/off blocks swap on every jump you make (not on a spring launch).
  if (p.jumped && level.switches) p.phase ^= 1;

  // --- gravity ---
  if (p.vy < 0 && !input.jumpHeld && p.cuttable) {
    p.vy *= PHYS_.jumpCut; // let go early = short hop, decided the instant you let go
    p.cuttable = false;
  }
  if (p.vy >= 0) p.cuttable = false;
  let g = PHYS_.gravity;
  if (p.vy > 0) g *= PHYS_.fallGravityMult;
  else if (input.jumpHeld && Math.abs(p.vy) < PHYS_.apexThreshold) g *= PHYS_.apexGravityMult;
  p.vy = Math.min(p.vy + g * dt, PHYS_.maxFall);
  // Updrafts: rising air that lifts you (never faster than a gentle rise, so the
  // solver's climb estimate — jumpV — stays a true upper bound).
  if (level.updrafts) {
    for (const u of level.updrafts) {
      if (overlaps(p, u)) {
        // Lift only while rising slower than the cap: a jump or spring through a column
        // keeps its speed.  Rooms stored before that fix (no liftFix) keep the physics
        // they were proven and published with.
        if (!level.liftFix || p.vy > -PHYS_.updraftMax) p.vy = Math.max(p.vy - PHYS_.updraft * dt, -PHYS_.updraftMax);
        p.inUpdraft = true;
        break;
      }
    }
  }

  p.sliding = false;
  if (onWall && p.vy > 0 && dir === touchSide) {
    if (p.vy > PHYS_.wallSlide) p.vy = Math.max(PHYS_.wallSlide, p.vy - PHYS_.wallSlideDecel * dt);
    p.sliding = true;
  }
  p.clinging = p.sliding || stuck ? touchSide : 0; // cosmetic: drives the hand-on-wall pose

  // What's solid this step.  An on/off block that switched on while you were inside
  // it doesn't trap or shove you: it stays open to you until you've left it.
  let solid = level.solidFn || (level.solidFn = (cx, cy) => solidAt(level, cx, cy)); // one per room, not per step
  if (level.switches) {
    const on = p.phase ? SWITCH_B : SWITCH_A;
    const ix0 = Math.floor(p.x / TILE);
    const ix1 = Math.floor((p.x + p.w - 0.001) / TILE);
    const iy0 = Math.floor(p.y / TILE);
    const iy1 = Math.floor((p.y + p.h - 0.001) / TILE);
    solid = (cx, cy) => {
      const c = cellAt(level, cx, cy);
      if (c === SOLID || c === SPRING) return true;
      return c === on && !(cx >= ix0 && cx <= ix1 && cy >= iy0 && cy <= iy1);
    };
  }

  // --- horizontal sweep (max ~3.3px/step, so no tunnelling) ---
  p.x += p.vx * dt;
  {
    const cy0 = Math.floor(p.y / TILE);
    const cy1 = Math.floor((p.y + p.h - 0.001) / TILE);
    if (p.vx > 0) {
      const cx = Math.floor((p.x + p.w - 0.001) / TILE);
      for (let cy = cy0; cy <= cy1; cy++) {
        if (solid(cx, cy)) { p.x = cx * TILE - p.w; p.vx = 0; break; }
      }
    } else if (p.vx < 0) {
      const cx = Math.floor(p.x / TILE);
      for (let cy = cy0; cy <= cy1; cy++) {
        if (solid(cx, cy)) { p.x = (cx + 1) * TILE; p.vx = 0; break; }
      }
    }
  }

  // --- vertical sweep (max 7.5px/step) ---
  const wasOnGround = p.onGround;
  const prevBottom = p.y + p.h;
  p.y += p.vy * dt;
  p.onGround = false;
  if (p.vy < 0 && rectHitsSolid(solid, p.x, p.y, p.w, p.h)) {
    // Clipping a ceiling corner by a few px slides you around it instead of
    // killing the jump — the single biggest "why did that not work" in platformers.
    const pref = p.vx < 0 ? -1 : 1;
    for (let off = 1; off <= PHYS_.cornerNudge; off++) {
      if (!rectHitsSolid(solid, p.x + pref * off, p.y, p.w, p.h)) { p.x += pref * off; break; }
      if (!rectHitsSolid(solid, p.x - pref * off, p.y, p.w, p.h)) { p.x -= pref * off; break; }
    }
  }
  const cx0 = Math.floor(p.x / TILE);
  const cx1 = Math.floor((p.x + p.w - 0.001) / TILE);
  if (p.vy > 0) {
    const cy = Math.floor((p.y + p.h - 0.001) / TILE);
    // a one-way plank only catches you if you were above its top a step ago
    const plank = (cx) => cellAt(level, cx, cy) === ONEWAY && prevBottom <= cy * TILE + 0.01;
    for (let cx = cx0; cx <= cx1; cx++) {
      if (solid(cx, cy) || plank(cx)) { p.y = cy * TILE - p.h; p.vy = 0; p.onGround = true; break; }
    }
    // Landing with any part of you over a spring: launched, whatever you were doing.
    if (p.onGround) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (cellAt(level, cx, cy) === SPRING) {
          p.vy = -PHYS_.springV;
          p.onGround = false;
          p.sprung = true;
          p.cuttable = false; // releasing jump mustn't cut a spring launch short
          break;
        }
      }
    }
  } else if (p.vy < 0) {
    const cy = Math.floor(p.y / TILE);
    for (let cx = cx0; cx <= cx1; cx++) {
      if (solid(cx, cy)) { p.y = (cy + 1) * TILE; p.vy = 0; break; }
    }
  }
  // Resting on a floor leaves vy at 0, which would read as airborne for a frame.
  if (!p.onGround && p.vy >= 0) {
    const cy = Math.floor((p.y + p.h + 0.5) / TILE);
    for (let cx = cx0; cx <= cx1; cx++) {
      if (solid(cx, cy) || (cellAt(level, cx, cy) === ONEWAY && p.y + p.h <= cy * TILE + 0.01)) { p.onGround = true; break; }
    }
  }
  p.landed = p.onGround && !wasOnGround;
  // A key is part of the simulation (not the UI), so the solver, the ghost, replays
  // and the server all agree on when the goal unlocks.
  p.gotKey = false;
  if (level.key && !p.hasKey && overlaps(p, level.key)) { p.hasKey = true; p.gotKey = true; }

  // Side contact.  Solid beside you anywhere below head height is a wall: slide on
  // it, grab it, kick off it.  Solid beside you *only* at head height, with air
  // below, is the underside corner of a ledge: no slide or grab, just the corner kick.
  p.wallLeft = false;
  p.wallRight = false;
  let cornerL = false;
  let cornerR = false;
  {
    const top = p.y + 2;
    const bottom = p.y + p.h - 3;
    const headLine = p.y + PHYS_.cornerBand;
    const cy0 = Math.floor(top / TILE);
    const cy1 = Math.floor(bottom / TILE);
    const lcx = Math.floor((p.x - 2) / TILE);
    const rcx = Math.floor((p.x + p.w + 2 - 0.001) / TILE);
    for (let cy = cy0; cy <= cy1; cy++) {
      const headOnly = Math.min(bottom, (cy + 1) * TILE) <= headLine;
      if (solid(lcx, cy)) { if (headOnly) cornerL = true; else p.wallLeft = true; }
      if (solid(rcx, cy)) { if (headOnly) cornerR = true; else p.wallRight = true; }
    }
  }
  p.cornerSide = cornerL && !p.wallLeft ? -1 : cornerR && !p.wallRight ? 1 : 0;
}

// The solver's winning run, replayed one physics step at a time through the same
// stepPlayer the solver used, so it moves exactly as it did when it beat the room.
// `delay` holds the ghost at spawn for a moment before it moves, so you can see
// where it starts instead of catching it halfway across the room.
function makeGhost(level, delay = 0) {
  return { p: makePlayer(level.spawn), i: 0, heldPrev: false, done: false, won: false, wait: 0, delay, delayTotal: delay, trail: [] };
}

function stepGhost(gh, level) {
  if (gh.done) return;
  if (gh.delay > 0) { gh.delay -= DT; return; }
  const ci = Math.floor(gh.i / CHUNK_STEPS);
  if (!level.route || ci >= level.route.length) { gh.done = true; return; }
  const [dir, jump] = BOT_ACTIONS[level.route[ci]];
  const firstStep = gh.i % CHUNK_STEPS === 0;
  stepPlayer(gh.p, {
    left: dir < 0, right: dir > 0, jumpHeld: jump === 1,
    jumpPressed: firstStep && jump === 1 && !gh.heldPrev,
  }, level, DT);
  if (gh.i % CHUNK_STEPS === CHUNK_STEPS - 1) gh.heldPrev = jump === 1;
  gh.i++;
  if (gh.i % 3 === 0) {
    gh.trail.push({ x: gh.p.x + gh.p.w / 2, y: gh.p.y + gh.p.h / 2 });
    if (gh.trail.length > 40) gh.trail.shift();
  }
  if (reachedGoal(gh.p, level)) { gh.done = true; gh.won = true; }
}

// How long the ghost takes from spawn to touching the goal, measured exactly like a
// player's room time (physics steps from respawn), so the two compare directly.
// Like a player's, the ghost's clock starts at its first input — any idle chunks at
// the start of its route don't count.
function ghostTimeOf(level) {
  const gh = makeGhost(level);
  // It must *survive* too (spikes, saws where they really are at each step): a line
  // that only reaches the goal by passing through a hazard is no line at all.
  let clock = 0;
  while (!gh.done) {
    const before = gh.i;
    stepGhost(gh, level);
    if (gh.i === before) break; // route ran out
    clock += DT;
    if (hitsHazard(gh.p, level, clock)) return 0; // same order as verifyReplay: hazard first
  }
  if (!gh.won) return 0;
  let idle = 0;
  while (idle < level.route.length && BOT_ACTIONS[level.route[idle]][0] === 0 && BOT_ACTIONS[level.route[idle]][1] === 0) idle++;
  return (gh.i - idle * CHUNK_STEPS) * DT;
}

// Ranks are your room time as a multiple of the ghost's.  The ghost plays with
// frame-perfect inputs, so matching it (ratio <= 1) is the joke rank: IMPOSSIBLE.
const RANKS = [
  { name: 'IMPOSSIBLE', upTo: 1.0, color: '#c77dff' },
  { name: 'S', upTo: 1.25, color: '#ffd166' },
  { name: 'A', upTo: 1.6, color: '#7bc950' },
  { name: 'B', upTo: 2.2, color: '#4cc9f0' },
  { name: 'C', upTo: 3.0, color: '#c0c0d0' },
  { name: 'D', upTo: Infinity, color: '#8d8d9e' },
];

// Block letters in the "ANSI Shadow" figlet style.  Only the glyphs the ranks need.
const ANSI_SHADOW = {
  S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  B: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██████╔╝', '╚═════╝ '],
  C: [' ██████╗', '██╔════╝', '██║     ', '██║     ', '╚██████╗', ' ╚═════╝'],
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
  I: ['██╗', '██║', '██║', '██║', '██║', '╚═╝'],
  M: ['███╗   ███╗', '████╗ ████║', '██╔████╔██║', '██║╚██╔╝██║', '██║ ╚═╝ ██║', '╚═╝     ╚═╝'],
  P: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔═══╝ ', '██║     ', '╚═╝     '],
  O: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
  L: ['██╗     ', '██║     ', '██║     ', '██║     ', '███████╗', '╚══════╝'],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
};

function asciiWord(word) {
  return ANSI_SHADOW.S.map((_, row) => word.split('').map((ch) => ANSI_SHADOW[ch][row]).join(''));
}

function rankFor(time, ghostTime) {
  if (!(ghostTime > 0)) return RANKS[RANKS.length - 1];
  // Compare in whole physics steps, so float noise can't cost you a tie with the ghost.
  const ratio = Math.round(time / DT) / Math.round(ghostTime / DT);
  return RANKS.find((r) => ratio <= r.upTo);
}

// A locked room's goal only counts once you carry its key.
function reachedGoal(p, level) {
  return (!level.key || p.hasKey) && overlaps(p, level.goal);
}

// ============================================================
// Solver — A* over the real physics, to prove a room is beatable
// ============================================================
const CHUNK_STEPS = 8;                   // one search move = 8 physics steps = 1/15s
const CHUNK_T = CHUNK_STEPS * DT;
const BOT_ACTIONS = [[-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
// Budget for the one search that places a room's goal.
const GOAL_SEARCH_BUDGET = 12000;
// Budget for re-solving a finished room with corner kicks allowed, for the ghost.
const GHOST_SEARCH_BUDGET = 8000;

function Heap() {
  this.a = [];
}
Heap.prototype.push = function (f, v) {
  const a = this.a;
  a.push({ f, v });
  let i = a.length - 1;
  while (i > 0) {
    const par = (i - 1) >> 1;
    if (a[par].f <= a[i].f) break;
    const t = a[par]; a[par] = a[i]; a[i] = t;
    i = par;
  }
};
Heap.prototype.pop = function () {
  const a = this.a;
  const top = a[0];
  const last = a.pop();
  if (a.length) {
    a[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < a.length && a[l].f < a[m].f) m = l;
      if (r < a.length && a[r].f < a[m].f) m = r;
      if (m === i) break;
      const t = a[m]; a[m] = a[i]; a[i] = t;
      i = m;
    }
  }
  return top;
};

// Search granularity.  Coarser bins merge nearby states, which can only make a
// search miss a route — never invent one, since every cost it reports comes from
// a real step-by-step simulation.  So erring coarse errs on the safe side.
const KEY_POS = 10;   // px per position bin
const KEY_VEL = 85;   // px/s per velocity bin

function stateKey(p) {
  const ix = clamp(Math.round(p.x / KEY_POS), 0, 199);
  const iy = clamp(Math.round(p.y / KEY_POS), 0, 199);
  const ivx = clamp(Math.round(p.vx / KEY_VEL), -12, 12) + 12;
  const ivy = clamp(Math.round(p.vy / KEY_VEL), -12, 24) + 12;
  return ((((((ix * 200 + iy) * 25 + ivx) * 37 + ivy) * 2) + (p.jumpHeldPrev ? 1 : 0)) * 2 + (p.hasKey ? 1 : 0)) * 2 + (p.phase | 0);
}

// Admissible: nothing travels sideways faster than maxSpeed or upward faster than jumpV.
function botH(p, goal, ph = PHYS, climbV = ph.jumpV) {
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  const gx = goal.x + goal.w / 2;
  const gy = goal.y + goal.h / 2;
  const dx = Math.max(0, Math.abs(cx - gx) - (goal.w + p.w) / 2);
  const up = Math.max(0, (cy - gy) - goal.h / 2);
  // climbV: the fastest way up in this room — a spring's launch where there are springs
  return Math.max(dx / ph.maxSpeed, up / climbV) / CHUNK_T;
}

// opts.start: a player state to search from (default: spawn); opts.goal: a rect to
// reach (default: the room's goal); opts.avoid: a rect that counts as fatal (used to
// route to the shard without finishing the room on the way).
function solveRoom(level, nodeCap = 20000, opts = {}) {
  const goal = opts.goal || level.goal;
  const start = opts.start ? clonePlayer(opts.start) : makePlayer(level.spawn);
  if (!opts.start) start.jumpHeldPrev = false;
  const seen = new Set([stateKey(start)]);
  const open = new Heap();
  // A locked goal: until the key is held, the way there goes through the key — so the
  // estimate is (here → key) + (key → goal), still never more than the real cost.
  const ph = level.phys || PHYS;
  const climbV = level.grid.includes(SPRING) ? Math.max(ph.jumpV, ph.springV) : ph.jumpV;
  // key → goal measured from the most favourable place a player touching the key could
  // be: widened by a player on each side, centre raised by half the touch overlap.
  const viaKey = level.key && goal === level.goal
    ? botH({ x: level.key.x - PLAYER_W, y: level.key.y - (level.key.h + PLAYER_H) / 2, w: level.key.w + 2 * PLAYER_W, h: level.key.h }, goal, ph, climbV) : 0;
  const h = (p) => (viaKey && !p.hasKey ? botH(p, level.key, ph, climbV) + viaKey : botH(p, goal, ph, climbV));
  open.push(h(start), { p: start, g: 0, parent: null, ai: -1 });
  let expanded = 0;

  while (open.a.length) {
    const node = open.pop().v;
    if (++expanded > nodeCap) return { ok: false, reason: 'node-cap', expanded };

    for (let ai = 0; ai < BOT_ACTIONS.length; ai++) {
      const dir = BOT_ACTIONS[ai][0];
      const jump = BOT_ACTIONS[ai][1];
      const p = clonePlayer(node.p);
      const input = {
        left: dir < 0,
        right: dir > 0,
        jumpHeld: jump === 1,
        jumpPressed: jump === 1 && !p.jumpHeldPrev,
      };
      let dead = false;
      let won = false;
      for (let s = 0; s < CHUNK_STEPS; s++) {
        stepPlayer(p, input, level, DT);
        input.jumpPressed = false;
        if (hitsStaticHazard(p, level) || p.y > VIEW_H + 80) { dead = true; break; }
        if (opts.avoid && overlaps(p, opts.avoid)) { dead = true; break; }
        if (overlaps(p, goal) && (goal !== level.goal || reachedGoal(p, level))) { won = true; break; }
      }
      if (dead) continue;
      const g = node.g + 1;
      if (won) return { ok: true, chunks: g, time: g * CHUNK_T, expanded, actions: routeActions(node).concat(ai) };
      p.jumpHeldPrev = jump === 1;
      const k = stateKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      open.push(g + h(p), { p, g, parent: node, ai });
    }
  }
  return { ok: false, reason: 'exhausted', expanded };
}

// Aim one search at the most desirable goal spot and keep every surface it lands on
// along the way, with the cheapest cost for each.  Asking "can the player reach this
// spot?" one candidate at a time means paying the full budget to prove each
// unreachable candidate impossible, and most candidates are unreachable — that cost
// is what kept goals pinned near the floor.  One directed search harvests the whole
// neighbourhood for a single budget instead.
function reachSurfaces(level, target, budget) {
  const start = makePlayer(level.spawn);
  start.jumpHeldPrev = false;
  const targetCell = Math.floor((target.y + target.h) / TILE) * COLS +
    Math.floor((target.x + target.w / 2) / TILE);
  const seen = new Set([stateKey(start)]);
  const open = new Heap();
  const ph = level.phys || PHYS;
  const climbV = level.grid.includes(SPRING) ? Math.max(ph.jumpV, ph.springV) : ph.jumpV;
  open.push(botH(start, target, ph, climbV), { p: start, g: 0, parent: null, ai: -1 });
  const surfaces = new Map(); // cell -> search node, whose parent chain is the route
  let expanded = 0;

  while (open.a.length && expanded < budget) {
    const node = open.pop().v;
    expanded++;

    if (node.p.onGround) {
      const cx = clamp(Math.floor((node.p.x + node.p.w / 2) / TILE), 0, COLS - 1);
      const cy = clamp(Math.floor((node.p.y + node.p.h + 1) / TILE), 0, ROWS - 1);
      // Only a tile the player's centre is standing over can hold the goal: a goal
      // marker centred on that tile is then guaranteed to overlap the player, so
      // landing here *is* reaching it, and no verification pass is needed.
      if (solidAt(level, cx, cy)) {
        const cell = cy * COLS + cx;
        if (!surfaces.has(cell)) surfaces.set(cell, node);
        if (cell === targetCell) break; // best possible spot — stop early
      }
    }

    for (let ai = 0; ai < BOT_ACTIONS.length; ai++) {
      const dir = BOT_ACTIONS[ai][0];
      const jump = BOT_ACTIONS[ai][1];
      const p = clonePlayer(node.p);
      const input = {
        left: dir < 0,
        right: dir > 0,
        jumpHeld: jump === 1,
        jumpPressed: jump === 1 && !p.jumpHeldPrev,
      };
      let dead = false;
      for (let st = 0; st < CHUNK_STEPS; st++) {
        stepPlayer(p, input, level, DT);
        input.jumpPressed = false;
        if (hitsStaticHazard(p, level) || p.y > VIEW_H + 80) { dead = true; break; }
      }
      if (dead) continue;
      p.jumpHeldPrev = jump === 1;
      const k = stateKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      open.push(node.g + 1 + botH(p, target, ph, climbV), { p, g: node.g + 1, parent: node, ai });
    }
  }
  return { surfaces, expanded };
}

function routeActions(node) {
  const actions = [];
  for (let n = node; n && n.parent; n = n.parent) actions.push(n.ai);
  return actions.reverse();
}

// Replays a route step by step against the room as it is *now*, returning every
// hitbox the player occupies along the way, or null if the route dies.
function traceRoute(level, actions) {
  const p = makePlayer(level.spawn);
  let heldPrev = false;
  const rects = [{ x: p.x, y: p.y, w: p.w, h: p.h }];
  for (const ai of actions) {
    const [dir, jump] = BOT_ACTIONS[ai];
    const input = { left: dir < 0, right: dir > 0, jumpHeld: jump === 1, jumpPressed: jump === 1 && !heldPrev };
    for (let st = 0; st < CHUNK_STEPS; st++) {
      stepPlayer(p, input, level, DT);
      input.jumpPressed = false;
      if (hitsStaticHazard(p, level) || p.y > VIEW_H + 80) return null;
      rects.push({ x: p.x, y: p.y, w: p.w, h: p.h });
    }
    heldPrev = jump === 1;
  }
  return { rects, end: p };
}

function rectGap(a, b) {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.sqrt(dx * dx + dy * dy); // not Math.hypot: see PORTABLE MATH
}

function gapToRoute(rect, rects) {
  let best = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const d = rectGap(rect, rects[i]);
    if (d < best) best = d;
  }
  return best;
}

// Line the solved route with hazards.  Random scatter mostly lands where the route
// never goes, so the winning line can skip every spike in the room.  Instead, put
// spikes and saws right beside the line the solver actually took, each one missing
// it by at least `routeMargin` px.  Spikes aren't solid and the solver already
// treats a saw's whole patrol as deadly, so a hazard that misses every hitbox on the
// route leaves the route exactly as valid as before: the room stays provably
// beatable, but now the way through threads between hazards.
function decorateRoute(room, rects, rng, cfg, keepClear) {
  const margin = cfg.routeMargin;
  const near = margin + 34; // close enough that you'll feel it
  // Each tile's gap to the route, measured once; everything below just looks it up.
  const tileGap = new Float32Array(COLS * ROWS);
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      tileGap[cy * COLS + cx] = gapToRoute({ x: cx * TILE, y: cy * TILE, w: TILE, h: TILE }, rects);
    }
  }
  const options = [];
  for (let cy = TOP_ROW; cy <= FLOOR_ROW; cy++) {
    for (let cx = 1; cx < COLS - 1; cx++) {
      if (cellAt(room, cx, cy) !== EMPTY || keepClear(cx, cy)) continue;
      if (tileGap[cy * COLS + cx] > near) continue; // a spike sits inside its tile
      const mounts = [];
      if (cellAt(room, cx, cy + 1) === SOLID) mounts.push(SPIKE_UP);
      if (cellAt(room, cx, cy - 1) === SOLID) mounts.push(SPIKE_DOWN);
      if (cellAt(room, cx - 1, cy) === SOLID) mounts.push(SPIKE_RIGHT);
      if (cellAt(room, cx + 1, cy) === SOLID) mounts.push(SPIKE_LEFT);
      for (const code of mounts) {
        const d = gapToRoute(spikeRect(code, cx, cy), rects);
        if (d >= margin && d <= near) options.push({ cx, cy, code, w: d + rng() * 20 });
      }
    }
  }
  options.sort((a, b) => a.w - b.w); // closest first, with a little jitter
  let spikes = 0;
  for (const o of options) {
    if (spikes >= cfg.routeSpikes) break;
    if (cellAt(room, o.cx, o.cy) !== EMPTY) continue; // one spike per cell
    room.grid[o.cy * COLS + o.cx] = o.code;
    spikes++;
  }

  // Saws: patrol lines that pass close to the route but whose whole sweep misses it.
  let saws = 0;
  for (let tries = 0; tries < 300 && saws < cfg.routeSaws; tries++) {
    const r = rects[Math.floor(rng() * rects.length)];
    const horiz = rng() < 0.5;
    const len = 2 + Math.floor(rng() * 4);
    const off = (rng() < 0.5 ? -1 : 1) * (1 + Math.floor(rng() * 2));
    let cx = Math.floor((r.x + r.w / 2) / TILE) + (horiz ? -Math.floor(len / 2) : off);
    let cy = Math.floor((r.y + r.h / 2) / TILE) + (horiz ? off : -Math.floor(len / 2));
    const ex = horiz ? cx + len : cx;
    const ey = horiz ? cy : cy + len;
    if (cx < 1 || ex > COLS - 2 || cy < TOP_ROW || ey > FLOOR_ROW - 1) continue;
    let open = true;
    for (let y = cy; y <= ey && open; y++) for (let x = cx; x <= ex && open; x++) {
      if (cellAt(room, x, y) !== EMPTY || keepClear(x, y)) open = false;
    }
    if (!open) continue;
    const saw = {
      x0: cx * TILE + TILE / 2, y0: cy * TILE + TILE / 2,
      x1: ex * TILE + TILE / 2, y1: ey * TILE + TILE / 2,
      r: 15, speed: 0.5 + rng() * 0.6, phase: rng(),
    };
    const mask = buildBotMask([saw]);
    let clear = true;
    let closest = Infinity;
    for (let y = 0; y < ROWS && clear; y++) for (let x = 0; x < COLS && clear; x++) {
      if (!mask[y * COLS + x]) continue;
      const d = tileGap[y * COLS + x];
      if (d < 2 + (room.searchPad || 0)) clear = false; // keep the route's safety pad clear too
      closest = Math.min(closest, d);
    }
    if (!clear || closest > TILE) continue;
    room.saws.push(saw);
    saws++;
  }
  room.botMask = buildBotMask(room.saws);
  return { spikes, saws };
}

// ============================================================
// Replays — the exact inputs of one room attempt, one per physics step
// ============================================================
// Each step's input packs into 4 bits: 1 left, 2 right, 4 jump held, 8 jump
// pressed.  A replay is run-length encoded as "mask*count" pairs joined by '.',
// e.g. "0*12.2*30.14*1.6*7" — a typical clean attempt is well under 1 KB.
const MAX_REPLAY_STEPS = 120 * 120; // 2 minutes of one room

function inputMask(i) {
  return (i.left ? 1 : 0) | (i.right ? 2 : 0) | (i.jumpHeld ? 4 : 0) | (i.jumpPressed ? 8 : 0);
}

function encodeReplay(masks) {
  const out = [];
  for (let i = 0; i < masks.length;) {
    let j = i;
    while (j < masks.length && masks[j] === masks[i]) j++;
    out.push(`${masks[i]}*${j - i}`);
    i = j;
  }
  return out.join('.');
}

// Strict: anything malformed, out of range or too long is rejected (null).
function decodeReplay(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length > 200000) return null;
  const masks = [];
  for (const part of str.split('.')) {
    const m = /^(\d{1,2})\*(\d{1,6})$/.exec(part);
    if (!m) return null;
    const mask = Number(m[1]);
    const count = Number(m[2]);
    if (mask > 15 || count < 1 || masks.length + count > MAX_REPLAY_STEPS) return null;
    for (let k = 0; k < count; k++) masks.push(mask);
  }
  return masks;
}

// Re-plays an attempt exactly as the game loop runs it — clock start on the first
// input, world clock, physics, then live hazards (saws where they really are) —
// and accepts it only if the goal is touched on the replay's very last step.
// Returns { ok, steps, time } (ranked time from the first input) or { ok, reason }.
function verifyReplay(level, masks) {
  if (!Array.isArray(masks) || masks.length === 0) return { ok: false, reason: 'empty replay' };
  const p = makePlayer(level.spawn);
  let clock = 0;
  let steps = 0;
  let started = false;
  for (let i = 0; i < masks.length; i++) {
    const m = masks[i];
    if (!started && m !== 0) started = true;
    if (started) steps++;
    clock += DT;
    stepPlayer(p, { left: (m & 1) !== 0, right: (m & 2) !== 0, jumpHeld: (m & 4) !== 0, jumpPressed: (m & 8) !== 0 }, level, DT);
    if (hitsHazard(p, level, clock)) return { ok: false, reason: `died at step ${i}` };
    if (reachedGoal(p, level)) {
      if (i !== masks.length - 1) return { ok: false, reason: `reached the goal at step ${i} but the replay continues` };
      return { ok: true, steps, time: steps * DT };
    }
  }
  return { ok: false, reason: 'never reached the goal' };
}

// ============================================================
// Room generation
// ============================================================
function finishRoom(grid, saws, spawn, goal, cfg, levelIndex, seed, twist = null) {
  return {
    switches: grid.some(isSwitch),
    belts: grid.some(isBelt),
    liftFix: true, // updrafts never slow a faster rise (generator .14 on)
    index: levelIndex,
    cfg,
    twist,
    phys: physFor(twist),
    grid,
    saws,
    botMask: buildBotMask(saws),
    spawn,
    goal,
    hillSeed: seed,
  };
}

function buildRoom(rng, cfg, levelIndex, seed, relax, twist = null, switchy = false, belty = false) {
  const grid = new Uint8Array(COLS * ROWS);
  const at = (cx, cy) => (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS ? SOLID : grid[cy * COLS + cx]);
  const set = (cx, cy, v) => {
    if (cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS) grid[cy * COLS + cx] = v;
  };
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const fewer = (n) => Math.max(0, Math.round(n * (1 - 0.75 * relax)));
  const spanEmpty = (x0, row, len) => {
    for (let cx = x0; cx < x0 + len; cx++) if (at(cx, row) !== EMPTY) return false;
    return true;
  };
  const areaEmpty = (x0, y0, w, h) => {
    for (let cy = y0; cy < y0 + h; cy++) {
      for (let cx = x0; cx < x0 + w; cx++) if (at(cx, cy) !== EMPTY) return false;
    }
    return true;
  };

  // Border: ceiling, bedrock, and both side walls — all four are wall-jumpable.
  for (let cx = 0; cx < COLS; cx++) {
    set(cx, CEIL_ROW, SOLID);
    set(cx, FLOOR_ROW, SOLID);
    set(cx, BEDROCK_ROW, SOLID);
  }
  for (let cy = 0; cy < ROWS; cy++) {
    set(0, cy, SOLID);
    set(COLS - 1, cy, SOLID);
  }

  // Dividers: walls that block the straight line to the goal — one rising from the
  // floor (climb it: wall kicks), the next hanging from the ceiling (duck under), so
  // the way through snakes like a hand-built Meat Boy room instead of a staircase.
  const barriers = [];
  if (cfg.dividers) {
    const nb = ri(cfg.dividers[0], cfg.dividers[1]);
    let fromFloor = true;
    for (let k = 0; k < nb; k++) {
      const x = Math.round(((k + 1) * COLS) / (nb + 1)) + ri(-2, 2);
      if (x < 7 || x > COLS - 5) continue;
      if (fromFloor) {
        const top = ri(TOP_ROW + 4, FLOOR_ROW - 5);
        for (let cy = top; cy < FLOOR_ROW; cy++) set(x, cy, SOLID);
      } else {
        const bottom = ri(FLOOR_ROW - 7, FLOOR_ROW - 4);
        for (let cy = CEIL_ROW + 1; cy <= bottom; cy++) set(x, cy, SOLID);
      }
      barriers.push({ x, fromFloor });
      fromFloor = !fromFloor;
    }
  }
  // Spike pits in the floor.
  const pits = fewer(ri(cfg.pits[0], cfg.pits[1]));
  for (let i = 0; i < pits; i++) {
    const w = ri(1, 3);
    const x0 = ri(7, COLS - 3 - w);
    for (let cx = x0; cx < x0 + w; cx++) set(cx, FLOOR_ROW, SPIKE_UP);
  }

  // A ledge needs two clear rows of headroom above it and one clear row below, so
  // you can stand on it, jump off it, and so it never fuses to the ledge beneath.
  const ledges = [];
  const placeLedge = (x0, row, len) => {
    if (x0 < 1 || x0 + len > COLS - 1 || row < TOP_ROW || row > FLOOR_ROW - 2) return false;
    if (!spanEmpty(x0, row, len) || !spanEmpty(x0, row - 1, len)) return false;
    if (!spanEmpty(x0, row - 2, len) || !spanEmpty(x0, row + 1, len)) return false;
    const flankOk = (cx) => cx <= 0 || cx >= COLS - 1 || at(cx, row) === EMPTY;
    if (!flankOk(x0 - 1) || !flankOk(x0 + len)) return false;
    for (let cx = x0; cx < x0 + len; cx++) set(cx, row, SOLID);
    ledges.push({ x0, len, row });
    return true;
  };

  // A deliberate climbing chain: ledges stepped 2-3 rows apart and within one jump
  // of each other, so the room always has a route upward.  Scattering ledges at
  // random instead leaves isolated perches nothing can reach, and the goal then
  // settles back down near the floor and the room becomes "hold right".
  let chainTop = FLOOR_ROW;
  {
    let dir = rng() < 0.5 ? 1 : -1;
    const flipAt = ri(1, 2); // a switchback: the climb turns back on itself
    let cx = dir > 0 ? ri(3, 8) : ri(COLS - 9, COLS - 4);
    let row = FLOOR_ROW - ri(2, 3);
    for (let k = 0; k < ri(cfg.chain[0], cfg.chain[1]); k++) {
      const len = ri(2, 4);
      // One nudge sideways before abandoning the chain, so a single blocked step
      // doesn't cost the whole climb.
      if (!placeLedge(cx, row, len) && !placeLedge(cx + dir * 2, row, len)) break;
      chainTop = Math.min(chainTop, row);
      if (k === flipAt) { dir = -dir; cx += dir * ri(1, 2); } else cx += dir * ri(3, 5);
      row -= ri(2, 3);
      if (row < TOP_ROW || cx < 1 || cx > COLS - 3) break;
    }
  }

  // A wall-jump chimney: two pillars a couple of tiles apart that you climb by
  // alternating kicks.  Their tops are standing surfaces, so the shaft doubles as a
  // route to a high goal.  No cap on top — that would trap you inside it.
  if (cfg.shaft) {
    for (let tries = 0; tries < 80; tries++) {
      const gap = ri(2, 3);
      const h = ri(5, 9);
      const col = ri(2, COLS - 4 - gap);
      const top = ri(TOP_ROW + 1, FLOOR_ROW - 2 - h);
      if (top < TOP_ROW + 1) continue;
      if (!areaEmpty(col - 1, top - 1, gap + 4, h + 2)) continue;
      for (let cy = top; cy < top + h; cy++) {
        set(col, cy, SOLID);
        set(col + gap + 1, cy, SOLID);
      }
      break;
    }
  }

  // Everything else is scatter, to give the room texture and alternate routes.
  const wantLedges = ri(cfg.ledges[0], cfg.ledges[1]);
  for (let tries = 0; tries < 500 && ledges.length < wantLedges; tries++) {
    placeLedge(ri(1, COLS - 3), ri(TOP_ROW, FLOOR_ROW - 2), ri(2, cfg.ledgeMax));
  }
  // Planks: some ledges become one-way — jump up through them, land on top.  Routes
  // can now go *through* a ledge instead of around it.  (Before any spikes are hung,
  // so a plank never carries them.)
  if (cfg.planks) {
    for (const l of ledges) {
      if (rng() >= cfg.planks) continue;
      for (let cx = l.x0; cx < l.x0 + l.len; cx++) set(cx, l.row, ONEWAY);
    }
  }
  // On/off rooms: some ledges become red or blue blocks that swap solid and ghost on
  // every jump, so the route is a little puzzle — which jump lands you on which colour.
  if (switchy) {
    let c = rng() < 0.5 ? SWITCH_A : SWITCH_B;
    for (const l of ledges) {
      if (at(l.x0, l.row) === ONEWAY || rng() >= 0.85) continue;
      for (let cx = l.x0; cx < l.x0 + l.len; cx++) set(cx, l.row, c);
      c = c === SWITCH_A ? SWITCH_B : SWITCH_A; // alternate: both colours in every switch room
    }
  }
  // Conveyor rooms: a ledge or two and a stretch of floor become belts, pushing both
  // ways — ride one into a long jump, or fight it.  (Before spikes, springs and the
  // goal are placed: all of those need plain solid, so none ever sit on a belt.)
  if (belty) {
    let b = rng() < 0.5 ? BELT_L : BELT_R;
    let n = 0;
    for (const l of ledges) {
      if (n >= 2 || l.len < 3 || at(l.x0, l.row) !== SOLID || (n && rng() >= 0.5)) continue;
      for (let cx = l.x0; cx < l.x0 + l.len; cx++) set(cx, l.row, b);
      b = b === BELT_L ? BELT_R : BELT_L;
      n++;
    }
    // a stretch of floor, early in the room where every route starts — mostly pushing
    // on toward the far side (where goals tend to be), so riding it is the fast line
    const fb = rng() < 0.7 ? BELT_R : BELT_L;
    for (let tries = 0; tries < 12; tries++) {
      const len = ri(4, 7);
      const x0 = ri(4, Math.min(16, COLS - 2 - len)); // clear of the spawn tile
      let ok = true;
      for (let cx = x0; cx < x0 + len; cx++) if (at(cx, FLOOR_ROW) !== SOLID || at(cx, FLOOR_ROW - 1) !== EMPTY) ok = false;
      if (!ok) continue;
      for (let cx = x0; cx < x0 + len; cx++) set(cx, FLOOR_ROW, fb);
      break;
    }
  }

  // Free-floating pillars: a gap on each side and underneath, so both faces kick.
  const wantPillars = ri(cfg.pillars[0], cfg.pillars[1]);
  let pillarsMade = 0;
  for (let tries = 0; tries < 400 && pillarsMade < wantPillars; tries++) {
    const h = ri(3, 7);
    const col = ri(3, COLS - 4);
    const top = ri(TOP_ROW + 1, FLOOR_ROW - 1 - h);
    if (top < TOP_ROW + 1) continue;
    if (!areaEmpty(col - 1, top - 1, 3, h + 2)) continue;
    for (let cy = top; cy < top + h; cy++) set(col, cy, SOLID);
    pillarsMade++;
  }

  // Spike strips on top of ledges — never the whole ledge, so there's always a landing.
  for (const L of ledges) {
    if (L.len < 3 || at(L.x0, L.row) !== SOLID) continue; // planks and on/off blocks never carry spikes
    if (rng() > cfg.topSpikes * (1 - 0.6 * relax)) continue;
    const sl = Math.min(L.len - 2, ri(1, 2));
    if (sl < 1) continue;
    const sx = L.x0 + ri(1, L.len - sl - 1);
    for (let cx = sx; cx < sx + sl; cx++) if (at(cx, L.row - 1) === EMPTY) set(cx, L.row - 1, SPIKE_UP);
  }

  // Ceiling spikes.
  let ceil = fewer(cfg.ceilSpikes);
  for (let tries = 0; tries < 400 && ceil > 0; tries++) {
    const cx = ri(2, COLS - 3);
    const cy = ri(TOP_ROW, FLOOR_ROW - 2);
    if (at(cx, cy) !== EMPTY || at(cx, cy - 1) !== SOLID || at(cx, cy + 1) !== EMPTY) continue;
    set(cx, cy, SPIKE_DOWN);
    ceil--;
  }

  // Wall spikes, so wall-jumping isn't a free ride.
  let wall = fewer(cfg.wallSpikes);
  for (let tries = 0; tries < 400 && wall > 0; tries++) {
    const cx = ri(2, COLS - 3);
    const cy = ri(TOP_ROW, FLOOR_ROW - 1);
    if (at(cx, cy) !== EMPTY) continue;
    if (at(cx - 1, cy) === SOLID && at(cx + 1, cy) === EMPTY) { set(cx, cy, SPIKE_RIGHT); wall--; }
    else if (at(cx + 1, cy) === SOLID && at(cx - 1, cy) === EMPTY) { set(cx, cy, SPIKE_LEFT); wall--; }
  }

  // Saws, only in open space: a clear tile of margin all around the patrol line.
  const saws = [];
  const wantSaws = cfg.saws ? fewer(ri(cfg.saws[0], cfg.saws[1])) : 0;
  for (let tries = 0; tries < 400 && saws.length < wantSaws; tries++) {
    const horiz = rng() < 0.6;
    const len = ri(3, horiz ? 8 : 5);
    const cx = ri(2, COLS - 3);
    const cy = ri(TOP_ROW + 1, FLOOR_ROW - 1);
    const ex = horiz ? cx + len : cx;
    const ey = horiz ? cy : cy + len;
    if (ex > COLS - 2 || ey > FLOOR_ROW - 1) continue;
    if (!areaEmpty(Math.min(cx, ex) - 1, Math.min(cy, ey) - 1, Math.abs(ex - cx) + 3, Math.abs(ey - cy) + 3)) continue;
    saws.push({
      x0: cx * TILE + TILE / 2, y0: cy * TILE + TILE / 2,
      x1: ex * TILE + TILE / 2, y1: ey * TILE + TILE / 2,
      r: 15, speed: 0.45 + rng() * 0.6, phase: rng(),
    });
  }

  // Springs: a few platform tops (or floor) turned into launch pads, with tall clear
  // air above.  Placed before the goal is chosen, so routes can use them — and the
  // room's shape (dividers, a high goal) usually makes them worth using.
  if (cfg.springs) {
    let want = ri(cfg.springs[0], cfg.springs[1]);
    // First choice: the floor just before a wall rising from the floor — launch over
    // it, or climb it with kicks.  Two ways through is what makes a room fun.
    for (const b of barriers) {
      if (!want || !b.fromFloor) continue;
      const cx = b.x - ri(2, 3);
      if (cx > 4 && at(cx, FLOOR_ROW) === SOLID && areaEmpty(cx, FLOOR_ROW - 4, 1, 4)) { set(cx, FLOOR_ROW, SPRING); want--; }
    }
    const spots = [];
    for (let cy = TOP_ROW + 4; cy <= FLOOR_ROW; cy++) {
      for (let cx = 5; cx < COLS - 2; cx++) {
        if (at(cx, cy) !== SOLID || !areaEmpty(cx, cy - 4, 1, 4)) continue;
        spots.push({ cx, cy });
      }
    }
    for (let k = 0; k < want && spots.length; k++) {
      const { cx, cy } = spots.splice(Math.floor(rng() * spots.length), 1)[0];
      if (at(cx - 1, cy) === SPRING || at(cx + 1, cy) === SPRING) continue;
      set(cx, cy, SPRING);
    }
  }
  // Updrafts: columns of rising air (2 tiles wide) from the floor or a ledge top up into
  // open sky — float up instead of jumping.  Only where the column is completely clear.
  const updrafts = [];
  if (cfg.updrafts) {
    let want = ri(cfg.updrafts[0], cfg.updrafts[1]);
    for (let tries = 0; tries < 200 && want > 0; tries++) {
      const cx = ri(5, COLS - 4);
      const base = ri(FLOOR_ROW - 6, FLOOR_ROW - 1); // the column's lowest row
      const h = ri(5, 8);
      const top = base - h + 1;
      if (top < TOP_ROW + 1 || !areaEmpty(cx, top, 2, h)) continue;
      if (at(cx, base + 1) === EMPTY && at(cx + 1, base + 1) === EMPTY) continue; // must start on something
      updrafts.push({ x: cx * TILE, y: top * TILE, w: 2 * TILE, h: h * TILE });
      want--;
    }
  }
  // Spawn pad: cols 1-3 are always solid floor with clear air above.
  const spawnCol = 2;
  for (let cx = 1; cx <= 3; cx++) {
    set(cx, FLOOR_ROW, SOLID);
    for (let cy = FLOOR_ROW - 3; cy < FLOOR_ROW; cy++) set(cx, cy, EMPTY);
  }
  const spawn = { x: spawnCol * TILE + (TILE - PLAYER_W) / 2, y: FLOOR_ROW * TILE - PLAYER_H };

  // A blade parked on the spawn pad makes every goal unreachable, so drop those
  // before anything else.  A blade covering the goal needs no special case: the
  // solver simply can't reach that spot, and the spot gets skipped.
  const onSpawn = (s) => {
    const box = { x: spawn.x - 20, y: spawn.y - 40, w: PLAYER_W + 40, h: PLAYER_H + 40 };
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      if (circleHitsRect(s.x0 + (s.x1 - s.x0) * u, s.y0 + (s.y1 - s.y0) * u, s.r + 10, box)) return true;
    }
    return false;
  };
  const keptSaws = saws.filter((s) => !onSpawn(s));

  // Candidate goal spots: a standing surface with two clear rows above it, far from
  // spawn, biased upward by difficulty.  Requiring both rows clear also guarantees
  // the goal marker can never overlap a spike, since it sits inside this one column.
  const candidates = [];
  for (let cy = TOP_ROW; cy <= FLOOR_ROW; cy++) {
    for (let cx = 1; cx < COLS - 1; cx++) {
      if (at(cx, cy) !== SOLID) continue;
      if (at(cx, cy - 1) !== EMPTY || at(cx, cy - 2) !== EMPTY) continue;
      // The goal has to be off the ground.  A goal on the floor scores well on raw
      // distance and turns the whole room into "hold right", which is how the first
      // version of this kept producing walk-to-the-corner levels.
      const height = FLOOR_ROW - cy;
      if (height < cfg.goalMinHeight) continue;
      if (Math.abs(cx - spawnCol) < 6 && height < 6) continue; // nor right above spawn
      // Height is worth more than distance here.  Weighted evenly, horizontal
      // distance (up to 28 tiles) swamps height (up to 14), and the far-right
      // low ledge beats the top of a chimney every time.
      const beyond = barriers.length && cx > barriers[barriers.length - 1].x ? 10 : 0; // past the last divider
      candidates.push({ cx, cy, score: Math.abs(cx - spawnCol) * 0.5 + height * cfg.goalHeightBias + beyond });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;
  const goalRectFor = (c) => ({ x: c.cx * TILE + (TILE - 22) / 2, y: c.cy * TILE - 34, w: 22, h: 34 });

  // Point the search at the best candidate, then take the best one it actually
  // reached.  Candidates are sorted, so the first hit is the best available.
  const room = finishRoom(grid, keptSaws, spawn, null, cfg, levelIndex, seed, twist);
  if (updrafts.length) room.updrafts = updrafts;
  room.noCornerKick = true;
  room.searchPad = cfg.safetyPad;
  const reach = reachSurfaces(room, goalRectFor(candidates[0]), GOAL_SEARCH_BUDGET);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const node = reach.surfaces.get(c.cy * COLS + c.cx);
    if (node === undefined) continue;
    room.goal = goalRectFor(c);
    room.bot = { chunks: node.g, time: node.g * CHUNK_T, expanded: reach.expanded };
    room.goalRank = i;

    // Everything that decides the room's shape — where the goal goes, which route the
    // hazards line — runs with corner kicks switched off, so no room ever *requires*
    // a 3-frame trick.  Corner kicks come back for the ghost below.
    const actions = routeActions(node);
    const before = traceRoute(room, actions);
    if (!before) return null; // can't happen: the search just walked this route
    const savedGrid = room.grid.slice();
    const savedSaws = room.saws.slice();
    const keepClear = (cx, cy) =>
      (cx <= 3 && cy >= FLOOR_ROW - 3) ||               // spawn pad
      (cx === c.cx && (cy === c.cy - 1 || cy === c.cy - 2)); // goal marker
    room.routeHazards = decorateRoute(room, before.rects, rng, cfg, keepClear);
    // Belt and braces: replay the exact route through the decorated room.  If it
    // somehow dies, ship the undecorated (still proven) room instead.
    if (!traceRoute(room, actions)) {
      room.grid = savedGrid;
      room.saws = savedSaws;
      room.botMask = buildBotMask(savedSaws);
      room.routeHazards = { spikes: 0, saws: 0, reverted: true };
    }
    room.fairRoute = actions;
    room.searchPad = 0; // the ghost plays with the real hitbox: it's the IMPOSSIBLE line
    // The ghost gets the fastest route with corner kicks allowed.  It may well show
    // one off as a shortcut; the fair route above still exists, so it can't fail.
    room.noCornerKick = false;
    const ghost = solveRoom(room, GHOST_SEARCH_BUDGET);
    room.route = ghost.ok && ghost.chunks <= node.g ? ghost.actions : actions;
    return room;
  }
  return null;
}

// A plain staircase with no hazards. Only used if the generator somehow can't
// produce a room that the solver clears — the day still gets a playable level.
function fallbackRoom(cfg, levelIndex, seed, twist = null) {
  const grid = new Uint8Array(COLS * ROWS);
  const set = (cx, cy, v) => { grid[cy * COLS + cx] = v; };
  for (let cx = 0; cx < COLS; cx++) {
    set(cx, CEIL_ROW, SOLID);
    set(cx, FLOOR_ROW, SOLID);
    set(cx, BEDROCK_ROW, SOLID);
  }
  for (let cy = 0; cy < ROWS; cy++) {
    set(0, cy, SOLID);
    set(COLS - 1, cy, SOLID);
  }
  const steps = [[6, 13], [12, 10], [18, 7], [24, 4]];
  for (const [x0, row] of steps) {
    for (let cx = x0; cx < x0 + 5; cx++) set(cx, row, SOLID);
  }
  const spawn = { x: 2 * TILE + (TILE - PLAYER_W) / 2, y: FLOOR_ROW * TILE - PLAYER_H };
  const goal = { x: 26 * TILE + (TILE - 22) / 2, y: 4 * TILE - 34, w: 22, h: 34 };
  return finishRoom(grid, [], spawn, goal, cfg, levelIndex, seed, twist);
}

// ============================================================
// 🎓 How to play: one handmade room that teaches the moves in order, left to right —
// run, jump (hold for height) over spikes, wall-kick up a chimney, jump up through a
// plank, then red/blue blocks that swap on every jump, up to the goal.  Signs in the
// scenery say what to do.  Solved like any room, so it has a ghost too.
function tutorialLevel() {
  const grid = new Uint8Array(COLS * ROWS);
  const put = (cx, cy, v) => { grid[cy * COLS + cx] = v; };
  for (let cx = 0; cx < COLS; cx++) { put(cx, CEIL_ROW, SOLID); put(cx, FLOOR_ROW, SOLID); put(cx, BEDROCK_ROW, SOLID); }
  for (let cy = 0; cy < ROWS; cy++) { put(0, cy, SOLID); put(COLS - 1, cy, SOLID); }
  put(5, FLOOR_ROW - 1, SOLID);                                   // a step: jump
  put(8, FLOOR_ROW - 1, SPIKE_UP); put(9, FLOOR_ROW - 1, SPIKE_UP); // spikes: jump over
  for (let cy = 9; cy <= 13; cy++) put(11, cy, SOLID);            // chimney: walk in underneath…
  for (let cy = 9; cy < FLOOR_ROW; cy++) put(14, cy, SOLID);      // …and kick up between the walls
  for (let cx = 17; cx <= 19; cx++) put(cx, 13, ONEWAY);          // a plank: jump up through it
  for (let cx = 21; cx <= 22; cx++) put(cx, 10, SWITCH_A);        // red, then blue, swap every jump
  for (let cx = 24; cx <= 25; cx++) put(cx, 7, SWITCH_B);
  for (let cx = 27; cx <= 29; cx++) put(cx, 4, SOLID);            // the goal ledge
  const spawn = { x: 2 * TILE + (TILE - PLAYER_W) / 2, y: FLOOR_ROW * TILE - PLAYER_H };
  const goal = { x: 28 * TILE + (TILE - 22) / 2, y: 4 * TILE - 34, w: 22, h: 34 };
  const room = finishRoom(grid, [], spawn, goal, cfgFor(0), 0, 0x7e57);
  const sol = solveRoom(room, 60000);
  room.route = sol.actions || null;
  room.bot = { chunks: sol.chunks || 0, time: sol.time || 0, expanded: sol.expanded, tutorial: true };
  room.ghostTime = room.route ? ghostTimeOf(room) : 0;
  room.signs = [
    { x: 4.4, y: 13.2, text: '→ run   ·   jump (hold = higher)' },
    { x: 6.6, y: 11.6, text: 'spikes: deaths are free, R restarts' },
    { x: 12.5, y: 7.6, text: 'slide on a wall, jump to kick off it' },
    { x: 12.5, y: 8.3, text: 'kick from wall to wall to climb ↑' },
    { x: 19.6, y: 15.2, text: 'planks: jump up through them' },
    { x: 24.6, y: 12.1, text: 'every jump swaps ● red and ■ blue' },
    { x: 24.6, y: 12.8, text: 'not solid? jump in place to swap' },
    { x: 28.5, y: 2.3, text: 'goal ★' },
  ];
  return room;
}

// Key & lock — in some rooms the goal starts locked: grab the 🔑 first.  A detour by
// design: the key sits off the straight line, so the route goes there and back.  The
// key is part of the simulation (player.hasKey), so the solver proves the whole
// spawn → key → goal route with the same fairness rules as any room.
// ============================================================
const KEY_SIZE = 20;
const KEY_TRIES = 4;
const KEY_LEG_BUDGET = 9000;

function placeKey(room, seed) {
  const cfg = room.cfg;
  const rng = mulberry32((seed ^ 0x6b3e) >>> 0);
  if (!cfg.lockChance || rng() >= cfg.lockChance || !room.fairRoute) return;
  const saved = { route: room.route, fairRoute: room.fairRoute, ghostTime: room.ghostTime, bot: room.bot, pad: room.searchPad, kick: room.noCornerKick };
  room.searchPad = cfg.safetyPad;
  room.noCornerKick = true;
  const trace = traceRoute(room, room.fairRoute);
  const nearSpike = (cx, cy) => {
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) if (isSpike(cellAt(room, x, y))) return true;
    return false;
  };
  const cands = [];
  for (let cy = CEIL_ROW + 2; cy < FLOOR_ROW && trace; cy++) {
    for (let cx = 2; cx < COLS - 2; cx++) {
      if (cellAt(room, cx, cy) !== EMPTY || nearSpike(cx, cy)) continue;
      if (room.botMask && room.botMask[cy * COLS + cx]) continue;
      const rect = { x: cx * TILE + (TILE - KEY_SIZE) / 2, y: cy * TILE + (TILE - KEY_SIZE) / 2, w: KEY_SIZE, h: KEY_SIZE };
      if (rectGap(rect, room.goal) < 150 || rectGap(rect, { x: room.spawn.x, y: room.spawn.y, w: PLAYER_W, h: PLAYER_H }) < 90) continue;
      const d = gapToRoute(rect, trace.rects);
      if (d < 90 || d > 360) continue; // a real detour, not across the whole room
      cands.push({ rect, score: d * 0.5 + rectGap(rect, room.goal) * 0.2 + rng() * 60 });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  // Two searches, like the shard's: spawn → key, then key → goal from the exact state
  // the key was picked up in.  One search over both legs runs out of budget.
  const twoLegs = (pad, noKick, budget) => {
    room.searchPad = pad;
    room.noCornerKick = noKick;
    const a = solveRoom(room, budget, { goal: room.key });
    if (!a.ok) return null;
    const p = makePlayer(room.spawn);
    p.jumpHeldPrev = false;
    if (!runChunks(room, p, a.actions) || !p.hasKey) return null;
    const b = solveRoom(room, budget, { start: p, goal: room.goal });
    if (!b.ok) return null;
    return { actions: a.actions.concat(b.actions), chunks: a.chunks + b.chunks };
  };
  // Which spots can be reached at all: one broad search (as for shards), with the room
  // still unlocked so finishing it on the way doesn't count.  Then the best few must
  // also lead on to the goal, key in hand.
  room.key = null;
  room.searchPad = cfg.safetyPad;
  room.noCornerKick = true;
  const touched = reachShards(room, cands, SHARD_REACH_BUDGET);
  touched.sort((a, b) => b.cand.score - a.cand.score);
  for (let i = 0; i < touched.length && i < KEY_TRIES; i++) {
    room.key = touched[i].cand.rect;
    room.searchPad = cfg.safetyPad;
    room.noCornerKick = true;
    const end = clonePlayer(touched[i].end);
    end.hasKey = true;
    const legB = solveRoom(room, KEY_LEG_BUDGET, { start: end, goal: room.goal });
    if (!legB.ok) continue;
    const fair = { actions: touched[i].actions.concat(legB.actions), chunks: touched[i].actions.length + legB.chunks };
    room.fairRoute = fair.actions;
    room.bot = { ...saved.bot, chunks: fair.chunks, time: fair.chunks * CHUNK_T };
    room.searchPad = cfg.safetyPad;
    room.noCornerKick = true;
    if (cfg.tolerance && toleranceOf(room, (seed ^ 0x7015) >>> 0) < cfg.tolerance) continue;
    const ghost = twoLegs(0, false, GHOST_SEARCH_BUDGET);
    room.searchPad = 0;
    room.noCornerKick = false;
    room.route = ghost && ghost.chunks <= fair.chunks ? ghost.actions : fair.actions;
    room.ghostTime = ghostTimeOf(room);
    if (!(room.ghostTime > 0)) continue;
    return; // locked
  }
  // no fair key spot: the room stays unlocked, exactly as it was
  room.key = null;
  room.route = saved.route;
  room.fairRoute = saved.fairRoute;
  room.ghostTime = saved.ghostTime;
  room.bot = saved.bot;
  room.searchPad = saved.pad;
  room.noCornerKick = saved.kick;
}

// ============================================================
// Shards — one optional collectible per room (Celeste's strawberries, Meat Boy's
// bandages): placed off the main route, somewhere harder, and only counted if you
// carry it to the goal.  Like the goal, it is proven: the solver finds a fair route
// spawn → shard → goal (same safety pad, no corner kick), so it is never a trick.
// ============================================================
const SHARD_SIZE = 18;
const SHARD_REACH_BUDGET = 12000;
const SHARD_LEG_BUDGET = 6000;
const SHARD_TRIES = 6;

// Uniform-cost search from spawn: for each candidate spot, the first route (whole
// chunks, surviving the chunk it touches the spot in) that reaches it.
function reachShards(level, cands, budget) {
  const byCell = new Map();
  for (const c of cands) byCell.set(Math.floor(c.rect.y / TILE) * COLS + Math.floor(c.rect.x / TILE), c);
  const start = makePlayer(level.spawn);
  start.jumpHeldPrev = false;
  const seen = new Set([stateKey(start)]);
  const open = new Heap();
  open.push(0, { p: start, g: 0, parent: null, ai: -1 });
  const found = new Map(); // cand -> { cand, actions, end }
  let expanded = 0;
  while (open.a.length && expanded < budget && found.size < byCell.size) {
    const node = open.pop().v;
    expanded++;
    for (let ai = 0; ai < BOT_ACTIONS.length; ai++) {
      const [dir, jump] = BOT_ACTIONS[ai];
      const p = clonePlayer(node.p);
      const input = { left: dir < 0, right: dir > 0, jumpHeld: jump === 1, jumpPressed: jump === 1 && !p.jumpHeldPrev };
      let dead = false;
      let hit = null;
      for (let st = 0; st < CHUNK_STEPS; st++) {
        stepPlayer(p, input, level, DT);
        input.jumpPressed = false;
        if (hitsStaticHazard(p, level) || p.y > VIEW_H + 80 || reachedGoal(p, level)) { dead = true; break; }
        if (!hit) {
          const { cx0, cx1, cy0, cy1 } = tileRange(p);
          for (let cy = cy0; cy <= cy1 && !hit; cy++) {
            for (let cx = cx0; cx <= cx1 && !hit; cx++) {
              const c = byCell.get(cy * COLS + cx);
              if (c && !found.has(c) && overlaps(p, c.rect)) hit = c;
            }
          }
        }
      }
      if (dead) continue;
      p.jumpHeldPrev = jump === 1;
      if (hit) found.set(hit, { cand: hit, actions: routeActions(node).concat(ai), end: clonePlayer(p) });
      const k = stateKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      open.push(node.g + 1, { p, g: node.g + 1, parent: node, ai });
    }
  }
  return [...found.values()];
}

// Plays whole route chunks from `p` (mutated); false if the route dies on the way.
function runChunks(level, p, actions) {
  for (const ai of actions) {
    const [dir, jump] = BOT_ACTIONS[ai];
    const input = { left: dir < 0, right: dir > 0, jumpHeld: jump === 1, jumpPressed: jump === 1 && !p.jumpHeldPrev };
    for (let st = 0; st < CHUNK_STEPS; st++) {
      stepPlayer(p, input, level, DT);
      input.jumpPressed = false;
      if (hitsStaticHazard(p, level) || p.y > VIEW_H + 80) return false;
    }
    p.jumpHeldPrev = jump === 1;
  }
  return true;
}

function placeShard(room, seed) {
  if (!room.fairRoute) return;
  const rng = mulberry32((seed ^ 0x5a4d) >>> 0);
  const savedPad = room.searchPad;
  const savedKick = room.noCornerKick;
  room.searchPad = room.cfg.safetyPad;
  room.noCornerKick = true;
  try {
    const trace = traceRoute(room, room.fairRoute);
    if (!trace) return;
    const nearSpike = (cx, cy) => {
      for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) if (isSpike(cellAt(room, x, y))) return true;
      return false;
    };
    const cands = [];
    for (let cy = CEIL_ROW + 2; cy < FLOOR_ROW; cy++) {
      for (let cx = 2; cx < COLS - 2; cx++) {
        if (cellAt(room, cx, cy) !== EMPTY || nearSpike(cx, cy)) continue;
        if (room.botMask && room.botMask[cy * COLS + cx]) continue; // inside a saw's sweep
        const rect = { x: cx * TILE + (TILE - SHARD_SIZE) / 2, y: cy * TILE + (TILE - SHARD_SIZE) / 2, w: SHARD_SIZE, h: SHARD_SIZE };
        if (rectGap(rect, room.goal) < 60) continue;
        if (room.key && rectGap(rect, room.key) < 60) continue; // not on top of the key
        const d = gapToRoute(rect, trace.rects);
        if (d < 70 || d > 300) continue; // off the line, but not across the room
        cands.push({ rect, score: d * 0.4 + (FLOOR_ROW - cy) * 5 + rng() * 40 });
      }
    }
    if (!cands.length) return;
    // One broad search from spawn records the first route that touches each spot
    // (finishing the room on the way doesn't count); then the best few spots it
    // reached must also have a route on to the goal.
    const touched = reachShards(room, cands, SHARD_REACH_BUDGET);
    touched.sort((a, b) => b.cand.score - a.cand.score);
    for (let i = 0; i < touched.length && i < SHARD_TRIES; i++) {
      const { cand, actions, end } = touched[i];
      const legB = solveRoom(room, SHARD_LEG_BUDGET, { start: end, goal: room.goal });
      if (!legB.ok) continue;
      room.shard = cand.rect;
      room.shardRoute = actions.concat(legB.actions);
      return;
    }
  } finally {
    room.searchPad = savedPad;
    room.noCornerKick = savedKick;
  }
}

// How forgiving a room's fair route is to human timing: replay it `tries` times with
// every input change nudged up to ±2 physics steps (about one display frame) and
// count how often it still clears.  Deterministic (seeded), portable math only.
function toleranceOf(room, seed, tries = 48) {
  const route = room.fairRoute || room.route;
  if (!route) return 0;
  const base = []; // per-step left/right/jump-held bits; presses are derived below
  for (const ai of route) {
    const [dir, jump] = BOT_ACTIONS[ai];
    for (let s = 0; s < CHUNK_STEPS; s++) base.push((dir < 0 ? 1 : 0) | (dir > 0 ? 2 : 0) | (jump ? 4 : 0));
  }
  const rng = mulberry32(seed);
  const savedKick = room.noCornerKick;
  room.noCornerKick = true;
  let ok = 0;
  for (let t = 0; t < tries; t++) {
    const m = base.slice();
    for (let i = 1; i < base.length; i++) {
      if (base[i] === base[i - 1]) continue;
      const d = Math.round((rng() * 2 - 1) * 2);
      if (d > 0) for (let k = i; k < Math.min(base.length, i + d); k++) m[k] = base[i - 1];
      else if (d < 0) for (let k = Math.max(1, i + d); k < i; k++) m[k] = base[i];
    }
    const p = makePlayer(room.spawn);
    let clock = 0;
    let prevJump = false;
    for (let s = 0; s < m.length + 240; s++) {
      const mm = s < m.length ? m[s] : 0;
      const jumpHeld = (mm & 4) !== 0;
      clock += DT;
      stepPlayer(p, { left: (mm & 1) !== 0, right: (mm & 2) !== 0, jumpHeld, jumpPressed: jumpHeld && !prevJump }, room, DT);
      prevJump = jumpHeld;
      if (hitsHazard(p, room, clock)) break;
      if (reachedGoal(p, room)) { ok++; break; }
    }
  }
  room.noCornerKick = savedKick;
  return ok / tries;
}

// Direction reversals + wall kicks the fastest fair route needs: the "shape" of a
// room.  A straight run of hops scores 0; a switchback climb with a chimney, 4+.
// A switch room whose winning line never touches a red or blue block: turn something
// the line does use into one — a ledge or pillar top it lands on, or a short pillar it
// wall-kicks off — in the colour that's solid at that moment, and keep it only if the
// very same line still wins.  No new search: the ghost's own route proves the room.
function switchifyRoute(room) {
  const gx = Math.floor((room.goal.x + room.goal.w / 2) / TILE);
  const gy = Math.floor((room.goal.y + room.goal.h + 1) / TILE);
  const free = (x, y) => cellAt(room, x, y) === EMPTY;
  const cands = [];
  const seen = new Set();
  const add = (cells, color) => {
    const k = cells.map(([x, y]) => y * COLS + x).join(',');
    if (!seen.has(k)) { seen.add(k); cands.push({ cells, color }); }
  };
  const gh = makeGhost(room);
  let contact = null; // the last wall you touched: a kick can come a little after (wall coyote)
  while (!gh.done && cands.length < 8) {
    const before = gh.i;
    stepGhost(gh, room);
    if (gh.i === before) break;
    const p = gh.p;
    const kickWall = contact;
    contact = wallContact(p) || (p.onGround ? null : contact);
    const color = p.phase ? SWITCH_B : SWITCH_A; // solid right now
    if (p.landed) {
      const cy = Math.floor((p.y + p.h + 1) / TILE);
      if (cy >= FLOOR_ROW) continue;
      for (const cx of [Math.floor(p.x / TILE), Math.floor((p.x + p.w - 0.001) / TILE)]) {
        if (cellAt(room, cx, cy) !== SOLID || (gy === cy && Math.abs(gx - cx) <= 6)) continue;
        if (cellAt(room, cx, cy + 1) === SOLID) { // a pillar top: just its top tile
          if (free(cx, cy - 1) && free(cx - 1, cy) && free(cx + 1, cy)) add([[cx, cy]], color);
          continue;
        }
        let x0 = cx;
        let x1 = cx;
        while (cellAt(room, x0 - 1, cy) === SOLID) x0--;
        while (cellAt(room, x1 + 1, cy) === SOLID) x1++;
        if (x1 - x0 + 1 > 6 || x0 <= 0 || x1 >= COLS - 1 || !free(x0 - 1, cy) || !free(x1 + 1, cy)) continue;
        const cells = [];
        let ok = true;
        for (let x = x0; x <= x1; x++) {
          if (!free(x, cy - 1) || !free(x, cy + 1)) ok = false; // floating, nothing mounted on it
          cells.push([x, cy]);
        }
        if (ok) add(cells, color);
      }
    }
    if (p.wallJumped && kickWall) { // the wall it kicked off: a short free-standing pillar
      // the kick already flipped the phase: the wall was solid in the one before
      const wallColor = p.phase ? SWITCH_A : SWITCH_B;
      const { cx, cy } = kickWall;
      if (cx <= 0 || cx >= COLS - 1 || cellAt(room, cx, cy) !== SOLID) continue;
      let y0 = cy;
      let y1 = cy;
      while (cellAt(room, cx, y0 - 1) === SOLID) y0--;
      while (cellAt(room, cx, y1 + 1) === SOLID && y1 + 1 < FLOOR_ROW) y1++;
      if (y1 - y0 + 1 > 5 || y0 <= TOP_ROW || !free(cx, y0 - 1)) continue;
      const cells = [];
      let ok = true;
      for (let y = y0; y <= y1; y++) {
        if (!free(cx - 1, y) || !free(cx + 1, y)) ok = false; // nothing mounted on either face
        cells.push([cx, y]);
      }
      if (gy >= y0 - 1 && gy <= y1 && gx === cx) ok = false; // the goal stands on it
      if (ok && free(cx, y1 + 1)) add(cells, wallColor); // floating, so it never props up anything
    }
  }
  for (const c of cands) {
    for (const [x, y] of c.cells) room.grid[y * COLS + x] = c.color;
    const t = ghostTimeOf(room);
    if (t > 0 && Math.abs(t - room.ghostTime) < 1e-9 && switchLandings(room) > 0 && fairRouteWins(room)) return true;
    for (const [x, y] of c.cells) room.grid[y * COLS + x] = SOLID;
  }
  return false;
}

// The room's fair route (no corner kicks) still reaches the goal: no room may need one.
function fairRouteWins(room) {
  if (!room.fairRoute) return true;
  const kick = room.noCornerKick;
  room.noCornerKick = true;
  try {
    const t = traceRoute(room, room.fairRoute);
    return !!t && t.rects.some((r) => overlaps(r, room.goal));
  } finally { room.noCornerKick = kick; }
}

// How many times the ghost's route uses an on/off block: lands on one, or wall-kicks
// off one.
function switchLandings(room) {
  const gh = makeGhost(room);
  let n = 0;
  let contact = null;
  while (!gh.done) {
    const before = gh.i;
    stepGhost(gh, room);
    if (gh.i === before) break;
    const p = gh.p;
    if (p.wallJumped && contact && isSwitch(cellAt(room, contact.cx, contact.cy))) n++;
    contact = wallContact(p) || (p.onGround ? null : contact);
    if (p.landed) {
      const cy = Math.floor((p.y + p.h + 1) / TILE);
      for (let cx = Math.floor(p.x / TILE); cx <= Math.floor((p.x + p.w - 0.001) / TILE); cx++) {
        if (isSwitch(cellAt(room, cx, cy))) { n++; break; }
      }
    }
  }
  return n;
}

// The wall cell you're touching (beside your middle), if any.
function wallContact(p) {
  if (!p.wallLeft && !p.wallRight) return null;
  const cx = p.wallLeft ? Math.floor((p.x - 2) / TILE) : Math.floor((p.x + p.w + 2 - 0.001) / TILE);
  return { cx, cy: Math.floor((p.y + p.h / 2) / TILE) };
}

function turnsOf(room) {
  const savedPad = room.searchPad;
  const savedKick = room.noCornerKick;
  room.searchPad = room.cfg.safetyPad;
  room.noCornerKick = true;
  try {
    const sol = solveRoom(room, GOAL_SEARCH_BUDGET);
    const actions = sol.ok ? sol.actions : room.fairRoute;
    const p = makePlayer(room.spawn);
    p.jumpHeldPrev = false;
    let last = 0;
    let turns = 0;
    for (const ai of actions) {
      const [dir, jump] = BOT_ACTIONS[ai];
      if (dir && last && dir !== last) turns++;
      if (dir) last = dir;
      const input = { left: dir < 0, right: dir > 0, jumpHeld: jump === 1, jumpPressed: jump === 1 && !p.jumpHeldPrev };
      for (let st = 0; st < CHUNK_STEPS; st++) {
        stepPlayer(p, input, room, DT);
        input.jumpPressed = false;
        if (p.wallJumped) turns++;
      }
      p.jumpHeldPrev = jump === 1;
    }
    return turns;
  } finally {
    room.searchPad = savedPad;
    room.noCornerKick = savedKick;
  }
}

function generateLevel(seed, levelIndex, twist = null) {
  const cfg = cfgFor(levelIndex);
  let lastReason = null;
  let spare = null; // the best real room turned down so far: beats the plain fallback
  // Whether this room has on/off blocks is decided once, not per attempt: otherwise
  // every rejected try would fall back to a plain room and they'd almost never ship.
  const switchy = !!cfg.switchRooms && mulberry32((seed ^ 0x5e1c4) >>> 0)() < cfg.switchRooms;
  const belty = !!cfg.beltRooms && mulberry32((seed ^ 0xbe17) >>> 0)() < cfg.beltRooms;
  for (let attempt = 0; attempt < cfg.attempts; attempt++) {
    const relax = attempt / cfg.attempts;
    const rng = mulberry32((seed ^ Math.imul(attempt + 1, 0x9e3779b1)) >>> 0);
    const room = buildRoom(rng, cfg, levelIndex, seed, relax, twist, switchy, belty);
    if (!room) { lastReason = 'no-reachable-goal'; continue; }
    // The ghost's line must win under the *real* physics (corner kicks on): a fair
    // route proven with them off can brush a ledge corner, trigger one by accident and
    // fly off course.  Such a room is no good, not even as the spare.
    room.ghostTime = ghostTimeOf(room);
    if (!(room.ghostTime > 0)) { lastReason = 'ghost-fails'; continue; }
    // The difficulty floor eases off as attempts run out, so a stubborn seed still ships.
    const floor = Math.round(cfg.minChunks * (1 - 0.35 * relax));
    const lined = room.routeHazards ? room.routeHazards.spikes + room.routeHazards.saws : 0;
    // The spare (shipped if every attempt is turned down) also favours turny routes —
    // but counting turns costs a whole extra solve, so cheap rejects go first.
    const keepSpare = (turns) => {
      const merit = lined + room.bot.chunks / 4 + turns * 6 + (room.switches ? Math.min(3, switchLandings(room)) * 5 : 0);
      if (!spare || merit > spare.merit) spare = { room, merit, attempt };
    };
    if (room.bot.chunks < floor) { keepSpare(0); lastReason = 'too-easy'; continue; }
    // A route lined with far fewer hazards than the room asked for makes a soft "hard
    // room" (it happens when the geometry leaves no room for them): try again while
    // there are attempts to spare.
    if (relax < 0.7 && lined < 0.7 * (cfg.routeSpikes + cfg.routeSaws)) { keepSpare(0); lastReason = 'too-tame'; continue; }
    const turns = turnsOf(room);
    keepSpare(turns);
    // "Not just straight jumps": the fastest route must turn back or wall-kick enough.
    // The bar eases as attempts run out, but never below one turn.
    if (cfg.minTurns && turns < Math.max(1, Math.ceil(cfg.minTurns * (1 - relax)))) { lastReason = 'too-straight'; continue; }
    // A route that only works with frame-exact timing isn't fair, however much clearance
    // it keeps: replay it with human-sized timing wobble and require it to survive often
    // enough (cfg.tolerance) while attempts remain.  The bonus room has no such floor.
    // An on/off room whose winning route never lands on a red or blue block only has
    // them as scenery: try again while attempts remain.
    if (room.switches && relax < 0.7 && !switchLandings(room) && !switchifyRoute(room)) { lastReason = 'switches-unused'; continue; }
    if (cfg.tolerance && relax < 0.7 && toleranceOf(room, (seed ^ 0x7015) >>> 0) < cfg.tolerance) { lastReason = 'fragile'; continue; }
    room.bot.attempt = attempt;
    if (room.switches && !switchLandings(room)) switchifyRoute(room); // late attempts: still try to use them
    placeKey(room, seed);
    if (room.key && room.switches && !switchLandings(room)) switchifyRoute(room); // the key reroutes the line
    placeShard(room, seed);
    return room;
  }
  if (spare) { // out of attempts: ship the best real room seen, not the plain staircase
    spare.room.bot.attempt = spare.attempt;
    if (spare.room.switches && !switchLandings(spare.room)) switchifyRoute(spare.room);
    placeKey(spare.room, seed);
    if (spare.room.key && spare.room.switches && !switchLandings(spare.room)) switchifyRoute(spare.room);
    placeShard(spare.room, seed);
    return spare.room;
  }
  const room = fallbackRoom(cfg, levelIndex, seed, twist);
  const sol = solveRoom(room, 60000);
  room.route = sol.actions || null;
  room.bot = { chunks: sol.chunks || 0, time: sol.time || 0, expanded: sol.expanded, fallback: true, reason: lastReason };
  room.ghostTime = ghostTimeOf(room);
  return room;
}

// ============================================================
// Stored levels — a room frozen exactly as it was published
// ============================================================
// Generation keeps evolving, so a day's rooms can't be "regenerated later": the
// server stores each room once (serializeLevel) and everyone, forever after, plays
// and is verified against that copy (deserializeLevel).  Bump GENERATOR_VERSION
// whenever generation changes, so stored rows say which generator built them.
const GENERATOR_VERSION = '2026-10-13.16'; // .1: safety pad; .2: no tame rooms/plain fallbacks; .3: timing tolerance; .4: shards; .5: dividers, switchbacks, min turns; .6: springs; .7: daily twists; .8: key & lock; .9: exact key heuristic, spring-only climb speed; .10: one-way planks; .11: no spikes on planks, exact plank resting; .12: updrafts; .13: more turns (2/3/4/4), never a straight room; .14: on/off switch blocks; .15: switch blocks steered onto the winning line; .16: conveyor belts

function serializeLevel(lv) {
  return {
    v: 1,
    grid: String.fromCharCode(...Array.from(lv.grid, (v) => 48 + v)), // one char per tile: '0'..'9', then ':' ';'
    saws: lv.saws,
    spawn: lv.spawn,
    goal: lv.goal,
    route: lv.route,
    ghostTime: lv.ghostTime,
    hillSeed: lv.hillSeed,
    bot: lv.bot,
    goalRank: lv.goalRank,
    routeHazards: lv.routeHazards,
    ...(lv.shard ? { shard: lv.shard, shardRoute: lv.shardRoute } : {}), // rooms from before shards have none
    ...(lv.twist ? { twist: lv.twist } : {}),
    ...(lv.key ? { key: lv.key } : {}),
    ...(lv.updrafts ? { updrafts: lv.updrafts } : {}),
    ...(lv.liftFix ? { lift: 2 } : {}),
  };
}

function deserializeLevel(d, index, theme) {
  if (!d || d.v !== 1 || typeof d.grid !== 'string' || d.grid.length !== COLS * ROWS) throw new Error('bad level data');
  const grid = Uint8Array.from(d.grid, (ch) => ch.charCodeAt(0) - 48);
  return {
    switches: grid.some(isSwitch),
    belts: grid.some(isBelt),
    liftFix: d.lift === 2,
    index,
    cfg: cfgFor(index),
    grid,
    saws: d.saws,
    botMask: buildBotMask(d.saws),
    spawn: d.spawn,
    goal: d.goal,
    route: d.route,
    ghostTime: d.ghostTime,
    hillSeed: d.hillSeed,
    bot: d.bot,
    goalRank: d.goalRank,
    routeHazards: d.routeHazards,
    shard: d.shard || null,
    shardRoute: d.shardRoute || null,
    key: d.key || null,
    updrafts: Array.isArray(d.updrafts) ? d.updrafts : null,
    twist: TWISTS[d.twist] ? d.twist : null,
    phys: physFor(TWISTS[d.twist] ? d.twist : null),
    theme,
  };
}

// How hard a room is, from what's in it: the spikes and saws, how many of them
// line the route you have to take, how long the perfect run is, and how high the
// goal sits.  `score` is raw; `rating` maps it to 1..10 with cut-offs fitted to
// the generator's real output (see DIFFICULTY_CUTS), so the scale is spread out.
// Deciles of difficultyScore over 270 generated rooms (90 days): each rating
// holds about a tenth of all rooms.
const DIFFICULTY_CUTS = [8.3, 8.9, 10.7, 17.5, 18.6, 20.0, 22.3, 25.5, 27.3];
const DIFFICULTY_LABELS = [[3, 'Easy'], [5, 'Medium'], [7, 'Hard'], [10, 'Brutal']];

function difficultyScore(lv) {
  let spikes = 0;
  for (let i = 0; i < lv.grid.length; i++) if (isSpike(lv.grid[i])) spikes++;
  const rh = lv.routeHazards || { spikes: 0, saws: 0 };
  const goalHeight = FLOOR_ROW - Math.round((lv.goal.y + lv.goal.h) / TILE);
  return 0.2 * spikes + 1.4 * lv.saws.length + 0.35 * rh.spikes + 1.0 * rh.saws + 2.2 * lv.ghostTime + 0.25 * goalHeight;
}

function levelDifficulty(lv) {
  const score = difficultyScore(lv);
  let rating = 1;
  while (rating < 10 && score > DIFFICULTY_CUTS[rating - 1]) rating++;
  const label = DIFFICULTY_LABELS.find(([max]) => rating <= max)[1];
  return { score, rating, label };
}

// ============================================================
// Browser game
// ============================================================
function boot() {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');

  const ghostBtn = document.getElementById('ghostBtn');
  const GHOST_DELAY = 0.8;

  const params = new URLSearchParams(location.search);
  // ?dev opens the dev panel: room skipping, day hopping, god mode, debug overlay,
  // slow-mo, click-to-teleport.  Dev runs never save a result.
  const DEV_FLAG = 'daily-jump:dev';
  let dev = params.has('dev') || (() => { try { return localStorage.getItem(DEV_FLAG) === '1'; } catch { return false; } })();
  const forcedDate = validDateKey(params.get('date'));
  const dateKey = forcedDate || dateKeyFor(new Date());
  const dayNum = dayNumberFor(dateKey);
  const storageKey = `daily-jump:${dateKey}`;

  const game = {
    state: 'title', // title | playing | dying | rankCard | swarm | results
    levelIdx: 0,
    level: null,
    player: null,
    time: 0,
    levelClock: 0,  // world clock (saws): resets on respawn, so every retry of a room is identical
    roomSteps: 0,   // the ranked clock: physics steps this attempt, from your first input.
                    // Counted as an integer so equal runs give exactly equal times —
                    // summing 1/120s floats drifts, and a 1e-15s "improvement" would
                    // show up as a NEW BEST for an identical run.
    get roomTime() { return this.roomSteps * DT; },
    roomStarted: false,
    runClockOn: false, // total time runs once you first move in a room (and through deaths)
    deaths: [0, 0, 0],
    practice: false,
    stateTimer: 0,
    ghostOn: false,  // G toggles the solver's ghost
    ghostUsed: false, // a ranked run that showed the ghost gets marked in the share text
    ghost: null,
    particles: [],
    popups: [],      // floating text, e.g. CORNER KICK!
    rings: [],       // goal shockwaves
    hitstop: 0,      // s of frozen splat after a death
    flash: 0,        // red death flash, fading
    cornerKicks: 0,  // per run, for the results screen
    mode: 'run',     // run: the daily (or practice) run | retry: one room from the results screen
    retryDeaths: 0,
    attemptGhost: false, // the ghost was on at some point during this attempt
    runRoomTimes: [],    // the clean attempt time for each room in this run
    lastClear: null,     // { time, rank, newBest } for the "Room clear!" banner
    shownResult: null,   // what the results screen is showing, to come back to after a retry
    shownPractice: false,
    splats: [],
    squash: 0,
    shake: 0,
    slideDust: 0,
    walkPhase: 0,    // px run on the ground, drives Clawd's leg cycle
    slideAnim: 0,    // seconds spent sliding, drives the hand slipping down the wall
  };

  // ---------- storage ----------
  function loadResult() {
    try {
      const r = JSON.parse(localStorage.getItem(storageKey));
      const valid =
        r && Number.isFinite(r.time) &&
        Array.isArray(r.deaths) && r.deaths.length === LEVELS.length && r.deaths.every(Number.isInteger);
      return valid ? r : null;
    } catch {
      return null;
    }
  }
  function saveResult(result) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(result));
    } catch {
      /* storage unavailable — result just won't persist */
    }
  }

  // Days you finished the daily run, read back from the per-day results above —
  // plus, when online, the days the server has for you (another device's runs).
  let serverDays = [];
  function playedDays() {
    const days = new Set(serverDays);
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const m = /^daily-jump:(\d{4}-\d{2}-\d{2})$/.exec(localStorage.key(i) || '');
        if (m) days.add(m[1]);
      }
    } catch { /* no storage, no streak */ }
    return days;
  }
  const streak = () => streakFrom(dateKey, playedDays());
  function streakLine() {
    const st = streak();
    if (st.current > 0 && st.atRisk) return `🔥 ${st.current}-day streak — finish today's rooms to keep it`;
    if (st.current > 0) return `🔥 ${st.current}-day streak${st.best > st.current ? ` · best ${st.best}` : st.current > 1 ? ' · your best yet' : ''}`;
    if (st.best > 0) return `Best streak ${st.best} — start a new one today`;
    return '';
  }

  // ---------- online: identity, submissions, leaderboards ----------
  // Only when the page is served over http(s) — i.e. by the server in server/.
  // Opened straight from disk, everything here quietly stays off.
  // A static copy (GitHub Pages — the permanent link's fallback while the server is
  // away) plays offline: rooms built here, results kept on this device, no boards.
  const STATIC_HOST = /\.github\.io$/.test(location.hostname || '');
  const API = /^https?:$/.test(location.protocol) && !STATIC_HOST ? location.origin : null;
  const PLAYER_KEY = 'daily-jump:player';
  let player = null;
  try { player = JSON.parse(localStorage.getItem(PLAYER_KEY)); } catch { /* none yet */ }
  let playerPromise = null;

  async function api(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (player && player.token) headers.authorization = `Bearer ${player.token}`;
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.reason || data.error || `HTTP ${res.status}`), { status: res.status, data });
    return data;
  }

  // Created on first submission with a default name; rename from the results screen.
  function ensurePlayer() {
    if (player && player.token) return Promise.resolve(player);
    if (!playerPromise) {
      playerPromise = api('POST', '/api/players', {}).then((p) => {
        player = p;
        try { localStorage.setItem(PLAYER_KEY, JSON.stringify(p)); } catch { /* session only */ }
        return p;
      }).finally(() => { playerPromise = null; });
    }
    return playerPromise;
  }

  // Dev mode plays with god mode, teleports and slow-mo, so it never submits.
  const canSubmit = () => API && !dev;

  const esc = (str) => String(str).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

  // Best clean attempt per room for a day: [{ time, ghost } | null, ...].  Updated
  // from the daily run, practice runs, retries and past-level plays alike.  Dev
  // mode keeps them in memory only, so testing never touches your real bests.
  function loadBests(date) {
    try {
      const b = JSON.parse(localStorage.getItem(`daily-jump:${date}:best`));
      const ok = Array.isArray(b) && b.length === LEVELS.length &&
        b.every((x) => x === null || (x && Number.isFinite(x.time) && x.time > 0));
      if (ok) return withBonus(b, date);
    } catch { /* fall through */ }
    return withBonus(LEVELS.map(() => null), date);
  }
  // Shards collected per room for a day: [bool, bool, bool, bool] (index 3: bonus).
  function loadShards(date) {
    try {
      const a = JSON.parse(localStorage.getItem(`daily-jump:${date}:shards`));
      if (Array.isArray(a)) return [0, 1, 2, 3].map((i) => a[i] === true);
    } catch { /* none yet */ }
    return [false, false, false, false];
  }
  function recordShard(i) {
    if (set.shards[i]) return false;
    set.shards[i] = true;
    if (!dev) {
      try { localStorage.setItem(`daily-jump:${set.date}:shards`, JSON.stringify(set.shards)); } catch { /* won't persist */ }
    }
    return true;
  }

  // ---------- assist mode ----------
  // Celeste's idea: let everyone see every room, honestly.  A slower game speed; the
  // physics and the room clock are untouched (times are physics steps), so anything
  // played with it is marked 🐢 wherever the time is shown.
  const ASSIST_KEY = 'daily-jump:assist';
  const ASSIST_STEPS = [1, 0.8, 0.6];
  let assist = 1;
  try { const v = Number(localStorage.getItem(ASSIST_KEY)); if (ASSIST_STEPS.includes(v)) assist = v; } catch { /* full speed */ }
  const assistLabel = () => (assist < 1 ? `🐢 Assist: ${Math.round(assist * 100)}% speed` : '🐢 Assist: off');
  function cycleAssist() {
    assist = ASSIST_STEPS[(ASSIST_STEPS.indexOf(assist) + 1) % ASSIST_STEPS.length];
    try { localStorage.setItem(ASSIST_KEY, String(assist)); } catch { /* this session */ }
    return assist;
  }

  // ---------- badges ----------
  // Small goals beyond the day's time: earned once, kept forever (in this browser).
  const BADGES = [
    ['first', '🚩', 'First steps', 'clear any room'],
    ['flawless', '💎', 'Flawless', 'clear a daily room without dying'],
    ['perfect', '👑', 'Perfect day', 'all three daily rooms, no deaths'],
    ['sharp', '🗡️', 'Sharp', 'an S rank in any room'],
    ['impossible', '👾', 'Impossible?', 'match the ghost: IMPOSSIBLE rank'],
    ['shiny', '✦', 'Shiny', 'carry a shard to the goal'],
    ['collector', '🌟', 'Collector', 'every shard of a day'],
    ['nightmare', '☠', 'Nightmare', 'clear the bonus room'],
    ['corner', '⚡', 'Corner kicker', 'pull off a corner kick'],
    ['boing', '🌀', 'Boing', 'ride a spring'],
    ['twisted', '🧊', 'Twisted', 'finish a twist day'],
    ['streak3', '🔥', 'On fire', 'a 3-day streak'],
    ['streak7', '📅', 'Week warrior', 'a 7-day streak'],
    ['endless10', '∞', 'Deep diver', 'reach room 10 in Endless'],
  ];
  const BADGES_KEY = 'daily-jump:badges';
  let badges = {};
  try { badges = JSON.parse(localStorage.getItem(BADGES_KEY)) || {}; } catch { /* none yet */ }
  const toastEl = document.getElementById('toast');
  const toastQueue = [];
  function award(id) {
    if (dev || badges[id]) return;
    const b = BADGES.find((x) => x[0] === id);
    if (!b) return;
    badges[id] = dateKey;
    try { localStorage.setItem(BADGES_KEY, JSON.stringify(badges)); } catch { /* this session only */ }
    toastQueue.push(b);
    if (toastQueue.length === 1) showToast();
  }
  function showToast() {
    const b = toastQueue[0];
    if (!b || !toastEl) return;
    const unlock = SKINS.find((k) => k.need === b[0]);
    toastEl.innerHTML = `<span class="toast-icon">${b[1]}</span><span><b>${b[2]}</b><small>${b[3]}${unlock ? ` · 👕 ${unlock.name} skin unlocked` : ''}</small></span>`;
    toastEl.hidden = false;
    sfx.badge();
    setTimeout(() => {
      toastEl.hidden = true;
      toastQueue.shift();
      if (toastQueue.length) setTimeout(showToast, 250);
    }, 2600);
  }
  // ---------- skins ----------
  // Cosmetic only: earned with badges, picked on the title screen.
  const SKINS = [
    { id: 'classic', name: 'Classic', need: null, colors: CLAWD_COLORS },
    { id: 'gold', name: 'Gold', need: 'collector', colors: { body: '#ffc94a', shade: '#d39b1c', eye: '#3a2a00', outline: '#5c4300' } },
    { id: 'frost', name: 'Frost', need: 'twisted', colors: { body: '#a6e3ff', shade: '#6fb9df', eye: '#10223a', outline: '#1d3a5c' } },
    { id: 'ember', name: 'Ember', need: 'streak3', colors: { body: '#ff6b3d', shade: '#c9431c', eye: '#2a0b00', outline: '#4a1500' } },
    { id: 'royal', name: 'Royal', need: 'perfect', colors: { body: '#8f7bff', shade: '#6450d6', eye: '#fff6dc', outline: '#241a5c' } },
    { id: 'void', name: 'Void', need: 'nightmare', colors: { body: '#2b2b3f', shade: '#18182a', eye: '#ff5c7a', outline: '#000000' } },
    { id: 'glitch', name: 'Glitch', need: 'impossible', colors: { body: '#39ffb0', shade: '#18c487', eye: '#ff2bd6', outline: '#0b3d2c' } },
    { id: 'abyss', name: 'Abyss', need: 'endless10', colors: { body: '#1fb6c9', shade: '#137e8c', eye: '#ffd166', outline: '#06323a' } },
  ];
  const SKIN_KEY = 'daily-jump:skin';
  const skinUnlocked = (k) => !k.need || !!badges[k.need];
  let skinId = 'classic';
  try { const v = localStorage.getItem(SKIN_KEY); if (SKINS.some((k) => k.id === v)) skinId = v; } catch { /* classic */ }
  const skin = () => { const k = SKINS.find((x) => x.id === skinId); return k && skinUnlocked(k) ? k : SKINS[0]; };
  const playerColors = () => skin().colors;
  function cycleSkin() {
    const open = SKINS.filter(skinUnlocked);
    const i = open.findIndex((k) => k.id === skin().id);
    skinId = open[(i + 1) % open.length].id;
    try { localStorage.setItem(SKIN_KEY, skinId); } catch { /* session */ }
    return skin();
  }
  const skinLabel = () => `👕 ${skin().name}${SKINS.filter(skinUnlocked).length > 1 ? ' ▸' : ''}`;

  // ---------- stats (Wordle-style) ----------
  // Everything from what this browser already keeps: the per-day results, shards, streak.
  function statsHtml() {
    const days = [];
    let shards = 0;
    try {
      const shardDays = new Map();
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) || '';
        try { // one corrupt entry skips that day, not the rest
          let m = /^daily-jump:(\d{4}-\d{2}-\d{2})$/.exec(k);
          if (m) {
            const r = JSON.parse(localStorage.getItem(k));
            if (r && Array.isArray(r.deaths) && r.deaths.every((n) => Number.isInteger(n) && n >= 0) && Number.isFinite(r.time) && r.time > 0) {
              days.push({ date: m[1], deaths: r.deaths.reduce((a, b) => a + b, 0), time: r.time });
            }
          }
          m = /^daily-jump:(\d{4}-\d{2}-\d{2}):shards$/.exec(k);
          if (m) {
            const got = JSON.parse(localStorage.getItem(k));
            if (Array.isArray(got)) shardDays.set(m[1], got.filter((x) => x === true).length);
          }
        } catch { /* skip it */ }
      }
      for (const d of days) shards += shardDays.get(d.date) || 0; // shards from the days you played
    } catch { /* no storage: nothing to show */ }
    if (!days.length) return '';
    const st = streak();
    const flawless = days.filter((d) => d.deaths === 0).length;
    const avg = days.reduce((a, d) => a + d.deaths, 0) / days.length;
    const best = Math.min(...days.map((d) => d.time));
    const BINS = [['0', (n) => n === 0], ['1–4', (n) => n >= 1 && n <= 4], ['5–9', (n) => n >= 5 && n <= 9], ['10–19', (n) => n >= 10 && n <= 19], ['20+', (n) => n >= 20]];
    const counts = BINS.map(([, f]) => days.filter((d) => f(d.deaths)).length);
    const most = Math.max(1, ...counts);
    const todays = days.find((d) => d.date === dateKey);
    const bars = BINS.map(([label, f], k) => `<div class="stat-bar"><span>${label}</span><i class="${todays && f(todays.deaths) ? 'today' : ''}" style="width:${Math.max(8, Math.round((100 * counts[k]) / most))}%">${counts[k]}</i></div>`).join('');
    const box = (n, label) => `<div class="stat-box"><b>${n}</b><small>${label}</small></div>`;
    return `<details class="stats"><summary>📊 Stats</summary>
      <div class="stat-boxes">${box(days.length, 'played')}${box(st.current, 'streak')}${box(st.best, 'best streak')}${box(flawless, 'flawless days')}</div>
      <div class="stat-boxes">${box(avg.toFixed(1), 'deaths / day')}${box(formatTime(best), 'best day')}${box(shards, 'shards')}</div>
      <div class="stat-dist"><small>deaths per day</small>${bars}</div></details>`;
  }

  function badgesHtml() {
    const got = BADGES.filter((b) => badges[b[0]]).length;
    const cells = BADGES.map(([id, icon, name, how]) => `<div class="badge${badges[id] ? ' got' : ''}" title="${how}">
      <span class="badge-icon">${badges[id] ? icon : '🔒'}</span><b>${name}</b><small>${how}</small></div>`).join('');
    const skins = SKINS.filter((k) => k.need).map((k) => {
      const b = BADGES.find((x) => x[0] === k.need);
      const open = skinUnlocked(k);
      return `<span class="skin-chip${open ? ' got' : ''}" title="${open ? 'unlocked' : `earn “${b[2]}” to unlock`}"><i style="background:${k.colors.body};border-color:${k.colors.outline}"></i>${k.name}${open ? '' : ' 🔒'}</span>`;
    }).join('');
    return `<details class="badges"><summary>🏅 Badges ${got}/${BADGES.length}</summary><div class="badge-grid">${cells}</div>
      <div class="skins"><b>👕 Skins</b> — earned with badges, picked on the title screen<div>${skins}</div></div></details>`;
  }

  // The bonus room's best lives under its own key, so the three-room format above
  // (and anything already saved in it) stays exactly as it was.
  function withBonus(b, date) {
    try {
      const x = JSON.parse(localStorage.getItem(`daily-jump:${date}:bonus`));
      b[BONUS_ROOM] = x && Number.isFinite(x.time) && x.time > 0 ? x : null;
    } catch { b[BONUS_ROOM] = null; }
    return b;
  }

  // The set of rooms being played: today's, or a past day's from the archive.
  // Bests, submissions and the HUD all follow whichever set is active.
  const today = { date: dateKey, dayNum, rooms: [], bests: loadBests(dateKey), shards: loadShards(dateKey) };
  let set = today;

  // Returns true if this beat a previous best (not just the first clear).
  function recordBest(i, time, ghost, assisted = false) {
    const prev = set.bests[i];
    if (prev && time >= prev.time) return false;
    set.bests[i] = assisted ? { time, ghost, assist: true } : { time, ghost };
    // the bonus room may not be loaded when the results draw its rank: keep its ghost time
    if (i === BONUS_ROOM) set.bests[i].ghostTime = game.level.ghostTime;
    if (!dev) {
      try {
        if (i === BONUS_ROOM) localStorage.setItem(`daily-jump:${set.date}:bonus`, JSON.stringify(set.bests[i]));
        else localStorage.setItem(`daily-jump:${set.date}:best`, JSON.stringify(set.bests.slice(0, LEVELS.length)));
      } catch { /* won't persist */ }
    }
    return !!prev;
  }

  // ---------- sound ----------
  // Every sound is synthesized on the spot with Web Audio — no files to load.
  // Browsers only allow audio after a user gesture, so the context is created on
  // the first key press or click.  M mutes; the choice is remembered.
  const sfx = (() => {
    const MUTE_KEY = 'daily-jump:muted';
    let ac = null;
    let out = null;
    let muted = false;
    try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* default on */ }
    function wake() {
      if (!ac) {
        const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return null;
        ac = new AC();
        out = ac.createGain();
        out.gain.value = 0.32;
        out.connect(ac.destination);
      }
      if (ac.state === 'suspended') ac.resume();
      return ac;
    }
    // one oscillator note with a quick attack and an exponential tail
    function tone(type, f0, f1, dur, vol, delay = 0) {
      if (muted || !ac) return;
      const t = ac.currentTime + delay;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    // filtered noise: thuds and splats
    function noise(dur, vol, freq, q = 0.7) {
      if (muted || !ac) return;
      const t = ac.currentTime;
      const len = Math.ceil(ac.sampleRate * dur);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ac.createBufferSource();
      src.buffer = buf;
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ac.createGain();
      g.gain.value = vol;
      src.connect(f).connect(g).connect(out);
      src.start(t);
    }
    // ---------- music: a tiny chiptune loop per theme, synthesized live ----------
    // Bass, an arpeggio and hats over a four-chord loop; each theme picks a key, a
    // mode and a tempo, and harder rooms play a little faster.  Scheduled ahead on the
    // audio clock (not the frame loop), so it never stutters.
    const MUSIC_KEY = 'daily-jump:music';
    let musicOn = true;
    try { musicOn = localStorage.getItem(MUSIC_KEY) !== '0'; } catch { /* default on */ }
    let mOut = null;
    let song = null;
    let timer = null;
    let step = 0;
    let nextAt = 0;
    const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const PROG = { minor: [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]], major: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]] };
    function noteAt(type, freq, t, dur, vol) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(mOut);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    let hatBuf = null;
    function hatAt(t, vol) {
      if (!hatBuf) {
        hatBuf = ac.createBuffer(1, Math.ceil(ac.sampleRate * 0.04), ac.sampleRate);
        const d = hatBuf.getChannelData(0);
        for (let k = 0; k < d.length; k++) d[k] = (Math.random() * 2 - 1) * (1 - k / d.length);
      }
      const src = ac.createBufferSource();
      src.buffer = hatBuf;
      const f = ac.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7000;
      const g = ac.createGain();
      g.gain.value = vol;
      src.connect(f).connect(g).connect(mOut);
      src.start(t);
    }
    function playStep(t) {
      if (muted || !musicOn) { step++; return; } // silent: keep the beat, make no nodes
      const chord = PROG[song.mode][Math.floor(step / 16) % 4];
      const s16 = step % 16;
      const root = song.root;
      if (s16 === 0 || s16 === 6 || s16 === 8 || s16 === 14) noteAt('triangle', midi(root - 24 + chord[0]), t, 0.22, 0.5);
      if (s16 % 2 === 0) noteAt('square', midi(root + chord[(s16 / 2) % 3] + (s16 >= 8 ? 12 : 0)), t, 0.11, 0.07);
      if (s16 % 4 === 2) hatAt(t, 0.12);
      if (s16 === 0 || s16 === 8) noteAt('sine', 90, t, 0.12, 0.5);
      step++;
    }
    function schedule() {
      if (!ac || !song) return;
      const stepDur = 60 / song.bpm / 4;
      while (nextAt < ac.currentTime + 0.25) {
        if (nextAt < ac.currentTime) nextAt = ac.currentTime + 0.02;
        playStep(nextAt);
        nextAt += stepDur;
      }
    }
    function startMusic(themeKey, roomIdx) {
      if (!ac) return;
      if (!mOut) {
        mOut = ac.createGain();
        mOut.connect(out);
      }
      mOut.gain.value = muted || !musicOn ? 0 : 0.55;
      let h = 0;
      for (const ch of String(themeKey)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const next = { root: 57 + (h % 7), mode: h % 3 === 0 ? 'major' : 'minor', bpm: 104 + (h % 5) * 6 + roomIdx * 6 };
      if (song && song.root === next.root && song.mode === next.mode && song.bpm === next.bpm && timer) return;
      song = next;
      step = 0;
      nextAt = ac.currentTime + 0.05;
      if (!timer) timer = setInterval(schedule, 60);
    }
    function stopMusic() {
      if (timer) clearInterval(timer);
      timer = null;
      song = null;
    }

    return {
      wake,
      get muted() { return muted; },
      get musicOn() { return musicOn; },
      music(themeKey, roomIdx) { wake(); startMusic(themeKey, roomIdx); },
      musicStop: stopMusic,
      toggleMusic() {
        musicOn = !musicOn;
        try { localStorage.setItem(MUSIC_KEY, musicOn ? '1' : '0'); } catch { /* session only */ }
        if (mOut) mOut.gain.value = muted || !musicOn ? 0 : 0.55;
        return musicOn;
      },
      toggle() {
        muted = !muted;
        try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* session only */ }
        if (mOut) mOut.gain.value = muted || !musicOn ? 0 : 0.55;
        if (!muted) { wake(); tone('triangle', 660, 880, 0.08, 0.2); }
      },
      jump() { tone('square', 330, 560, 0.09, 0.12); },
      swap() { tone('triangle', 1320, 990, 0.05, 0.07, 0.01); },
      wallKick() { tone('triangle', 420, 820, 0.1, 0.22); noise(0.05, 0.15, 2400); },
      cornerKick() { [880, 1175, 1568].forEach((f, k) => tone('triangle', f, f * 1.02, 0.12, 0.2, k * 0.045)); },
      badge() { [784, 988, 1175, 1568].forEach((f, k) => tone('triangle', f, f, 0.14, 0.14, k * 0.06)); },
      spring() { tone('square', 220, 880, 0.16, 0.14); tone('triangle', 440, 1320, 0.14, 0.1, 0.02); },
      shard() { [1319, 1760, 2093, 2637].forEach((f, k) => tone('sine', f, f, 0.18, 0.16, k * 0.05)); },
      land(speed) { noise(0.06, Math.min(0.5, 0.08 + speed / 2000), 380); },
      death() { noise(0.28, 0.55, 900, 1.2); tone('sawtooth', 240, 55, 0.3, 0.16); },
      goal() { [523, 659, 784, 1047].forEach((f, k) => tone('triangle', f, f, 0.16, 0.22, k * 0.07)); },
      rank(name) {
        if (name === 'IMPOSSIBLE') {
          for (let k = 0; k < 6; k++) tone('square', 200 + Math.random() * 1400, 120 + Math.random() * 1600, 0.07, 0.12, k * 0.05);
          [523, 784, 1047, 1568].forEach((f, k) => tone('sawtooth', f, f, 0.35, 0.09, 0.3 + k * 0.02));
          return;
        }
        const chord = { S: [523, 659, 784, 1047], A: [523, 659, 784], B: [440, 554, 659], C: [392, 494], D: [330, 392] }[name] || [440];
        chord.forEach((f, k) => tone('triangle', f, f, 0.4, 0.14, k * 0.04));
      },
      tick() { tone('square', 1200, 1200, 0.025, 0.06); },
    };
  })();

  // ---------- input ----------
  const keys = { left: false, right: false, jump: false };
  let jumpQueued = false;
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    Space: 'jump', ArrowUp: 'jump', KeyW: 'jump',
    KeyZ: 'jump', KeyX: 'jump', // the classic platformer layouts (K is a dev key)
  };
  // Audio may only start inside a real user activation: on touch screens that's the
  // pointerup/click, not the pointerdown, so listen for all of them.
  for (const ev of ['pointerdown', 'pointerup', 'click']) window.addEventListener(ev, () => sfx.wake(), true);
  window.addEventListener('pointerdown', () => { if (game.state === 'swarm') endSwarm(); }); // a tap skips the replay
  window.addEventListener('keydown', (e) => {
    sfx.wake();
    if (e.code === 'KeyM' && !e.repeat && !(e.target && e.target.tagName === 'INPUT')) sfx.toggle();
    if (e.code === 'KeyN' && !e.repeat && !(e.target && e.target.tagName === 'INPUT')) {
      const on = sfx.toggleMusic();
      if (game.player) game.popups.push({ text: on ? '♪ music on' : '♪ music off', x: game.player.x + 12, y: game.player.y - 10, life: 1, color: '#ffffff' });
    }
    if (game.state === 'endlessOver' && !e.repeat) {
      if (e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter') { e.preventDefault(); startEndless(game.endlessReturn); return; }
      if (e.code === 'Escape') { endlessQuit(); return; }
    }
    if (game.state === 'endlessWait' && e.code === 'Escape') { endlessQuit(); return; }
    if (game.state === 'swarm') {
      // any *game* key skips; shortcuts, modifiers, Tab and M (mute) pass through
      const mod = e.metaKey || e.ctrlKey || e.altKey || /^(Shift|Control|Alt|Meta|Tab|KeyM|KeyN)/.test(e.code);
      if (mod) return;
      if (!e.repeat) endSwarm();
      if (KEYMAP[e.code] || e.code === 'Enter' || e.code === 'Escape') e.preventDefault();
      return;
    }
    if (game.state === 'rankCard') {
      cardKey(e);
      if (KEYMAP[e.code]) e.preventDefault();
      return;
    }
    // Cmd/Ctrl/Alt chords (Cmd+Z, Ctrl+A…) belong to the browser: no keyup arrives
    // while Cmd is held on a Mac, so they'd leave a key stuck down
    const k = e.metaKey || e.ctrlKey || e.altKey ? null : KEYMAP[e.code];
    if (k) {
      e.preventDefault();
      if (k === 'jump' && !e.repeat) jumpQueued = true;
      keys[k] = true;
    }
    if (e.code === 'KeyR' && game.state === 'playing') die();
    if (e.code === 'Escape' && solo() && inRun()) leaveSolo(null);
    if (e.code === 'Escape' && game.state === 'archive') archiveBack();
    if (e.code === 'KeyG' && !e.repeat && inRun()) toggleGhost();
    if (e.code === 'KeyF' && !e.repeat) plantFlag();
    if (e.code === 'KeyV' && !e.repeat && inRun()) toggleRacers();
    if (dev && !e.repeat) devKey(e);
    if ((e.code === 'Enter' || e.code === 'Space') && game.state === 'title' && !e.repeat) startRun(game.practice);
  });
  window.addEventListener('keyup', (e) => {
    const k = KEYMAP[e.code];
    if (k) keys[k] = false;
  });
  window.addEventListener('blur', () => {
    keys.left = keys.right = keys.jump = false;
  });

  // ---------- touch ----------
  // On-screen pad for phones: a move pad you can slide your thumb across (◀ ▶ are
  // two halves of one surface, so changing direction never needs a lift), a big
  // JUMP button, and restart / mute / back.  It appears on the first real touch,
  // and only while you're actually in a room.  Each pad tracks its own pointers, so
  // holding a direction and tapping JUMP with the other thumb works as on a gamepad.
  const touchEl = document.getElementById('touch');
  const touch = { on: false, dir: 0 };
  if (touchEl) {
    const tMove = touchEl.querySelector('#tMove');
    const tJump = touchEl.querySelector('#tJump');
    const [tLeft, tRight] = tMove.querySelectorAll('span');
    const tMute = touchEl.querySelector('#tMute');
    const tBack = touchEl.querySelector('#tBack');
    const movers = new Map(); // pointerId -> -1 | 1
    const jumpers = new Set();
    const setDir = () => {
      // the most recent finger on the pad wins
      const dir = movers.size ? [...movers.values()].pop() : 0;
      touch.dir = dir;
      keys.left = dir < 0;
      keys.right = dir > 0;
      tLeft.classList.toggle('on', dir < 0);
      tRight.classList.toggle('on', dir > 0);
    };
    const dirAt = (e) => {
      const r = tMove.getBoundingClientRect();
      return e.clientX < r.left + r.width / 2 ? -1 : 1;
    };
    tMove.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      tMove.setPointerCapture?.(e.pointerId);
      movers.set(e.pointerId, dirAt(e));
      setDir();
    });
    tMove.addEventListener('pointermove', (e) => {
      if (!movers.has(e.pointerId)) return;
      movers.set(e.pointerId, dirAt(e));
      setDir();
    });
    const moveUp = (e) => { movers.delete(e.pointerId); setDir(); };
    tMove.addEventListener('pointerup', moveUp);
    tMove.addEventListener('pointercancel', moveUp);
    tJump.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      tJump.setPointerCapture?.(e.pointerId);
      if (!jumpers.size) jumpQueued = true;
      jumpers.add(e.pointerId);
      keys.jump = true;
      tJump.classList.add('on');
    });
    const jumpUp = (e) => {
      jumpers.delete(e.pointerId);
      if (!jumpers.size) { keys.jump = false; tJump.classList.remove('on'); }
    };
    tJump.addEventListener('pointerup', jumpUp);
    tJump.addEventListener('pointercancel', jumpUp);
    touchEl.querySelector('#tRestart').addEventListener('click', () => { if (game.state === 'playing') die(); });
    tMute.addEventListener('click', () => { sfx.toggle(); tMute.textContent = sfx.muted ? '🔇' : '🔊'; });
    tMute.textContent = sfx.muted ? '🔇' : '🔊';
    tBack.addEventListener('click', () => { if (solo() && inRun()) leaveSolo(null); });
    touchEl.querySelector('#tFlag').addEventListener('click', () => plantFlag());
    touch.release = () => {
      movers.clear(); jumpers.clear(); setDir();
      keys.jump = false; tJump.classList.remove('on');
    };
    const enable = () => {
      if (touch.on) return;
      touch.on = true;
      document.body.classList.add('touch');
    };
    window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') enable(); }, true);
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) enable();
    if (/[?&]touch\b/.test(location.search)) enable(); // ?touch: show the pad on a desktop
  }
  // ---------- gamepad ----------
  // Standard mapping (W3C Gamepad spec): left stick or D-pad moves, A or B jumps,
  // Y / Select restarts the room, X toggles the ghost, A / Start confirms on the
  // title and rank card.  Polled once per frame; only *changes* are written into
  // `keys`, so a pad lying idle never fights the keyboard.
  const pad = { prev: { dir: 0, jump: false, btn: [] }, used: false };
  const PAD_DEADZONE = 0.4; // a precision game wants a firm push, not a drifting stick
  function pollPad() {
    let pads = [];
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch { /* blocked (e.g. iframe policy): no pad */ }
    let gp = null;
    for (const g of pads || []) if (g && g.connected !== false) { gp = g; break; }
    if (!gp) {
      // unplugged / battery died mid-press: let go of whatever it was holding
      if (pad.prev.dir || pad.prev.jump) { keys.left = keys.right = keys.jump = false; }
      pad.prev = { dir: 0, jump: false, btn: [] };
      return;
    }
    const down = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5));
    const ax = gp.axes[0] || 0;
    const dir = down(14) ? -1 : down(15) ? 1 : ax < -PAD_DEADZONE ? -1 : ax > PAD_DEADZONE ? 1 : 0;
    const jump = down(0) || down(1);
    const pressed = (i) => down(i) && !pad.prev.btn[i];
    const prev = pad.prev;
    if (!pad.used && (dir || jump || gp.buttons.some((b) => b && b.pressed))) {
      pad.used = true;
      document.body.classList.add('pad');
      sfx.wake();
    }
    // releases always go through, so nothing stays held across a card or menu
    if (!jump && prev.jump) keys.jump = false;
    if (dir !== prev.dir && dir === 0) keys.left = keys.right = false;
    if (game.state === 'rankCard') {
      if (performance.now() / 1000 - card.t0 >= CARD_ARM) {
        if (pressed(0) || pressed(9)) cardNext();
        else if (pressed(3)) cardRetry();
        else if (pressed(2)) startSwarm();
        else if (pressed(1) && solo()) leaveSolo(game.levelIdx);
      }
    } else if (game.state === 'swarm') {
      if (gp.buttons.some((b, i) => pressed(i))) endSwarm();
    } else if (game.state === 'endlessOver') {
      if (pressed(0) || pressed(9)) startEndless(game.endlessReturn);
      else if (pressed(1)) endlessQuit();
    } else if (game.state === 'endlessWait') {
      if (pressed(1)) endlessQuit();
    } else if (game.state === 'title') {
      if (pressed(0) || pressed(9)) startRun(game.practice);
    } else {
      // a held direction is re-asserted every frame, so it survives cards, menus and
      // the touch pad letting go; neutral only writes on the edge (keyboard stays free)
      if (dir !== 0 || prev.dir !== 0) { keys.left = dir < 0; keys.right = dir > 0; }
      if (jump && !prev.jump) { jumpQueued = true; keys.jump = true; }
      if ((pressed(3) || pressed(8)) && game.state === 'playing') die();
      if (pressed(2) && inRun()) toggleGhost();
      if (pressed(4) && inRun()) toggleRacers();
      if (pressed(5)) plantFlag(); // RB
      if (pressed(9) && solo() && inRun()) leaveSolo(null); // Start = back out of a retry / past level
    }
    if (game.state === 'archive' && pressed(1)) archiveBack();
    pad.prev = { dir, jump, btn: gp.buttons.map((b) => !!(b && (b.pressed || b.value > 0.5))) };
  }

  // Called every frame: the pad shows only while a room is being played.
  function syncTouch() {
    if (!touch.on) return;
    const show = game.state === 'playing' || game.state === 'dying';
    if (touchEl.hidden === show) {
      touchEl.hidden = !show;
      touch.release(); // no finger stays "held" across a card or menu
    }
    const mute = touchEl.querySelector('#tMute');
    const icon = sfx.muted ? '🔇' : '🔊';
    if (mute.textContent !== icon) mute.textContent = icon; // M on a keyboard too
    const back = touchEl.querySelector('#tBack');
    if (back.hidden === solo()) back.hidden = !solo();
    const flag = touchEl.querySelector('#tFlag');
    if (flag.hidden !== !flagOK()) flag.hidden = !flagOK();
  }

  // ---------- flow ----------
  // Rooms are built once, at load, behind the title screen.  Generating room 3 can
  // take a few hundred ms, and doing that between rooms would freeze the game right
  // after a win; doing it here also means a practice run replays the same rooms for
  // free instead of regenerating them.
  // Today's rooms come from the server when there is one — the stored copies that
  // everyone plays and that replays are verified against.  Offline, they're
  // generated right here, the same way.
  const roomAt = (i) => {
    if (!today.rooms[i]) {
      today.rooms[i] = generateLevel(levelSeed(dateKey, i), i, twistForDay(dateKey));
      today.rooms[i].theme = i === BONUS_ROOM ? bonusTheme(dateKey) : themesForDay(dateKey)[i];
    }
    return today.rooms[i];
  };

  function loadLevel(i) {
    game.tip = null; // tips are about the room in front of you: a new room starts clean
    tipQueue.length = 0;
    setTimeout(() => { if (game.level && game.level.key && game.state === 'playing') tip('locked'); }, 0);
    setTimeout(() => { if (game.level && game.level.switches && game.state === 'playing') tip('switches'); }, 0);
    setTimeout(() => { if (game.level && game.level.belts && game.state === 'playing') tip('belts'); }, 0);
    game.runClockOn = false; // total time waits for your first input in each new room
    game.levelIdx = i;
    game.intro = reduceMotion ? 0 : INTRO_T; // the iris opens on Clawd
    game.flag = null; // flags belong to one room
    game.level = set === today ? roomAt(i) : set.rooms[i];
    game.splats = [];
    game.tries = []; // every attempt's inputs in this room, for the replay-all swarm
    game.triesTotal = 0;
    sendStat('enter', i);
    sfx.music(themeKeyOf(game.level), i); // each theme its own little tune; harder rooms play faster
    loadRacers();
    respawn();
    if (dev) renderDev();
  }

  // "Solo" plays are single rooms outside the daily run: a retry from the results
  // screen, or a past level from the archive.  They only ever improve bests.
  const solo = () => game.mode === 'retry' || game.mode === 'archive' || game.mode === 'endless' || game.mode === 'tutorial';
  function leaveSolo(highlight) {
    if (game.mode === 'endless') { endlessQuit(); return; }
    if (game.mode === 'tutorial') { tutorialQuit(false); return; }
    if (game.mode === 'archive') {
      const at = { date: set.date, room: game.levelIdx };
      set = today;
      showArchive(at);
    } else {
      backToResults(highlight);
    }
  }

  const inRun = () => game.state === 'playing' || game.state === 'dying' || game.state === 'rankCard';

  // Turning the ghost on always restarts it from spawn (after a short hold), so you
  // see the whole run rather than joining it wherever it happens to be.
  // ---------- practice flags ----------
  // Celeste-style practice: plant a 🚩 where you stand and every respawn starts there,
  // so a hard stretch can be drilled on its own.  Practice runs, retries and past
  // levels only — never the official daily run — and nothing from a flag counts.
  const flagOK = () => game.mode !== 'endless' && (game.mode === 'retry' || game.mode === 'archive' || game.practice);
  function plantFlag() {
    const p = game.player;
    if (game.state !== 'playing' || !p) return;
    const say = (text, color = '#ffffff') => game.popups.push({ text, x: p.x + p.w / 2, y: p.y - 10, life: 1.2, color });
    if (!flagOK()) { say('🚩 flags are for practice & retries'); return; }
    const f = game.flag;
    if (f && Math.abs(f.p.x - p.x) < TILE && Math.abs(f.p.y - p.y) < TILE) {
      game.flag = null;
      say('🚩 flag removed — back to the start');
      return;
    }
    if (!p.onGround) { say('🚩 stand on something to plant it'); return; }
    const snap = clonePlayer(p);
    snap.vx = 0;
    snap.vy = 0;
    snap.jumpBuffer = 0;
    game.flag = { p: snap, clock: game.levelClock, shard: game.shardHeld };
    sfx.shard();
    say('🚩 flag planted — respawns start here (F again: remove)', '#ffd166');
  }
  function drawFlag(f) {
    const x = f.p.x + f.p.w / 2;
    const y = f.p.y + f.p.h;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 1, y - 34, 3, 34);
    ctx.fillStyle = '#ff5a5f';
    ctx.beginPath();
    const wave = reduceMotion ? 0 : Math.sin(artT * 6) * 2;
    ctx.moveTo(x + 2, y - 34);
    ctx.lineTo(x + 20, y - 28 + wave);
    ctx.lineTo(x + 2, y - 21);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function toggleGhost(on = !game.ghostOn) {
    game.ghostOn = on;
    if (on) {
      game.attemptGhost = true;
      game.ghost = makeGhost(game.level, GHOST_DELAY);
      if (!game.practice && !dev) game.ghostUsed = true;
    }
    ghostBtn.classList.toggle('on', on);
    ghostBtn.firstChild.textContent = on ? '👻 Hide ghost ' : '👻 Show ghost ';
    if (dev) renderDev();
  }
  ghostBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus off it, or Space would click it
  ghostBtn.addEventListener('click', () => { if (inRun()) toggleGhost(); });

  function respawn() {
    const f = game.flag; // a practice flag: start there, as you were when you planted it
    game.player = f ? clonePlayer(f.p) : makePlayer(game.level.spawn);
    game.ghost = makeGhost(game.level, GHOST_DELAY); // restarts with you
    resetRacers();
    game.rec = []; // this attempt's inputs, one mask per physics step — the replay
    game.shardHeld = f ? f.shard : false; // a shard only counts if you carry it to the goal alive
    game.attemptGhost = game.ghostOn;
    game.attemptAssist = assist < 1;
    game.attemptFlag = !!f;
    game.levelClock = f ? f.clock : 0; // saws back where they were, so the flag is as safe as when you stood there
    game.roomSteps = 0;
    game.roomStarted = false;
    game.state = 'playing';
    jumpQueued = false;
  }

  // The page may have been left open past midnight: reload to pick up the new day's levels.
  function dayRolledOver() {
    return !forcedDate && dateKeyFor(new Date()) !== dateKey;
  }

  function startRun(practice) {
    bonusAsk++;
    if (dayRolledOver()) {
      location.reload();
      return;
    }
    set = today; // a run is always today's rooms, even if you came from the archive
    game.practice = practice;
    game.time = 0;
    game.deaths = [0, 0, 0];
    game.ghostUsed = false;
    game.mode = 'run';
    game.runRoomTimes = [];
    game.runAssist = false;
    game.runReplays = [];
    game.runDeaths = [[], [], []]; // where you died in each room, for the 📸 death map
    game.cornerKicks = 0;
    game.popups = [];
    game.particles = [];
    hideOverlay();
    ghostBtn.hidden = false;
    loadLevel(0);
  }

  function die() {
    sfx.death();
    if (!game.attemptFlag) keepTry(game.rec, false); // a flag attempt doesn't start at spawn: no replay of it
    if (flagOK() && (solo() ? game.retryDeaths : game.deaths[game.levelIdx]) + 1 === 5) tip('flag');
    if (game.mode === 'endless') {
      game.endless.lives--;
      if (game.endless.lives <= 0) game.endless.over = true;
    }
    const roomDeaths = (solo() ? game.retryDeaths : game.deaths[game.levelIdx]) + 1;
    if (roomDeaths === 3) tip('deaths');
    if (roomDeaths === 10 && !game.ghostOn) tip('stuck');
    if (solo()) game.retryDeaths++;
    else game.deaths[game.levelIdx]++;
    const px = game.player.x + PLAYER_W / 2;
    const py = game.player.y + PLAYER_H / 2;
    if (!solo() && game.runDeaths && game.runDeaths[game.levelIdx] && game.runDeaths[game.levelIdx].length < 300) game.runDeaths[game.levelIdx].push({ x: px, y: py });
    burst(px, py, 26, playerColors().body);
    addSplat(px, py);
    game.shake = 0.3;
    game.state = 'dying';
    game.stateTimer = 0.32;
    game.hitstop = 0.07;
    game.flash = reduceMotion ? 0 : 1;
  }

  // ---------- ∞ Endless ----------
  // After the daily rooms: one generated room after another, harder as you go
  // (Warmup → Grinder → Gauntlet → Nightmare, twists mixed in), 10 lives for the run.
  // How deep can you get?  Rooms are built in a Web Worker so the game never freezes.
  const ENDLESS_BEST_KEY = 'daily-jump:endless-best';
  const ENDLESS_LIVES = 10;
  const ENDLESS_MAX_LIVES = 15;
  let roomWorker = null;
  let workerBroken = false; // one failure and we build on the main thread from then on
  let workerJobs = 0;
  const workerWaiting = new Map();
  function buildRoomAsync(seed, index, twist) {
    if (!roomWorker && !workerBroken && typeof Worker !== 'undefined' && /^https?:$/.test(location.protocol)) {
      try {
        roomWorker = new Worker('rooms-worker.js');
        roomWorker.onmessage = (e) => { const done = workerWaiting.get(e.data.id); workerWaiting.delete(e.data.id); if (done) done(e.data.level); };
        // a broken worker: finish everything it owed on the main thread, and stop using it
        roomWorker.onerror = roomWorker.onmessageerror = () => {
          const owed = [...workerWaiting.values()];
          workerWaiting.clear();
          roomWorker.terminate();
          roomWorker = null;
          workerBroken = true;
          owed.forEach((done) => done(null));
        };
      } catch { roomWorker = null; workerBroken = true; }
    }
    const local = () => serializeLevel(generateLevel(seed, index, twist));
    if (roomWorker) {
      return new Promise((ok) => {
        const id = ++workerJobs;
        // never hang on "building…": a worker that errors or stalls falls back to here
        const timer = setTimeout(() => { if (workerWaiting.delete(id)) ok(local()); }, 20000);
        workerWaiting.set(id, (lv) => { clearTimeout(timer); ok(lv); });
        roomWorker.postMessage({ id, seed, index, twist });
      });
    }
    // no worker (opened from disk): build here, after letting the "building" card paint
    return new Promise((ok) => setTimeout(() => ok(serializeLevel(generateLevel(seed, index, twist))), 30));
  }
  const endlessIndexFor = (n) => (n < 3 ? 0 : n < 6 ? 1 : n < 10 ? 2 : BONUS_ROOM);
  function endlessBest() { try { return Number(localStorage.getItem(ENDLESS_BEST_KEY)) || 0; } catch { return 0; } }
  function startEndless(from) {
    bonusAsk++;
    game.endlessReturn = from;
    game.mode = 'endless';
    game.practice = true;
    game.endless = { depth: 0, lives: ENDLESS_LIVES, run: (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0, over: false, token: 0, bestBefore: endlessBest() };
    game.retryDeaths = 0;
    set = { date: 'endless', dayNum: 0, rooms: [], bests: [null, null, null, null], shards: [false, false, false, false] };
    game.particles = [];
    game.popups = [];
    endlessNext();
  }
  function endlessNext() {
    const en = game.endless;
    const n = en.depth;
    const index = endlessIndexFor(n);
    const twist = n >= 4 && n % 4 === 0 ? TWIST_KEYS[(en.run + n) % TWIST_KEYS.length] : null;
    const token = ++en.token;
    overlay.classList.remove('card');
    overlay.hidden = false;
    ghostBtn.hidden = true;
    overlay.innerHTML = `<h1>∞ Room ${n + 1}</h1><p class="sub">${cfgFor(index).name}${twist ? ` · ${TWISTS[twist].icon} ${TWISTS[twist].name}` : ''} · ❤ ${en.lives}</p><p class="hint">building…</p><p class="hint">✦ carry a room's shard to the goal: +1 ❤</p><button id="endlessBack" class="secondary">Back</button>`;
    overlay.querySelector('#endlessBack').addEventListener('click', endlessQuit);
    game.state = 'endlessWait';
    const seed = hashString(`daily-jump/endless/${en.run}/${n}`);
    buildRoomAsync(seed, index, twist).then((built) => {
      if (game.mode !== 'endless' || en.token !== token) return; // quit meanwhile
      const data = built || serializeLevel(generateLevel(seed, index, twist)); // worker failed
      const lv = deserializeLevel(data, index, THEME_KEYS[(en.run + n * 3) % THEME_KEYS.length]);
      set.rooms[index] = lv;
      hideOverlay();
      ghostBtn.hidden = false;
      loadLevel(index);
    });
  }
  function endlessClear() {
    const en = game.endless;
    en.depth++;
    // A shard carried to the goal buys a life: risk the detour, or play it safe.
    if (game.level.shard && game.shardHeld) {
      const gained = en.lives < ENDLESS_MAX_LIVES;
      if (gained) en.lives++;
      sfx.shard();
      game.popups.push({ text: gained ? '✦ +1 ❤' : '✦ lives full', x: game.level.goal.x + 11, y: game.level.goal.y - 22, life: 1.4, color: SHARD_GOLD });
    }
    if (en.depth > endlessBest()) { try { localStorage.setItem(ENDLESS_BEST_KEY, String(en.depth)); } catch { /* session */ } }
    celebrate(game.level.goal.x + 11, game.level.goal.y + 14);
    if (en.depth === 10) award('endless10');
    endlessNext();
  }
  function endlessOver() {
    sfx.musicStop();
    const en = game.endless;
    game.state = 'endlessOver';
    ghostBtn.hidden = true;
    overlay.classList.remove('card');
    overlay.hidden = false;
    const best = endlessBest();
    overlay.innerHTML = `<h1>∞ Game over</h1>
      <div class="big">${en.depth} room${en.depth === 1 ? '' : 's'}</div>
      <p class="sub">${en.depth > en.bestBefore ? '✨ new best!' : `your best: ${best}`}</p>
      <button id="endlessAgain">Again</button>
      <button id="endlessBack" class="secondary">Back</button>`;
    overlay.querySelector('#endlessAgain').addEventListener('click', () => startEndless(game.endlessReturn));
    overlay.querySelector('#endlessBack').addEventListener('click', endlessQuit);
  }
  function endlessQuit() {
    if (game.endless) game.endless.token++; // drop a room still being built
    game.mode = 'run';
    game.practice = false;
    set = today;
    if (game.endlessReturn === 'results' && game.shownResult) { game.state = 'results'; showResults(game.shownResult, game.shownPractice); }
    else { game.state = 'title'; game.level = roomAt(0); showTitle(); }
  }
  // ---------- 📲 install ----------
  // A daily game lives on habit: an icon on the home screen is the best "come back
  // tomorrow".  Chrome/Android hand us an install prompt to show on a tap; iPhone
  // Safari has none, so the chip explains Share → Add to Home Screen instead.
  let installEvt = null;
  const standalone = () => !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone);
  const iosSafari = () => /iP(hone|ad|od)/.test(navigator.userAgent || '') && !/CriOS|FxiOS/.test(navigator.userAgent || '');
  const installChip = () => (!standalone() && (installEvt || iosSafari()) ? '<button id="install" class="secondary chip">📲 Install app</button>' : '');
  function bindInstall() {
    const b = overlay.querySelector('#install');
    if (!b) return;
    b.addEventListener('click', async () => {
      if (installEvt) {
        const evt = installEvt;
        installEvt = null;
        evt.prompt();
        try { await evt.userChoice; } catch { /* dismissed */ }
        b.remove();
      } else {
        b.textContent = '📲 Tap Share ⬆, then "Add to Home Screen"';
      }
    });
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // ours to show, on the title, when asked
    installEvt = e;
    const row = game.state === 'title' && overlay.querySelector('.menu-row.chips');
    if (row && !overlay.querySelector('#install')) { row.insertAdjacentHTML('beforeend', installChip()); bindInstall(); }
  });
  window.addEventListener('appinstalled', () => { installEvt = null; const b = overlay.querySelector('#install'); if (b) b.remove(); });

  // ---------- 🎓 How to play ----------
  const TUTORIAL_KEY = 'daily-jump:tutorial';
  const tutorialDone = () => { try { return localStorage.getItem(TUTORIAL_KEY) === '1'; } catch { return false; } };
  let tutorialRoomCache = null;
  function startTutorial() {
    bonusAsk++;
    if (!tutorialRoomCache) { tutorialRoomCache = tutorialLevel(); tutorialRoomCache.theme = 'cloudSea'; }
    game.mode = 'tutorial';
    game.practice = true;
    game.retryDeaths = 0;
    set = { date: 'tutorial', dayNum: 0, rooms: [tutorialRoomCache], bests: [null, null, null, null], shards: [false, false, false, false] };
    game.particles = [];
    game.popups = [];
    hideOverlay();
    ghostBtn.hidden = false;
    loadLevel(0);
  }
  function tutorialQuit(cleared) {
    if (cleared) { try { localStorage.setItem(TUTORIAL_KEY, '1'); } catch { /* session */ } }
    game.mode = 'run';
    game.practice = false;
    set = today;
    game.state = 'title';
    game.level = roomAt(0);
    game.tutorialCleared = cleared;
    showTitle();
    game.tutorialCleared = false;
  }
  function drawSigns(signs) {
    ctx.save();
    ctx.font = '600 13px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const sg of signs) {
      const x = sg.x * TILE;
      const y = sg.y * TILE;
      const w = ctx.measureText(sg.text).width + 14;
      ctx.fillStyle = 'rgba(20, 20, 43, 0.78)';
      ctx.fillRect(x - w / 2, y - 11, w, 22);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(sg.text, x, y + 1);
    }
    ctx.restore();
  }

  function endlessButton() {
    const best = endlessBest();
    return `<button id="endless" class="secondary">∞ Endless${best ? ` <small>(best ${best})</small>` : ''}</button>`;
  }

  // ---------- replay all attempts ----------
  // Super Meat Boy's best moment: after a clear, every attempt you made in the room
  // plays at once — a swarm of Clawds, dying one by one, until the last one makes
  // it.  Each attempt is re-simulated from its recorded inputs (the same
  // deterministic physics as the server's replay check), so nothing is faked.
  const MAX_TRIES = 60;
  function keepTry(rec, won) {
    if (!rec || !rec.length || !game.tries) return;
    game.tries.push({ masks: rec, won });
    game.triesTotal = (game.triesTotal || 0) + 1;
    if (game.tries.length > MAX_TRIES) game.tries.splice(0, game.tries.length - MAX_TRIES);
  }

  function startSwarm() {
    if (game.state !== 'rankCard' || !game.tries || game.tries.length < 2) return;
    card.pendingSting = card.sting; // skipped the reveal? the rank sound plays when the card returns
    hideOverlay();
    game.state = 'swarm';
    game.swarm = {
      clock: 0,
      lastSound: -1,
      end: 0,
      runs: game.tries.map((t, k) => ({ p: makePlayer(game.level.spawn), masks: t.masks, i: 0, done: false, won: false, last: k === game.tries.length - 1 })),
    };
    game.levelClock = 0;
  }

  function endSwarm() {
    if (game.state !== 'swarm') return;
    game.swarm = null;
    game.state = 'rankCard';
    showRankCard(true);
  }

  function stepSwarm(dt) {
    const sw = game.swarm;
    sw.clock += dt;
    game.levelClock = sw.clock; // saws move exactly as they did for every attempt
    let alive = 0;
    for (const r of sw.runs) {
      if (r.done) continue;
      const p = r.p;
      if (r.i >= r.masks.length) { // a restart (R) — it just vanishes
        r.done = true;
        burst(p.x + p.w / 2, p.y + p.h / 2, 8, 'rgba(255,255,255,0.6)');
        continue;
      }
      const m = r.masks[r.i++];
      stepPlayer(p, { left: (m & 1) !== 0, right: (m & 2) !== 0, jumpHeld: (m & 4) !== 0, jumpPressed: (m & 8) !== 0 }, game.level, dt);
      if (hitsHazard(p, game.level, sw.clock)) {
        r.done = true;
        burst(p.x + p.w / 2, p.y + p.h / 2, 14, playerColors().body);
        if (sw.clock - sw.lastSound > 0.07) { sfx.death(); sw.lastSound = sw.clock; } // a swarm dying at once is one splat, not twenty
      } else if (reachedGoal(p, game.level)) {
        r.done = true; r.won = true;
        celebrate(game.level.goal.x + 11, game.level.goal.y + 14);
        sfx.goal();
      } else alive++;
    }
    if (!alive && (sw.end += dt) > 1.2) endSwarm();
  }

  function drawSwarm() {
    const sw = game.swarm;
    ctx.save();
    for (const r of sw.runs) {
      if (r.done && !r.won) continue;
      const p = r.p;
      ctx.globalAlpha = r.last ? 1 : 0.5;
      drawClawd(p.x + p.w / 2, p.y + p.h, p.facing, p.onGround ? 'stand' : 'air', playerColors(), 1, 1, p.clinging);
    }
    ctx.globalAlpha = 1;
    const left = sw.runs.filter((r) => !r.done).length;
    const msg = `${sw.runs.length} attempts · ${left} still going · any key to skip`;
    ctx.font = '700 14px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const w = ctx.measureText(msg).width + 24;
    roundRect(VIEW_W / 2 - w / 2, 40, w, 24, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(msg, VIEW_W / 2, 45);
    ctx.restore();
  }

  // The OS "reduce motion" setting turns off screen shake (everything else stays).
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---------- challenges ----------
  // ?vs=<player id>: a friend's challenge link.  Their verified runs for today race you
  // in every room (purple, with their name), and the title says who challenged you.
  const vsId = /^[0-9a-f-]{36}$/.test(params.get('vs') || '') ? params.get('vs') : null;
  const vsData = API && vsId ? api('GET', `/api/vs/${dateKey}/${vsId}`).catch(() => null) : Promise.resolve(null);
  function showChallenge() {
    vsData.then((vs) => {
      const el = overlay.querySelector('#challenge');
      if (!vs || !el || game.state !== 'title') return;
      const n = vs.rooms.filter((r) => r.room < 3).length;
      el.innerHTML = n
        ? `⚔ <b>${esc(vs.name)}</b> challenged you — race their ghost in ${n} room${n === 1 ? '' : 's'}`
        : `⚔ <b>${esc(vs.name)}</b> challenged you — they haven't set a time today yet`;
      el.hidden = false;
    });
  }
  async function challengeLink() {
    const me = await ensurePlayer();
    const base = shareLink();
    return `${base}${base.includes('?') ? '&' : '?'}vs=${me.id}`;
  }

  // ---------- racers ----------
  // Other players' verified runs, raced live: 👑 the day's fastest, ⚔ the run just
  // above yours, and your own best.  They set off on your first input, so the race
  // is fair to the step — whoever touches the goal first was faster.  V toggles.
  const RACERS_KEY = 'daily-jump:racers';
  let racersOn = true;
  try { racersOn = localStorage.getItem(RACERS_KEY) !== '0'; } catch { /* default on */ }
  const racerCache = new Map(); // "date/room" -> Promise<racers response | null>
  game.racers = [];

  // Your own best run, kept in this browser: raced even offline (or before the server
  // has it), so there's always a ghost of yourself to beat.
  const pbKey = (date, i) => `daily-jump:${date}:pb:${i}`;
  function savePB(i, time, replay) {
    if (dev || game.mode === 'endless' || game.mode === 'tutorial') return;
    try { localStorage.setItem(pbKey(set.date, i), JSON.stringify({ time, replay, at: Date.now() })); } catch { /* full: no local ghost */ }
    // Keep a week of them: replays add up, and a full storage would quietly stop
    // saving results, streaks and badges.
    try {
      // by when each was saved (a past level you just beat keeps its ghost)
      const cutoff = Date.now() - 7 * 86400e3;
      const old = [];
      for (let k = 0; k < localStorage.length; k++) {
        const m = /^daily-jump:(\d{4}-\d{2}-\d{2}):pb:\d$/.exec(localStorage.key(k) || '');
        if (!m) continue;
        let at = 0;
        try { at = Number(JSON.parse(localStorage.getItem(m[0])).at) || 0; } catch { /* unreadable: prune */ }
        if (at < cutoff) old.push(m[0]);
      }
      old.forEach((key) => localStorage.removeItem(key));
    } catch { /* nothing to prune */ }
  }
  function localPB(i) {
    try {
      const pb = JSON.parse(localStorage.getItem(pbKey(set.date, i)));
      return pb && typeof pb.replay === 'string' && Number.isFinite(pb.time) ? pb : null;
    } catch { return null; }
  }

  function loadRacers() {
    game.racers = [];
    if (game.mode === 'endless' || game.mode === 'tutorial') return;
    const lv = game.level;
    const key = `${set.date}/${game.levelIdx}`;
    let pr = API ? racerCache.get(key) : Promise.resolve(null);
    if (!pr) {
      const idx = game.levelIdx;
      pr = Promise.all([
        api('GET', `/api/racers/${key}`).catch(() => { racerCache.delete(key); return null; }), // a blip isn't cached
        set === today ? vsData : Promise.resolve(null),
      ]).then(([r, vs]) => {
        const mineVs = vs && vs.rooms.find((x) => x.room === idx);
        if (!r && !mineVs) return null;
        return { ...(r || {}), vs: mineVs ? { ...mineVs, name: vs.name } : null };
      });
      racerCache.set(key, pr);
    }
    const idxNow = game.levelIdx;
    pr.then((r) => {
      if (game.level !== lv) return; // moved on while we waited
      r = r || {};
      const out = [];
      const add = (e, label, colors, alpha) => {
        const masks = e && decodeReplay(e.replay);
        if (!masks) return;
        let start = 0;
        while (start < masks.length && masks[start] === 0) start++; // idle before the first input
        out.push({ label: `${label} ${formatRoomTime(e.time)}`, colors, alpha, masks, start });
      };
      if (r.top && !r.top.me) add(r.top, `👑 ${r.top.name}`, GOLD_COLORS, 0.6);
      if (r.rival) add(r.rival, `⚔ ${r.rival.name}`, SILVER_COLORS, 0.6);
      if (r.mine) add(r.mine, r.top && r.top.me ? '👑 your best' : 'your best', playerColors(), 0.35);
      else { const pb = localPB(idxNow); if (pb) add(pb, 'your best', playerColors(), 0.35); } // offline / not on the server yet
      if (r.vs && vsId !== (player && player.id)) add(r.vs, `⚔ ${r.vs.name}`, CHALLENGE_COLORS, 0.7); // not your own link
      if (!out.length) return;
      game.racers = out;
      resetRacers();
      // arrived after you'd already set off: put them where they'd be by now
      if (game.state === 'playing' && game.roomStarted) for (let k = 0; k < game.roomSteps; k++) stepRacers();
    });
  }

  function resetRacers() {
    for (const r of game.racers) {
      r.p = makePlayer(game.level.spawn);
      r.i = r.start;
      r.done = false;
      r.fade = 1;
    }
  }

  function stepRacers() {
    for (const r of game.racers) {
      if (!r.p) continue;
      if (r.done) { r.fade = Math.max(0, r.fade - DT * 1.5); continue; }
      if (r.i >= r.masks.length) { r.done = true; continue; } // touched the goal on its last step
      const m = r.masks[r.i++];
      stepPlayer(r.p, { left: (m & 1) !== 0, right: (m & 2) !== 0, jumpHeld: (m & 4) !== 0, jumpPressed: (m & 8) !== 0 }, game.level, DT);
    }
  }

  // Bodies go under the player; name tags (tags = true) go on top of everything.
  function drawRacers(tags = false) {
    if (!racersOn || !game.racers.length) return;
    ctx.save();
    ctx.font = '700 11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const placed = []; // name tags already drawn this frame: stack instead of overlapping
    for (const r of game.racers) {
      const p = r.p;
      if (!p || r.fade <= 0) continue;
      if (!tags) {
        ctx.globalAlpha = r.alpha * r.fade;
        drawClawd(p.x + p.w / 2, p.y + p.h, p.facing, p.onGround ? 'stand' : 'air', r.colors, 1, 1, p.clinging);
        continue;
      }
      const w = ctx.measureText(r.label).width;
      const x = p.x + p.w / 2;
      let y = p.y - 6;
      while (placed.some((q) => Math.abs(q.x - x) < (q.w + w) / 2 + 4 && Math.abs(q.y - y) < 13)) y -= 13;
      placed.push({ x, y, w });
      ctx.globalAlpha = Math.min(0.9, r.alpha + 0.25) * r.fade;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(r.label, x + 1, y + 1);
      ctx.fillStyle = '#fff';
      ctx.fillText(r.label, x, y);
    }
    ctx.restore();
  }

  function toggleRacers() {
    racersOn = !racersOn;
    try { localStorage.setItem(RACERS_KEY, racersOn ? '1' : '0'); } catch { /* session only */ }
    const p = game.player;
    const msg = !racersOn ? 'racers off' : game.racers.length ? 'racers on' : 'racers on — nobody to race in this room yet';
    game.popups.push({ text: msg, x: p.x + p.w / 2, y: p.y - 10, life: 1.2, color: '#ffffff' });
  }

  // Updrafts: a soft column of light with streaks drifting upward.
  function drawUpdrafts(list) {
    ctx.save();
    for (const u of list) {
      const grad = ctx.createLinearGradient(0, u.y, 0, u.y + u.h);
      grad.addColorStop(0, 'rgba(180,240,255,0)');
      grad.addColorStop(1, 'rgba(180,240,255,0.22)');
      ctx.fillStyle = grad;
      ctx.fillRect(u.x, u.y, u.w, u.h);
      ctx.strokeStyle = 'rgba(220,250,255,0.55)';
      ctx.lineWidth = 2;
      for (let k = 0; k < 6; k++) {
        const x = u.x + 6 + ((k * 13) % (u.w - 12));
        const y = u.y + u.h - ((artT * 90 + k * 37) % u.h);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, Math.max(u.y, y - 14));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ---------- first-time tips ----------
  // Procedural rooms can't teach the way hand-built first levels do, so each core
  // idea gets one short tip the first time it matters — then never again.  Worded
  // for whatever you're playing with (keys, pad or touch).
  const TIPS_KEY = 'daily-jump:tips';
  let seenTips = {};
  try { seenTips = JSON.parse(localStorage.getItem(TIPS_KEY)) || {}; } catch { /* show them all */ }
  const btnName = (what) => (touch.on ? { restart: '↻', ghost: 'the 👻 button' } : pad.used ? { restart: 'Y', ghost: 'X' } : { restart: 'R', ghost: 'G' })[what];
  const TIPS = {
    wall: () => 'Jump while sliding = wall kick. Hold toward the wall to climb it, away to leap off.',
    deaths: () => `Deaths are free — the room clock restarts every try. ${btnName('restart')} restarts instantly.`,
    stuck: () => `Stuck? ${btnName('ghost')} shows how the level-checker beat this room (marks your result 👻).`,
    locked: () => 'This goal is locked 🔒 — grab the 🔑 first.',
    switches: () => 'Red ● and blue ■ blocks swap every time you jump — plan which colour you land on.',
    belts: () => 'Conveyor belts carry you: run with one for speed, jump off it to keep that speed.',
    flag: () => `Drill the hard part: ${touch.on ? '🚩' : pad.used ? 'RB' : 'F'} plants a 🚩 practice flag where you stand — respawns start there.`,
  };
  const tipQueue = [];
  function tip(id) {
    if (dev || seenTips[id]) return;
    if (game.tip) { if (!tipQueue.includes(id)) tipQueue.push(id); return; } // one at a time: the next waits its turn
    seenTips[id] = 1;
    try { localStorage.setItem(TIPS_KEY, JSON.stringify(seenTips)); } catch { /* shown once per session then */ }
    game.tip = { text: TIPS[id](), life: 6 };
  }

  // Tips show in the strip under the room (or the side gutter on phones): the
  // playfield itself is never covered.
  const tipEl = document.getElementById('tip');
  function syncTip() {
    if (!tipEl) return;
    const show = !!game.tip && (game.state === 'playing' || game.state === 'dying');
    if (show && tipEl.textContent !== game.tip.text) tipEl.textContent = game.tip.text;
    if (tipEl.hidden === show) tipEl.hidden = !show;
  }

  function completeLevel() {
    sfx.goal();
    if (game.mode === 'endless') { endlessClear(); return; }
    if (game.mode === 'tutorial') { celebrate(game.level.goal.x + 11, game.level.goal.y + 14); tutorialQuit(true); return; }
    const shardNow = !!(game.level.shard && game.shardHeld);
    game.shardClear = shardNow ? { first: recordShard(game.levelIdx) } : null;
    // The room clock restarts on every respawn, so this is the clean attempt only.
    const t = game.roomTime;
    const i = game.levelIdx;
    const firstClear = !set.bests[i];
    const prevBest = firstClear ? null : set.bests[i].time; // for the split: −0.34 vs your best
    const newBest = recordBest(i, t, game.attemptGhost, game.attemptAssist);
    if (game.attemptAssist && !solo()) game.runAssist = true;
    game.lastClear = { time: t, rank: rankFor(t, game.level.ghostTime), newBest, prevBest };
    award('first');
    const statCard = card.id + 1; // the card shown just below
    sendStat('clear', i).then((st) => {
      if (!st || card.id !== statCard || game.state !== 'rankCard') return;
      const el = overlay.querySelector('#cardCrowd');
      const pct = st.entered >= 5 ? ` — ${Math.min(100, Math.round((100 * st.cleared) / st.entered))}% of those who tried` : '';
      card.crowd = st.cleared === 1 ? '🏁 first to clear this room today!' : `🏁 you're one of ${st.cleared} players to clear this room today${pct}`;
      if (el) el.textContent = card.crowd;
    });
    if (game.lastClear.rank.name === 'S' && !game.attemptGhost && !game.attemptAssist) award('sharp');
    if (game.lastClear.rank.name === 'IMPOSSIBLE' && !game.attemptGhost && !game.attemptAssist) award('impossible');
    if (shardNow) award('shiny');
    if (i === BONUS_ROOM) award('nightmare');
    if (!solo() && !game.practice && game.deaths[i] === 0) award('flawless');
    celebrate(game.level.goal.x + 11, game.level.goal.y + 14);
    keepTry(game.rec, true);
    const replay = encodeReplay(game.rec);
    if ((firstClear || newBest) && !game.attemptAssist) savePB(i, t, replay);
    if (!solo()) {
      game.runRoomTimes[i] = t;
      game.runReplays[i] = replay;
    }
    game.state = 'rankCard'; // the run clock doesn't tick while the card is up
    showRankCard();
    // Send personal bests (and first clears) with their replay: the server re-runs
    // the replay itself and answers with the verified time and today's placing.
    if (canSubmit() && (firstClear || newBest)) submitAttempt(i, replay, game.attemptGhost, card.id, game.attemptAssist);
    else setCardNet(card.id, API && !dev ? 'not a new best — not submitted' : '');
  }

  // Anonymous room counters: one "enter" and one "clear" per room per day from this
  // browser (deduped here), for "cleared by 23% of players who tried today".
  const statsInFlight = new Set();
  async function sendStat(event, room) {
    if (!canSubmit() || set !== today) return null;
    const key = `daily-jump:${dateKey}:stat:${event}:${room}`;
    try { if (localStorage.getItem(key)) return null; } catch { return null; }
    if (statsInFlight.has(key)) return null; // a second loadLevel during the round-trip
    statsInFlight.add(key);
    try {
      const r = await api('POST', '/api/stats', { date: dateKey, room, event });
      try { localStorage.setItem(key, '1'); } catch { /* may count twice */ } // only once it counted
      return r;
    } catch { return null; } finally { statsInFlight.delete(key); }
  }

  async function submitAttempt(room, replay, ghost, cardId, assisted = false) {
    setCardNet(cardId, '⏳ verifying with the server…');
    const date = set.date; // before any await: Back may switch `set` meanwhile
    racerCache.delete(`${date}/${room}`); // your best (and who's just above you) is changing
    try {
      await ensurePlayer();
      const r = await api('POST', '/api/attempts', { date, room, replay, ghost, assist: assisted });
      racerCache.delete(`${date}/${room}`); // and again, in case a retry fetched the old one meanwhile
      const when = date === today.date ? 'today' : `on ${niceDate(date)}`;
      // "faster than N%" once there's a crowd to be faster than
      const pct = r.of >= 3 ? ` · faster than ${Math.round((100 * (r.of - r.place)) / (r.of - 1))}% of the others` : '';
      setCardNet(cardId, `✓ verified · ${r.improved ? 'new best · ' : ''}#${r.place} of ${r.of} ${when}${pct}`, 'ok');
    } catch (err) {
      setCardNet(cardId, err.status === 422 ? `⚠ server could not verify this run: ${err.message}` : '⚠ offline — not submitted', 'bad');
    }
  }

  function setCardNet(cardId, text, kind = '') {
    if (card.id !== cardId) return; // that card is gone
    card.net = [text, kind];
    if (game.state !== 'rankCard') return; // replaying: shown when the card comes back
    const el = overlay.querySelector('#cardNet');
    if (!el) return;
    el.textContent = text;
    el.className = `card-net ${kind}`;
  }

  // What the card's main button does.
  function cardNext() {
    if (solo()) leaveSolo(game.levelIdx);
    else if (game.levelIdx < LEVELS.length - 1) { hideOverlay(); ghostBtn.hidden = false; loadLevel(game.levelIdx + 1); }
    else finishRun();
  }

  function cardRetry() {
    if (!solo()) return;
    game.retryDeaths = 0;
    hideOverlay();
    ghostBtn.hidden = false;
    loadLevel(game.levelIdx);
  }

  function startRetry(i) {
    bonusAsk++; // a pending bonus load must not pull you in later
    set = today;
    game.mode = 'retry';
    game.retryDeaths = 0;
    game.particles = [];
    game.popups = [];
    hideOverlay();
    ghostBtn.hidden = false;
    loadLevel(i);
  }

  // The bonus room plays like a retry: one room, back to the results after.  It comes
  // from the server (stored on first open) so its replays verify; offline it's built here.
  let bonusLoading = null;
  let bonusAsk = 0; // which click is waiting; any other start cancels it
  function startBonus() {
    const ask = ++bonusAsk;
    if (!bonusLoading) {
      bonusLoading = (async () => {
        if (today.rooms[BONUS_ROOM]) return;
        if (API) {
          try {
            const b = await api('GET', `/api/bonus/${dateKey}`);
            today.rooms[BONUS_ROOM] = deserializeLevel(b.level, BONUS_ROOM, b.theme);
            return;
          } catch { /* build it here */ }
        }
        roomAt(BONUS_ROOM);
      })().finally(() => { bonusLoading = null; });
    }
    const btn = overlay.querySelector('#bonus');
    if (btn) { btn.disabled = true; btn.textContent = 'Summoning the Nightmare…'; }
    return bonusLoading.then(() => { if (ask === bonusAsk && game.state === 'results') startRetry(BONUS_ROOM); });
  }

  function backToResults(highlight) {
    game.mode = 'run';
    game.state = 'results';
    showResults(game.shownResult, game.shownPractice, highlight);
  }

  function finishRun() {
    if (solo()) { leaveSolo(null); return; }
    const result = {
      time: game.time, deaths: game.deaths.slice(), ghost: game.ghostUsed,
      cornerKicks: game.cornerKicks, roomTimes: game.runRoomTimes.slice(), ...(game.runAssist ? { assist: true } : {}),
    };
    // ?date= plays another day's rooms; only the real day counts toward the streak
    if (!game.practice && !dev && (!forcedDate || forcedDate === dateKeyFor(new Date()))) saveResult(result);
    if (!game.practice) {
      if (result.deaths.every((d) => d === 0)) award('perfect');
      if (dayTwist()) award('twisted');
      const withShard = LEVELS.map((_, k) => roomAt(k)).filter((r) => r.shard).length;
      if (withShard && LEVELS.every((_, k) => !roomAt(k).shard || today.shards[k])) award('collector');
      const st = streak().current;
      if (st >= 3) award('streak3');
      if (st >= 7) award('streak7');
    }
    if (!game.practice && canSubmit() && game.runReplays.length === LEVELS.length) {
      ensurePlayer()
        .then(() => api('POST', '/api/runs', {
          date: dateKey, replays: game.runReplays, totalTime: result.time, deaths: result.deaths,
          cornerKicks: result.cornerKicks, ghost: result.ghost, assist: !!result.assist,
        }))
        .then(() => { if (game.state === 'results') loadBoard(); })
        .catch(() => { /* bests were already sent room by room */ });
    }
    game.state = 'results';
    // what the 📸 death map needs, tied to this very result
    game.mapRun = { result, deaths: game.runDeaths.map((d) => d.slice()), replays: game.runReplays.slice() };
    showResults(result, game.practice);
  }

  // ---------- 📸 death map ----------
  // Super Meat Boy's "every death at once", as a picture: all three rooms with an ✕
  // where you died and the line of the run that cleared it, plus a summary tile.
  function deathMapCanvas(run, practice) {
    const out = makeLayer();
    const g = out.g;
    const W = VIEW_W / 2;
    const H = VIEW_H / 2;
    const result = run.result;
    for (let i = 0; i < 3; i++) {
      const lv = roomAt(i);
      const ox = (i % 2) * W;
      const oy = Math.floor(i / 2) * H;
      g.save();
      g.beginPath();
      g.rect(ox, oy, W, H);
      g.clip();
      g.translate(ox, oy);
      g.scale(0.5, 0.5);
      const art = roomArt(lv);
      g.drawImage(art.bg, 0, 0, VIEW_W, VIEW_H);
      g.drawImage(art.fg, 0, 0, VIEW_W, VIEW_H);
      g.drawImage(art.spikes, 0, 0, VIEW_W, VIEW_H);
      for (let cy = 0; cy < ROWS; cy++) {
        for (let cx = 0; cx < COLS; cx++) {
          const c = lv.grid[cy * COLS + cx];
          if (isBelt(c)) { g.fillStyle = '#ffb000'; g.fillRect(cx * TILE, cy * TILE, TILE, TILE); continue; }
          if (!isSwitch(c)) continue;
          g.globalAlpha = c === SWITCH_A ? 1 : 0.35; // as they start: red solid, blue ghost
          g.fillStyle = SWITCH_COLORS[c][0];
          g.fillRect(cx * TILE + 1, cy * TILE + 1, TILE - 2, TILE - 2);
          g.globalAlpha = 1;
        }
      }
      for (const sw of lv.saws) {
        const q = sawPos(sw, 0);
        g.fillStyle = '#6b6f7a';
        g.beginPath();
        g.arc(q.x, q.y, sw.r, 0, Math.PI * 2);
        g.fill();
      }
      // the goal: a gold star where every line ends
      {
        const gx = lv.goal.x + lv.goal.w / 2;
        const gy = lv.goal.y + lv.goal.h / 2;
        g.fillStyle = '#ffd166';
        g.strokeStyle = 'rgba(0,0,0,0.6)';
        g.lineWidth = 3;
        g.beginPath();
        for (let k = 0; k < 10; k++) {
          const a = -Math.PI / 2 + (k * Math.PI) / 5;
          const r = k % 2 ? 7 : 17;
          g.lineTo(gx + Math.cos(a) * r, gy + Math.sin(a) * r);
        }
        g.closePath();
        g.stroke();
        g.fill();
      }
      // the clearing run, re-simulated from its replay
      const masks = run.replays[i] ? decodeReplay(run.replays[i]) : null;
      if (masks && masks.length) {
        const p = makePlayer(lv.spawn);
        const pts = [[p.x + p.w / 2, p.y + p.h / 2]];
        masks.forEach((m, k) => {
          stepPlayer(p, { left: (m & 1) !== 0, right: (m & 2) !== 0, jumpHeld: (m & 4) !== 0, jumpPressed: (m & 8) !== 0 }, lv, DT);
          if (k % 3 === 0 || k === masks.length - 1) pts.push([p.x + p.w / 2, p.y + p.h / 2]);
        });
        g.lineJoin = 'round';
        g.lineCap = 'round';
        for (const [w, col] of [[9, 'rgba(0,0,0,0.55)'], [4, '#ffffff']]) {
          g.lineWidth = w;
          g.strokeStyle = col;
          g.beginPath();
          pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
          g.stroke();
        }
      }
      for (const d of run.deaths[i]) {
        for (const [w, col] of [[9, '#ffffff'], [5, '#e5243b']]) {
          g.lineWidth = w;
          g.strokeStyle = col;
          g.beginPath();
          g.moveTo(d.x - 9, d.y - 9); g.lineTo(d.x + 9, d.y + 9);
          g.moveTo(d.x + 9, d.y - 9); g.lineTo(d.x - 9, d.y + 9);
          g.stroke();
        }
      }
      g.restore();
      const rank = rankFor(result.roomTimes[i], lv.ghostTime);
      const label = `ROOM ${i + 1}  ·  💀 ${result.deaths[i]}  ·  ${formatRoomTime(result.roomTimes[i])}  ·  ${rank.name}`;
      g.font = '700 15px system-ui, -apple-system, sans-serif';
      g.textBaseline = 'top';
      g.textAlign = 'left';
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(ox + 8, oy + 8, g.measureText(label).width + 16, 26);
      g.fillStyle = '#ffffff';
      g.fillText(label, ox + 16, oy + 13);
    }
    // the summary tile
    const ox = W;
    const oy = H;
    g.fillStyle = '#14142b';
    g.fillRect(ox, oy, W, H);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#ffd166';
    g.font = '800 26px system-ui, -apple-system, sans-serif';
    g.fillText(`DAILY JUMP #${dayNum}${practice ? ' · practice' : ''}`, ox + W / 2, oy + 52);
    g.fillStyle = '#ffffff';
    g.font = '800 64px system-ui, -apple-system, sans-serif';
    g.fillText(formatTime(result.time), ox + W / 2, oy + 128);
    const total = result.deaths.reduce((a, b) => a + b, 0);
    g.font = '700 24px system-ui, -apple-system, sans-serif';
    g.fillText(`💀 ${total} death${total === 1 ? '' : 's'}${result.ghost ? '  ·  👻' : ''}${result.assist ? '  ·  🐢' : ''}`, ox + W / 2, oy + 172);
    const ranks = result.roomTimes.map((t, i) => rankFor(t, roomAt(i).ghostTime));
    const cell = W / 3;
    ranks.forEach((r, i) => {
      g.fillStyle = r.color;
      g.font = r.name.length > 2 ? '800 17px system-ui, -apple-system, sans-serif' : '800 34px system-ui, -apple-system, sans-serif';
      g.fillText(r.name, ox + cell * (i + 0.5), oy + 222);
    });
    const link = (shareLink() || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (link) {
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.font = '600 14px system-ui, -apple-system, sans-serif';
      g.fillText(link, ox + W / 2, oy + H - 16);
    }
    return out.c;
  }

  async function shareDeathMap(btn, run, practice) {
    const c = deathMapCanvas(run, practice);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    if (!blob) { btn.textContent = '⚠ could not draw the map'; return; }
    const name = `daily-jump-${dayNum}.png`;
    let preview = overlay.querySelector('#mapPreview');
    if (!preview) {
      preview = document.createElement('img');
      preview.id = 'mapPreview';
      preview.className = 'map-preview';
      preview.alt = 'Your death map: every room, every death, and your clearing line';
      btn.parentNode.insertAdjacentElement('afterend', preview);
    }
    const url = URL.createObjectURL(blob);
    if (preview.src && preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src);
    preview.src = url;
    if (canShareSheet() && typeof File === 'function') {
      const file = new File([blob], name, { type: 'image/png' });
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], text: shareText(run.result) }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
      }
    }
    const a = document.createElement('a'); // desktop: save it
    a.href = url;
    a.download = name;
    a.click();
    btn.textContent = '📸 Saved!';
  }

  // ---------- particles & gore ----------
  // A clear: confetti in the game's colours and a ring rippling out from the goal.
  const CONFETTI = ['#ffd166', '#ff8fa3', '#9ad1ff', '#7bd88f', '#c77dff'];
  // Dust: a few soft puffs, sideways along the ground (dir 0) or away from a wall.
  function dust(x, y, dir, n) {
    if (reduceMotion) return;
    for (let i = 0; i < n; i++) {
      const side = dir || (i % 2 ? 1 : -1);
      game.particles.push({
        x: x + (Math.random() - 0.5) * 6, y: y - 2 - Math.random() * 4,
        vx: side * (40 + Math.random() * 90), vy: -20 - Math.random() * 50,
        life: 0.22 + Math.random() * 0.12, color: 'rgba(196,184,166,0.85)', // warm grey: shows on light skies and dark caves
      });
    }
  }

  function celebrate(x, y) {
    for (let i = 0; i < 40; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const sp = 220 + Math.random() * 380;
      game.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.7 + Math.random() * 0.5, color: CONFETTI[i % CONFETTI.length] });
    }
    game.rings.push({ x, y, r: 6, life: 0.45 });
  }

  function burst(x, y, n, color) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 120 + Math.random() * 300;
      game.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 140,
        life: 0.5 + Math.random() * 0.4, color,
      });
    }
  }

  // Meat Boy leaves the room looking like a crime scene. So does this.
  function addSplat(x, y) {
    for (let i = 0; i < 5; i++) {
      game.splats.push({
        x: x + (Math.random() - 0.5) * 34,
        y: y + (Math.random() - 0.5) * 26,
        r: 3 + Math.random() * 7,
      });
    }
    if (game.splats.length > 90) game.splats.splice(0, game.splats.length - 90);
  }

  // ---------- update ----------
  function update(dt) {
    // Hit-stop: a death freezes the splat for a few frames so the hit *lands* — purely
    // visual (the death window and every clock keep running).
    const frozen = game.hitstop > 0;
    if (frozen) game.hitstop -= dt;
    if (game.flash > 0) game.flash = Math.max(0, game.flash - dt * 5);
    for (const r of game.rings) { r.r += 260 * dt; r.life -= dt; }
    game.rings = game.rings.filter((r) => r.life > 0);
    for (const pt of frozen ? [] : game.particles) {
      pt.vy += 1100 * dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.life -= dt;
    }
    game.particles = game.particles.filter((pt) => pt.life > 0);
    for (const pu of game.popups) {
      pu.y -= 40 * dt;
      pu.life -= dt;
    }
    game.popups = game.popups.filter((pu) => pu.life > 0);
    if (game.tip && (game.tip.life -= dt) <= 0) { game.tip = null; if (tipQueue.length) tip(tipQueue.shift()); }
    game.squash = Math.abs(game.squash) < 0.01 ? 0 : game.squash * (1 - dt * 7);
    game.shake = Math.max(0, game.shake - dt);
    game.intro = Math.max(0, (game.intro || 0) - dt);
    game.swapT = Math.max(0, (game.swapT || 0) - dt);

    if (game.state === 'playing') {
      // Clocks start on your first input — move or jump — not when the room appears.
      if (!game.roomStarted && (keys.left || keys.right || keys.jump || jumpQueued)) {
        game.roomStarted = true;
        game.runClockOn = true;
      }
      if (game.runClockOn) game.time += dt;
      if (game.roomStarted) game.roomSteps++;
      game.levelClock += dt;
      const input = { left: keys.left, right: keys.right, jumpHeld: keys.jump, jumpPressed: jumpQueued };
      jumpQueued = false;
      if (game.rec.length < MAX_REPLAY_STEPS) game.rec.push(inputMask(input));
      const p = game.player;
      const fallSpeed = p.vy;
      stepPlayer(p, input, game.level, dt);
      if (p.landed) {
        game.squash = 1;
        if (fallSpeed > 160) sfx.land(fallSpeed); // no thud for walking off a step
        if (fallSpeed > 380) dust(p.x + p.w / 2, p.y + p.h, 0, Math.min(10, Math.round(fallSpeed / 90))); // a hard landing kicks up dust
      }
      if (p.sprung) {
        award('boing');
        game.squash = -1;
        sfx.spring();
        burst(p.x + p.w / 2, p.y + p.h, 12, '#ffd166');
      }
      if (p.jumped) {
        game.squash = -0.8;
        if (p.cornerKicked) sfx.cornerKick();
        else if (p.wallJumped) sfx.wallKick();
        else sfx.jump();
        if (game.level.switches) { sfx.swap(); game.swapT = 0.14; }
        // a puff where you pushed off: under your feet, or off the wall you kicked
        if (p.wallJumped || p.cornerKicked) dust(p.facing > 0 ? p.x : p.x + p.w, p.y + p.h * 0.6, p.facing, 6);
        else dust(p.x + p.w / 2, p.y + p.h, 0, 5);
      }
      if (p.onGround) game.walkPhase += Math.abs(p.vx) * dt;
      if (p.sliding) {
        game.slideAnim += dt;
        if (game.slideAnim > 0.25) tip('wall');
      }
      if (p.cornerKicked) {
        award('corner');
        game.cornerKicks++;
        burst(p.x + p.w / 2, p.y, 18, '#ffd166');
        game.popups.push({ text: 'CORNER KICK!', x: p.x + p.w / 2, y: p.y - 8, life: 0.9, color: '#ffd166' });
        game.shake = Math.max(game.shake, 0.12);
      }
      if (p.sliding) {
        game.slideDust -= dt;
        if (game.slideDust <= 0) {
          game.slideDust = 0.04;
          const sx = p.wallLeft ? p.x : p.x + p.w;
          game.particles.push({
            x: sx, y: p.y + p.h - 4, vx: (p.wallLeft ? 40 : -40) * Math.random(),
            vy: -60 * Math.random(), life: 0.25, color: 'rgba(255,255,255,0.55)',
          });
        }
      }
      if (game.ghostOn) game.attemptGhost = true;
      if (assist < 1) game.attemptAssist = true;
      const gh = game.ghost;
      if (gh) {
        if (!gh.done) {
          stepGhost(gh, game.level);
          // Point out the trick when the ghost pulls one — that's how people find it.
          if (gh.p.cornerKicked && game.ghostOn) {
            game.popups.push({ text: 'corner kick', x: gh.p.x + gh.p.w / 2, y: gh.p.y - 8, life: 0.9, color: '#9ad1ff' });
          }
        }
        else if ((gh.wait += dt) > 1) game.ghost = makeGhost(game.level, GHOST_DELAY); // loop
      }
      if (game.roomStarted) stepRacers();
      if (p.gotKey) {
        sfx.shard();
        burst(p.x + p.w / 2, p.y + p.h / 2, 18, '#ffd166');
        game.popups.push({ text: '🔑 goal unlocked!', x: p.x + p.w / 2, y: p.y - 8, life: 1.2, color: '#ffd166' });
      }
      const sh = game.level.shard;
      if (sh && !game.shardHeld && overlaps(p, sh)) {
        game.shardHeld = true;
        sfx.shard();
        burst(sh.x + sh.w / 2, sh.y + sh.h / 2, 22, SHARD_GOLD);
        game.popups.push({ text: '✦ shard — now reach the goal', x: sh.x + sh.w / 2, y: sh.y - 6, life: 1.2, color: SHARD_GOLD });
      }
      if (!devState.god && hitsHazard(p, game.level, game.levelClock)) die();
      else if (reachedGoal(p, game.level)) {
        if (game.attemptFlag) { // practice from a flag: no card, no best — straight back to the flag
          sfx.goal();
          celebrate(game.level.goal.x + 11, game.level.goal.y + 14);
          game.popups.push({ text: `🚩 section cleared · ${formatRoomTime(game.roomTime)}`, x: game.level.goal.x + 11, y: game.level.goal.y - 8, life: 1.4, color: '#ffd166' });
          respawn();
        } else completeLevel();
      }
    } else if (game.state === 'swarm') {
      stepSwarm(dt);
    } else if (game.state === 'dying') {
      if (game.runClockOn) game.time += dt;
      game.stateTimer -= dt;
      if (game.stateTimer <= 0) {
        if (game.mode === 'endless' && game.endless.over) endlessOver();
        else respawn();
      }
    } else {
      game.levelClock += dt; // keep the menu backdrop alive
    }
  }

  // ---------- render ----------
  // ---------- themes ----------
  // Each level carries its theme (stored with it on the server); dev mode can
  // override it per level.
  const themeKeyOf = (lv) => lv.themeOverride || lv.theme || themesForDay(dateKey)[lv.index];
  // High contrast (accessibility): hazards in colours nothing else uses, with bold
  // outlines; platform edges white; the backdrop dimmed further.  Cosmetic only.
  const CONTRAST_KEY = 'daily-jump:contrast';
  let highContrast = false;
  try { highContrast = localStorage.getItem(CONTRAST_KEY) === '1'; } catch { /* off */ }
  const hcCache = new Map();
  const themeOf = (lv) => {
    const th = THEMES[themeKeyOf(lv)];
    if (!highContrast) return th;
    if (!hcCache.has(th)) {
      hcCache.set(th, { ...th, spike: '#ff2bd6', spikeLine: '#ffffff', saw: '#ffe600', sawLine: '#000000', edge: '#ffffff', edge2: '#ffffff', glow: false, fog: [th.fog[0], Math.min(0.75, th.fog[1] + 0.35)] });
    }
    return hcCache.get(th);
  };
  function toggleContrast() {
    highContrast = !highContrast;
    try { localStorage.setItem(CONTRAST_KEY, highContrast ? '1' : '0'); } catch { /* session */ }
    return highContrast;
  }
  let dpr = 1;
  let artT = 0; // seconds of animation time, for weather
  // Each room's static art is painted once into two layers and reused every frame:
  // bg = sky + scenery, fg = tiles + spikes.  Only weather, saws and actors are live.
  let artCache = new WeakMap(); // level -> { key, art }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = VIEW_W * dpr;
    canvas.height = VIEW_H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    artCache = new WeakMap();
  }

  function makeLayer() {
    const c = document.createElement('canvas');
    c.width = VIEW_W * dpr;
    c.height = VIEW_H * dpr;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, g };
  }

  function roomArt(lv) {
    const key = `${lv.index}:${themeKeyOf(lv)}`;
    const cacheKey = key + (highContrast ? ':hc' : ''); // same scenery, repainted for contrast
    const cached = artCache.get(lv);
    if (cached && cached.key === cacheKey) return cached.art;
    {
      const th = themeOf(lv);
      const rng = mulberry32((lv.hillSeed ^ hashString(key)) >>> 0);
      const bg = makeLayer();
      paintSky(bg.g, th);
      BACKDROPS[th.backdrop](bg.g, th, rng);
      bg.g.globalAlpha = th.fog[1];
      bg.g.fillStyle = th.fog[0];
      bg.g.fillRect(0, 0, VIEW_W, VIEW_H);
      bg.g.globalAlpha = 1;
      const fg = makeLayer();
      paintTiles(fg.g, lv, th, rng);
      if (lv.twist === 'ice') paintIce(fg.g, lv);
      paintSprings(fg.g, lv, th);
      paintPlanks(fg.g, lv, th);
      const spikes = makeLayer();
      paintSpikes(spikes.g, lv, th);
      const art = { bg: bg.c, fg: fg.c, spikes: spikes.c };
      artCache.set(lv, { key: cacheKey, art });
      return art;
    }
  }

  function paintSky(g, th) {
    const sky = g.createLinearGradient(0, 0, 0, VIEW_H);
    th.sky.forEach((c, k) => sky.addColorStop(k / (th.sky.length - 1), c));
    g.fillStyle = sky;
    g.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  function glow(g, color, blur) {
    g.shadowColor = color;
    g.shadowBlur = blur;
  }

  function mixHex(a, b, t) {
    const p = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
    const A = p(a);
    const B = p(b);
    return `rgb(${A.map((v, k) => Math.round(v + (B[k] - v) * t)).join(',')})`;
  }

  const MIST = '#5a5a9a';

  // Mt. Fuji, far off: a wide cone with gently concave flanks and a flat crater top,
  // its right side catching the moon, under a snowcap with a ragged lower edge.
  function fuji(g, cx, baseY) {
    const peakY = 205;
    const halfBase = 290;
    const halfTop = 26;
    const flank = (side) => [cx + side * halfTop, peakY, cx + side * halfBase * 0.42, baseY - 90, cx + side * halfBase, baseY];
    const cone = () => {
      g.beginPath();
      const [lx0, ly0, lcx, lcy, lx1, ly1] = flank(-1);
      const [rx0, ry0, rcx, rcy, rx1, ry1] = flank(1);
      g.moveTo(lx1, ly1);
      g.quadraticCurveTo(lcx, lcy, lx0, ly0);
      g.lineTo(rx0, ry0);
      g.quadraticCurveTo(rcx, rcy, rx1, ry1);
      g.closePath();
    };
    cone();
    g.fillStyle = '#262f63';
    g.fill();
    // moonlit right flank
    g.save();
    cone();
    g.clip();
    g.fillStyle = '#323c78';
    g.beginPath();
    g.moveTo(cx + 4, peakY);
    g.lineTo(cx + halfBase + 40, baseY);
    g.lineTo(cx + 60, baseY);
    g.closePath();
    g.fill();
    // snowcap: everything above a zig-zag line about a third of the way down
    const snowY = peakY + 70;
    g.beginPath();
    g.moveTo(cx - 200, peakY - 10);
    g.lineTo(cx + 200, peakY - 10);
    g.lineTo(cx + 200, snowY);
    for (let k = 0, x = cx + 200; x > cx - 200; k++) {
      x -= 18;
      g.lineTo(x, snowY + (k % 2 ? 14 : -6) + (k % 3) * 4);
    }
    g.closePath();
    g.fillStyle = '#c4cbef';
    g.fill();
    g.fillStyle = '#eef1ff'; // the moon side of the snow
    g.beginPath();
    g.moveTo(cx + 4, peakY);
    g.lineTo(cx + 120, snowY + 30);
    g.lineTo(cx + 20, snowY + 30);
    g.closePath();
    g.fill();
    g.restore();
  }

  // A five-storey pagoda in silhouette: each storey a little narrower than the one
  // below, eaves sweeping up at the tips, a ringed spire on top, a few warm windows.
  function pagoda(g, cx, baseY) {
    const dark = '#121428';
    const rim = 'rgba(170,170,240,0.35)';
    let y = baseY;
    g.fillStyle = dark;
    g.fillRect(cx - 34, y - 14, 68, 14); // stone base
    y -= 14;
    for (let k = 0; k < 5; k++) {
      const bodyW = 50 - k * 6;
      const roofW = 94 - k * 10;
      const bodyH = 26 - k * 1.5;
      g.fillStyle = dark;
      g.fillRect(cx - bodyW / 2, y - bodyH, bodyW, bodyH);
      // warm windows on the lower storeys
      if (k < 4) {
        g.save();
        glow(g, '#ffb35c', 10);
        g.fillStyle = '#ffc47a';
        g.fillRect(cx - 4, y - bodyH + 7, 8, 9);
        g.restore();
      }
      y -= bodyH;
      // roof: a thin slab whose ends curve up into points
      g.fillStyle = dark;
      g.beginPath();
      g.moveTo(cx - roofW / 2, y - 9);
      g.quadraticCurveTo(cx - roofW * 0.32, y + 2, cx - bodyW / 2 - 4, y + 1);
      g.lineTo(cx + bodyW / 2 + 4, y + 1);
      g.quadraticCurveTo(cx + roofW * 0.32, y + 2, cx + roofW / 2, y - 9);
      g.quadraticCurveTo(cx + roofW * 0.25, y - 4, cx + bodyW / 2 - 6, y - 12);
      g.lineTo(cx - bodyW / 2 + 6, y - 12);
      g.quadraticCurveTo(cx - roofW * 0.25, y - 4, cx - roofW / 2, y - 9);
      g.closePath();
      g.fill();
      g.strokeStyle = rim; // moonlight along the right half of each roof edge
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(cx, y - 12);
      g.lineTo(cx + bodyW / 2 - 6, y - 12);
      g.quadraticCurveTo(cx + roofW * 0.25, y - 4, cx + roofW / 2, y - 9);
      g.stroke();
      y -= 12;
    }
    // sorin: the spire, with rings
    g.fillStyle = dark;
    g.fillRect(cx - 2, y - 46, 4, 46);
    for (let r = 0; r < 6; r++) g.fillRect(cx - 6, y - 10 - r * 6, 12, 2.5);
    g.beginPath();
    g.arc(cx, y - 48, 4, 0, Math.PI * 2);
    g.fill();
  }

  // A rope sagging across the sky with paper lanterns (chōchin) hanging from it:
  // red ribbed bodies glowing from inside, dark caps top and bottom.
  function lanterns(g, rng) {
    const x0 = -20;
    const x1 = VIEW_W + 20;
    const y0 = 70 + rng() * 30;
    const y1 = 70 + rng() * 30;
    const sag = 60 + rng() * 30;
    const ropeAt = (t) => {
      const u = 1 - t;
      return [u * u * x0 + 2 * u * t * (VIEW_W / 2) + t * t * x1, u * u * y0 + 2 * u * t * (Math.max(y0, y1) + sag) + t * t * y1];
    };
    g.strokeStyle = '#1a1626';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let k = 0; k <= 40; k++) {
      const [x, y] = ropeAt(k / 40);
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    const n = 7;
    for (let k = 0; k < n; k++) {
      const [x, y] = ropeAt((k + 0.5) / n);
      const drop = 8 + rng() * 10;
      const w = 15;
      const h = 21;
      const cy = y + drop + h / 2;
      g.strokeStyle = '#1a1626';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x, cy - h / 2); g.stroke();
      g.save();
      glow(g, '#ff6a3d', 18);
      const body = g.createRadialGradient(x - 2, cy - 2, 1, x, cy, h * 0.6);
      body.addColorStop(0, '#ffd27a');
      body.addColorStop(0.45, '#ff6a3d');
      body.addColorStop(1, '#b8202f');
      g.fillStyle = body;
      g.beginPath();
      g.ellipse(x, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
      g.strokeStyle = 'rgba(90,10,20,0.45)'; // paper ribs
      g.lineWidth = 0.8;
      for (let r = -2; r <= 2; r++) {
        const yy = cy + r * 4;
        const half = (w / 2) * Math.sqrt(Math.max(0, 1 - (yy - cy) ** 2 / (h / 2) ** 2));
        g.beginPath(); g.moveTo(x - half, yy); g.lineTo(x + half, yy); g.stroke();
      }
      g.fillStyle = '#1a1626';
      g.fillRect(x - 5, cy - h / 2 - 2, 10, 3);
      g.fillRect(x - 5, cy + h / 2 - 1, 10, 3);
    }
  }

  // A torii: rounded pillars (shade on the left, moonlight and a rim on the right)
  // that lean in slightly, a crossbeam and centre strut, and a black curved top beam
  // with upturned ends, each casting a shadow on what's below it.
  function torii(g, cx, baseY, s, depth) {
    const c = (hex) => mixHex(hex, MIST, depth * 0.6);
    const H = 215 * s;
    const top = baseY - H;
    const spread = 74 * s;
    const vGrad = (y0, y1, hi, lo) => {
      const gr = g.createLinearGradient(0, y0, 0, y1);
      gr.addColorStop(0, c(hi));
      gr.addColorStop(1, c(lo));
      return gr;
    };
    for (const side of [-1, 1]) {
      const xb = cx + side * spread;      // pillar centre at the base
      const xt = xb - side * 5 * s;       // ...leaning in at the top
      const wb = 17 * s;
      const wt = 13 * s;
      const gr = g.createLinearGradient(xb - wb / 2, 0, xb + wb / 2, 0);
      gr.addColorStop(0, c('#3f0a15'));
      gr.addColorStop(0.5, c('#a3233a'));
      gr.addColorStop(0.8, c('#de4a5e'));
      gr.addColorStop(1, c('#6a1322'));
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(xt - wt / 2, top + 10 * s);
      g.lineTo(xt + wt / 2, top + 10 * s);
      g.lineTo(xb + wb / 2, baseY);
      g.lineTo(xb - wb / 2, baseY);
      g.closePath();
      g.fill();
      g.strokeStyle = c('#ff9aaa'); // rim light
      g.globalAlpha = 0.45;
      g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(xt + wt / 2 - 0.5, top + 10 * s); g.lineTo(xb + wb / 2 - 0.5, baseY); g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = vGrad(baseY - 22 * s, baseY, '#2a2030', '#0e0a12'); // black kamaki base
      g.fillRect(xb - wb / 2 - 2 * s, baseY - 22 * s, wb + 4 * s, 22 * s);
    }
    const nukiY = top + 58 * s;
    const shimakiY = top + 16 * s;
    // shadows cast down onto the pillars
    g.fillStyle = 'rgba(10,4,12,0.35)';
    g.fillRect(cx - spread - 12 * s, nukiY + 9 * s, spread * 2 + 24 * s, 7 * s);
    g.fillRect(cx - spread - 12 * s, shimakiY + 11 * s, spread * 2 + 24 * s, 6 * s);
    // nuki: the lower crossbeam, running through the pillars
    g.fillStyle = vGrad(nukiY, nukiY + 10 * s, '#d8445a', '#6a1121');
    g.fillRect(cx - spread - 26 * s, nukiY, spread * 2 + 52 * s, 10 * s);
    // gakuzuka: centre strut
    g.fillStyle = vGrad(shimakiY + 11 * s, nukiY, '#b82f45', '#5e0f1e');
    g.fillRect(cx - 6 * s, shimakiY + 11 * s, 12 * s, nukiY - shimakiY - 11 * s);
    // shimaki: red beam under the black top
    g.fillStyle = vGrad(shimakiY, shimakiY + 12 * s, '#e0526a', '#7a1626');
    g.fillRect(cx - spread - 36 * s, shimakiY, spread * 2 + 72 * s, 12 * s);
    // kasagi: black top beam, sagging slightly in the middle, ends flaring up
    const L = cx - spread - 54 * s;
    const R = cx + spread + 54 * s;
    g.fillStyle = vGrad(top - 8 * s, shimakiY, '#2b2338', '#0d0910');
    g.beginPath();
    g.moveTo(L, top + 2 * s);
    g.quadraticCurveTo(cx, top + 22 * s, R, top + 2 * s);
    g.lineTo(R + 8 * s, top - 9 * s);
    g.quadraticCurveTo(cx, top + 8 * s, L - 8 * s, top - 9 * s);
    g.closePath();
    g.fill();
    g.strokeStyle = c('#8a83b0'); // moonlight along the top edge
    g.globalAlpha = 0.6;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(L - 8 * s, top - 9 * s);
    g.quadraticCurveTo(cx, top + 8 * s, R + 8 * s, top - 9 * s);
    g.stroke();
    g.globalAlpha = 1;
  }

  // ----- scenery painters: (g, theme, rng), drawn once per room -----
  const BACKDROPS = {
    // Synthwave: striped sun, wireframe mountains, perspective grid.
    sunset(g, th, rng) {
      for (let k = 0; k < 90; k++) {
        g.fillStyle = `rgba(255,255,255,${0.2 + rng() * 0.6})`;
        g.fillRect(rng() * VIEW_W, rng() * VIEW_H * 0.45, 1.5, 1.5);
      }
      const cx = VIEW_W / 2;
      const cy = 300;
      const R = 140;
      g.save();
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.clip();
      const sun = g.createLinearGradient(0, cy - R, 0, cy + R);
      sun.addColorStop(0, '#ffe66d');
      sun.addColorStop(0.55, '#ff6a8a');
      sun.addColorStop(1, '#c2186b');
      g.fillStyle = sun;
      // slices with gaps that widen toward the bottom
      for (let y = cy - R, k = 0; y < cy + R; k++) {
        const gap = y > cy - 20 ? 2 + (y - (cy - 20)) / 14 : 0;
        const h = 10;
        g.fillRect(cx - R, y, R * 2, h);
        y += h + gap;
      }
      g.restore();
      g.save();
      glow(g, '#ff6a8a', 40);
      g.globalAlpha = 0.25;
      g.fillStyle = '#ff6a8a';
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.fill();
      g.restore();
      // mountains
      const horizon = 380;
      g.beginPath();
      g.moveTo(0, horizon);
      for (let x = 0; x <= VIEW_W; x += 40) g.lineTo(x, horizon - 20 - rng() * 90 * Math.abs(Math.sin(x / 300)));
      g.lineTo(VIEW_W, horizon);
      g.closePath();
      g.fillStyle = '#1a0533';
      g.fill();
      g.save();
      glow(g, th.edge, 8);
      g.strokeStyle = th.edge;
      g.lineWidth = 1.5;
      g.stroke();
      g.restore();
      // grid
      g.fillStyle = '#0d0220';
      g.fillRect(0, horizon, VIEW_W, VIEW_H - horizon);
      g.save();
      g.strokeStyle = 'rgba(255,126,219,0.55)';
      glow(g, th.edge, 6);
      g.lineWidth = 1;
      for (let k = 1; k < 14; k++) {
        const y = horizon + Math.pow(k / 13, 2) * (VIEW_H - horizon);
        g.beginPath(); g.moveTo(0, y); g.lineTo(VIEW_W, y); g.stroke();
      }
      for (let k = -16; k <= 16; k++) {
        g.beginPath(); g.moveTo(cx + k * 12, horizon); g.lineTo(cx + k * 120, VIEW_H); g.stroke();
      }
      g.restore();
    },

    // Sakura Night.  One light source — the moon, upper right — lights everything:
    // faces toward it are lit, faces away are in shade, and edges it grazes get a
    // cool rim.  Depth comes from scale and mist: far trees are small and sink into
    // the haze, near ones are big and saturated, and everything rises out of ground
    // mist from behind the floor rather than floating above it.
    shrine(g, th, rng) {
      for (let k = 0; k < 60; k++) {
        g.fillStyle = `rgba(255,255,255,${0.15 + rng() * 0.5})`;
        g.fillRect(rng() * VIEW_W, rng() * VIEW_H * 0.5, 1.3, 1.3);
      }
      const moon = { x: VIEW_W * 0.76, y: 112, r: 54 };
      g.save();
      glow(g, '#fff6e0', 60);
      const mg = g.createRadialGradient(moon.x - 14, moon.y - 14, 4, moon.x, moon.y, moon.r);
      mg.addColorStop(0, '#fffaf0');
      mg.addColorStop(1, '#f1dcc0');
      g.fillStyle = mg;
      g.beginPath();
      g.arc(moon.x, moon.y, moon.r, 0, Math.PI * 2);
      g.fill();
      g.restore();
      g.fillStyle = 'rgba(150,120,100,0.10)'; // a few faint maria
      for (const [dx, dy, r] of [[-14, -6, 13], [12, 10, 9], [-4, 20, 7], [18, -16, 6]]) {
        g.beginPath(); g.arc(moon.x + dx, moon.y + dy, r, 0, Math.PI * 2); g.fill();
      }

      const ridge = (base, amp, col, rim) => {
        const pts = [];
        for (let x = 0; x <= VIEW_W; x += 24) pts.push([x, base - amp * Math.abs(Math.sin(x / 170 + rng() * 0.3)) - rng() * 12]);
        g.beginPath();
        g.moveTo(0, VIEW_H);
        pts.forEach(([x, y]) => g.lineTo(x, y));
        g.lineTo(VIEW_W, VIEW_H);
        g.fillStyle = col;
        g.fill();
        g.beginPath(); // moonlight catching the ridge line
        pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.strokeStyle = rim;
        g.lineWidth = 1.5;
        g.stroke();
      };
      const mistBand = (y0, y1, a) => {
        const gr = g.createLinearGradient(0, y0, 0, y1);
        gr.addColorStop(0, 'rgba(150,150,215,0)');
        gr.addColorStop(0.6, `rgba(150,150,215,${a})`);
        gr.addColorStop(1, 'rgba(150,150,215,0)');
        g.fillStyle = gr;
        g.fillRect(0, y0, VIEW_W, y1 - y0);
      };

      // far to near: Fuji, hills, then the pagoda and the gate on opposite sides,
      // a string of lanterns across the sky, and ground mist over everything's feet
      fuji(g, 180 + rng() * 280, 420);
      mistBand(300, 430, 0.22);
      ridge(400, 60, '#1d2350', 'rgba(170,170,240,0.12)');
      mistBand(340, 470, 0.25);
      const gateLeft = rng() < 0.5;
      torii(g, gateLeft ? 230 + rng() * 120 : 610 + rng() * 120, 505, 1, 0.2);
      pagoda(g, gateLeft ? 760 + rng() * 80 : 130 + rng() * 80, 492);
      lanterns(g, rng);
      mistBand(400, 560, 0.4); // ground mist: everything rises out of it
    },

    // Cloud Sea: faceted peaks rising out of a sea of cloud.  Everything is flat
    // shapes — two-tone peaks (lit right, shaded left), rolling cloud bands that
    // brighten as they come closer, thin streaks of high cloud.
    cloudSea(g, th, rng) {
      sunDisc(g, 150 + rng() * 140, 92, 34, '#fffbe6', '#fff2b0');
      g.fillStyle = 'rgba(255,255,255,0.55)';
      for (let k = 0; k < 4; k++) {
        const x = rng() * VIEW_W;
        const y = 60 + rng() * 120;
        const w = 120 + rng() * 160;
        roundBar(g, x, y, w, 6 + rng() * 4);
      }
      // far peaks, then a cloud band, nearer peaks, nearer (brighter) cloud bands
      const peakRow = (n, base, hMin, hMax, lit, shade, snow) => {
        for (let k = 0; k < n; k++) {
          const cx = ((k + 0.5) / n) * VIEW_W + (rng() - 0.5) * (VIEW_W / n) * 0.7;
          facetPeak(g, cx, base, 90 + rng() * 120, hMin + rng() * (hMax - hMin), lit, shade, snow);
        }
      };
      peakRow(4, 360, 120, 190, '#a9b8e0', '#8597c9', '#f1f5ff');
      cloudBand(g, 330, 26, '#e6f1fc', '#c9dbf0', rng);
      peakRow(3, 420, 130, 210, '#8fa2d4', '#6b7fb8', '#eef3ff');
      cloudBand(g, 390, 30, '#f1f7fd', '#d3e3f3', rng);
      cloudBand(g, 452, 34, '#ffffff', '#dbe9f6', rng);
    },

    // Tropic Sea: turquoise water out to a hazy horizon, a little palm island,
    // a sailboat, whitecaps thinning toward the horizon.
    sea(g, th, rng) {
      sunDisc(g, 700 + rng() * 150, 80, 30, '#ffffff', '#fff7d6');
      for (let k = 0; k < 3; k++) cumulus(g, rng() * VIEW_W, 150 + rng() * 90, 0.5 + rng() * 0.5, '#ffffff', '#d6ecf7', rng);
      const horizon = 352;
      const sea = g.createLinearGradient(0, horizon, 0, VIEW_H);
      sea.addColorStop(0, '#5fd3d6');
      sea.addColorStop(0.35, '#22a6bf');
      sea.addColorStop(1, '#0d6a8c');
      g.fillStyle = sea;
      g.fillRect(0, horizon, VIEW_W, VIEW_H - horizon);
      g.fillStyle = 'rgba(230,252,255,0.75)';
      g.fillRect(0, horizon, VIEW_W, 2);
      // island with palms
      const ix = 120 + rng() * 300;
      g.fillStyle = '#f2dca6';
      g.beginPath(); g.ellipse(ix, horizon + 4, 70, 12, 0, Math.PI, 0); g.fill();
      g.fillStyle = '#3f9a6e';
      g.beginPath(); g.ellipse(ix - 6, horizon, 46, 18, 0, Math.PI, 0); g.fill();
      for (const [dx, h, lean] of [[-14, 54, -0.25], [12, 64, 0.2]]) palm(g, ix + dx, horizon - 6, h, lean, '#245c45');
      // sailboat
      const bx = 520 + rng() * 300;
      g.fillStyle = '#ffffff';
      g.beginPath(); g.moveTo(bx, horizon - 2); g.lineTo(bx, horizon - 34); g.lineTo(bx + 20, horizon - 4); g.closePath(); g.fill();
      g.fillStyle = '#e8eef5';
      g.beginPath(); g.moveTo(bx - 2, horizon - 4); g.lineTo(bx - 2, horizon - 26); g.lineTo(bx - 14, horizon - 4); g.closePath(); g.fill();
      g.fillStyle = '#2b4660';
      g.fillRect(bx - 16, horizon - 3, 38, 4);
      // whitecaps: sparse and short near the horizon, longer up close
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.lineWidth = 1.2;
      for (let k = 0; k < 70; k++) {
        const d = rng();
        const y = horizon + 6 + d * d * (VIEW_H - horizon);
        const len = 4 + d * 22;
        const x = rng() * VIEW_W;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y); g.stroke();
      }
    },

    // Alpine Dawn: ranges stepping back in colour (aerial perspective), snow on the
    // far peaks, a pine ridge in front, a still lake catching the sky.
    alps(g, th, rng) {
      const dawn = g.createRadialGradient(VIEW_W * 0.6, 330, 10, VIEW_W * 0.6, 330, 420);
      dawn.addColorStop(0, 'rgba(255,214,170,0.75)');
      dawn.addColorStop(1, 'rgba(255,214,170,0)');
      g.fillStyle = dawn;
      g.fillRect(0, 0, VIEW_W, VIEW_H);
      const ranges = [
        { base: 330, amp: 150, col: '#c2bad9', snow: true },
        { base: 370, amp: 120, col: '#9a9ccb', snow: true },
        { base: 410, amp: 80, col: '#6f86b3', snow: false },
      ];
      for (const r of ranges) peaks(g, r.base, r.amp, r.col, r.snow, rng);
      // lake
      g.fillStyle = '#b9c9e6';
      g.fillRect(0, 440, VIEW_W, VIEW_H - 440);
      g.strokeStyle = 'rgba(255,255,255,0.4)';
      for (let k = 0; k < 18; k++) {
        const y = 446 + rng() * 40;
        const x = rng() * VIEW_W;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + 20 + rng() * 40, y); g.stroke();
      }
      // pine ridge on the lake shore
      g.fillStyle = '#4c6b6a';
      g.beginPath();
      g.moveTo(0, 445);
      for (let x = 0; x <= VIEW_W; x += 14) {
        const h = 18 + rng() * 26;
        g.lineTo(x, 445 - h * 0.35);
        g.lineTo(x + 7, 445 - h);
        g.lineTo(x + 14, 445 - h * 0.35);
      }
      g.lineTo(VIEW_W, 450);
      g.lineTo(0, 450);
      g.closePath();
      g.fill();
    },

    // Dune Sea: a violet desert at twilight, a crescent moon, mesas on the
    // horizon, and dune crests catching the last light.
    dunes(g, th, rng) {
      stars(g, 110, 0.5, rng);
      crescent(g, 620 + rng() * 200, 100, 26, '#fdf3d6');
      g.fillStyle = '#3a2c62';
      for (let k = 0; k < 3; k++) {
        const x = rng() * VIEW_W;
        const w = 70 + rng() * 90;
        const h = 40 + rng() * 40;
        g.beginPath();
        g.moveTo(x - w / 2 - 20, 352);
        g.lineTo(x - w / 2, 352 - h);
        g.lineTo(x + w / 2, 352 - h);
        g.lineTo(x + w / 2 + 20, 352);
        g.closePath();
        g.fill();
      }
      const layers = [
        { base: 350, amp: 28, col: '#4d3b78', crest: '#7e66a8' },
        { base: 385, amp: 34, col: '#5e4685', crest: '#a283bf' },
        { base: 425, amp: 40, col: '#71538f', crest: '#c7a3cf' },
        { base: 470, amp: 44, col: '#86629b', crest: '#e2bfd4' },
      ];
      for (const L of layers) {
        const f1 = 0.004 + rng() * 0.004;
        const f2 = 0.011 + rng() * 0.006;
        const p1 = rng() * 6;
        const p2 = rng() * 6;
        const y = (x) => L.base - L.amp * (0.6 * Math.sin(x * f1 + p1) + 0.4 * Math.sin(x * f2 + p2));
        g.fillStyle = L.col;
        g.beginPath();
        g.moveTo(0, VIEW_H);
        for (let x = 0; x <= VIEW_W; x += 8) g.lineTo(x, y(x));
        g.lineTo(VIEW_W, VIEW_H);
        g.closePath();
        g.fill();
        g.strokeStyle = L.crest;
        g.lineWidth = 2;
        g.beginPath();
        for (let x = 0; x <= VIEW_W; x += 8) (x ? g.lineTo(x, y(x)) : g.moveTo(x, y(x)));
        g.stroke();
      }
    },

    // Aurora Tundra: curtains of aurora over snowy hills dotted with pines.
    tundra(g, th, rng) {
      stars(g, 160, 0.55, rng);
      const curtains = [['#3ef0c8', 110], ['#9b6bff', 150], ['#ff7ad9', 175]];
      for (const [col, base] of curtains) {
        const f = 0.006 + rng() * 0.004;
        const ph = rng() * 6;
        g.fillStyle = col;
        for (let x = 0; x < VIEW_W; x += 3) {
          const top = base + Math.sin(x * f + ph) * 38 + Math.sin(x * f * 2.7 + ph) * 12;
          const len = 70 + 50 * Math.abs(Math.sin(x * f * 1.9 + ph * 2));
          for (let k = 0; k < 5; k++) {
            g.globalAlpha = 0.16 * (1 - k / 5);
            g.fillRect(x, top + (k * len) / 5, 2, len / 5);
          }
        }
      }
      g.globalAlpha = 1;
      const hill = (base, amp, col, rimCol) => {
        const f = 0.004 + rng() * 0.003;
        const ph = rng() * 6;
        const y = (x) => base - amp * Math.abs(Math.sin(x * f + ph));
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(0, VIEW_H);
        for (let x = 0; x <= VIEW_W; x += 10) g.lineTo(x, y(x));
        g.lineTo(VIEW_W, VIEW_H);
        g.closePath();
        g.fill();
        g.strokeStyle = rimCol;
        g.lineWidth = 2;
        g.beginPath();
        for (let x = 0; x <= VIEW_W; x += 10) (x ? g.lineTo(x, y(x)) : g.moveTo(x, y(x)));
        g.stroke();
        return y;
      };
      hill(360, 90, '#5d77a3', '#c9d8f2');
      hill(410, 50, '#7891bb', '#dde8fa');
      // a frozen lake: pale ice, a faint smear of aurora reflected in it, a few cracks
      const ice = g.createLinearGradient(0, 438, 0, VIEW_H);
      ice.addColorStop(0, '#a9c0e0');
      ice.addColorStop(1, '#7f99c4');
      g.fillStyle = ice;
      g.fillRect(0, 438, VIEW_W, VIEW_H - 438);
      g.globalAlpha = 0.18;
      g.fillStyle = '#3ef0c8';
      g.fillRect(0, 446, VIEW_W, 6);
      g.fillStyle = '#9b6bff';
      g.fillRect(0, 456, VIEW_W, 4);
      g.globalAlpha = 1;
      g.strokeStyle = 'rgba(255,255,255,0.45)';
      g.lineWidth = 1;
      for (let k = 0; k < 7; k++) {
        let x = rng() * VIEW_W;
        let y = 444 + rng() * 34;
        g.beginPath();
        g.moveTo(x, y);
        for (let seg = 0; seg < 3; seg++) {
          x += 16 + rng() * 26;
          y += (rng() - 0.5) * 8;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      g.fillStyle = '#eef4ff';
      g.fillRect(0, 438, VIEW_W, 2);
    },

    // Golden Savanna: a huge low sun behind long streaks of cloud, a low plateau
    // range on the horizon, and the plain as bands of warm colour receding into
    // haze — all flat horizontal shapes.
    savanna(g, th, rng) {
      const sx = 300 + rng() * 360;
      sunDisc(g, sx, 352, 76, '#fff4cc', '#ffd27a');
      g.fillStyle = 'rgba(255,214,150,0.75)'; // cloud streaks crossing the sun
      for (let k = 0; k < 5; k++) roundBar(g, sx - 260 + rng() * 380, 250 + k * 22 + rng() * 10, 140 + rng() * 220, 5 + rng() * 4);
      // plateau range: flat tops, sloped sides
      g.fillStyle = '#d98f5c';
      g.beginPath();
      g.moveTo(0, 402);
      for (let x = -40; x < VIEW_W + 40;) {
        const w = 90 + rng() * 160;
        const h = 18 + rng() * 34;
        g.lineTo(x + 22, 402 - h);
        g.lineTo(x + w - 22, 402 - h);
        g.lineTo(x + w, 402);
        x += w + rng() * 60;
        g.lineTo(x, 402);
      }
      g.lineTo(VIEW_W, 402);
      g.closePath();
      g.fill();
      // the plain: bands getting warmer and deeper toward you
      const bands = ['#e8b25e', '#dca24c', '#cf923e', '#c08234', '#ae722b'];
      bands.forEach((col, k) => {
        const y = 400 + k * k * 4 + k * 6;
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(0, y + 3 * Math.sin(k));
        for (let x = 0; x <= VIEW_W; x += 40) g.lineTo(x, y + Math.sin(x / 140 + k * 1.7) * (2 + k));
        g.lineTo(VIEW_W, VIEW_H);
        g.lineTo(0, VIEW_H);
        g.closePath();
        g.fill();
      });
      // heat haze: faint pale lines shimmering just above the horizon
      g.fillStyle = 'rgba(255,240,200,0.35)';
      for (let k = 0; k < 6; k++) roundBar(g, rng() * VIEW_W, 392 + rng() * 10, 60 + rng() * 140, 1.5);
    },
  };

  // ----- shared scenery pieces for the open-air themes -----
  function sunDisc(g, x, y, r, core, halo) {
    g.save();
    glow(g, halo, r * 1.6);
    g.fillStyle = halo;
    g.globalAlpha = 0.35;
    g.beginPath(); g.arc(x, y, r * 1.6, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
    g.fillStyle = core;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  function stars(g, n, maxY, rng) {
    for (let k = 0; k < n; k++) {
      g.fillStyle = `rgba(255,255,255,${0.2 + rng() * 0.6})`;
      g.fillRect(rng() * VIEW_W, rng() * VIEW_H * maxY, 1.4, 1.4);
    }
  }

  // The lit part of the disc minus an offset disc — cut with even-odd inside the
  // moon's own outline, so nothing is painted over the sky (a sky-coloured cover
  // disc never matches a gradient sky and shows up as a dark circle).
  function crescent(g, x, y, r, col) {
    g.save();
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.clip();
    glow(g, col, 24);
    g.fillStyle = col;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.arc(x + r * 0.42, y - r * 0.22, r * 0.9, 0, Math.PI * 2);
    g.fill('evenodd');
    g.restore();
  }

  // A cel-shaded cumulus: a flat-bottomed heap of round puffs, shade along the bottom.
  function cumulus(g, x, y, s, col, shade, rng) {
    const puffs = [[-50, 0, 26], [-22, -14, 32], [12, -20, 36], [44, -6, 28], [66, 4, 18], [-70, 6, 16]]
      .map(([dx, dy, r]) => [x + dx * s, y + dy * s, r * s * (0.85 + rng() * 0.3)]);
    g.save();
    g.beginPath();
    g.rect(x - 120 * s, y - 80 * s, 240 * s, 92 * s); // flat bottom
    g.clip();
    g.fillStyle = shade;
    g.beginPath();
    for (const [px, py, r] of puffs) { g.moveTo(px + r, py); g.arc(px, py, r, 0, Math.PI * 2); }
    g.fill();
    g.fillStyle = col;
    g.beginPath();
    for (const [px, py, r] of puffs) { g.moveTo(px + r * 0.9, py - r * 0.12); g.arc(px, py - r * 0.12, r * 0.9, 0, Math.PI * 2); }
    g.fill();
    g.restore();
  }

  function palm(g, x, y, h, lean, col) {
    g.strokeStyle = col;
    g.lineCap = 'round';
    g.lineWidth = 3;
    const tx = x + lean * h;
    const ty = y - h;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + lean * h * 0.2, y - h * 0.6, tx, ty); g.stroke();
    g.lineWidth = 2.5;
    for (const a of [-2.6, -2.0, -1.2, -0.5, 0.1]) {
      g.beginPath();
      g.moveTo(tx, ty);
      g.quadraticCurveTo(tx + Math.cos(a) * 14, ty + Math.sin(a) * 14 - 4, tx + Math.cos(a) * 22, ty + Math.sin(a) * 22 + 8);
      g.stroke();
    }
  }

  function peaks(g, base, amp, col, snow, rng) {
    const pts = [[0, base]];
    for (let x = 0; x <= VIEW_W + 60;) {
      const w = 50 + rng() * 80;
      pts.push([x + w / 2, base - amp * (0.45 + rng() * 0.55)]);
      pts.push([x + w, base - amp * (0.1 + rng() * 0.25)]);
      x += w;
    }
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, VIEW_H);
    pts.forEach(([x, y]) => g.lineTo(x, y));
    g.lineTo(VIEW_W + 60, VIEW_H);
    g.closePath();
    g.fill();
    if (!snow) return;
    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (let k = 1; k < pts.length - 1; k += 2) {
      const [px, py] = pts[k];
      if (py > base - amp * 0.7) continue; // only the tall ones carry snow
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + 16, py + 18);
      g.lineTo(px + 6, py + 14);
      g.lineTo(px - 2, py + 20);
      g.lineTo(px - 14, py + 16);
      g.closePath();
      g.fill();
    }
  }

  // A rounded horizontal bar: high cloud streaks, heat haze.
  function roundBar(g, x, y, w, h) {
    g.beginPath();
    g.moveTo(x + h / 2, y);
    g.lineTo(x + w - h / 2, y);
    g.arc(x + w - h / 2, y + h / 2, h / 2, -Math.PI / 2, Math.PI / 2);
    g.lineTo(x + h / 2, y + h);
    g.arc(x + h / 2, y + h / 2, h / 2, Math.PI / 2, -Math.PI / 2);
    g.fill();
  }

  // A two-tone faceted peak: shaded left face, lit right face, a snow cap that
  // follows both faces down a little way.
  function facetPeak(g, cx, base, halfW, h, lit, shade, snow) {
    const top = base - h;
    const ridge = cx + halfW * 0.12; // the ridge line sits just right of centre
    g.fillStyle = shade;
    g.beginPath(); g.moveTo(cx - halfW, base); g.lineTo(cx, top); g.lineTo(ridge, base); g.closePath(); g.fill();
    g.fillStyle = lit;
    g.beginPath(); g.moveTo(ridge, base); g.lineTo(cx, top); g.lineTo(cx + halfW, base); g.closePath(); g.fill();
    const capH = h * 0.24;
    g.fillStyle = snow;
    g.beginPath();
    g.moveTo(cx, top);
    g.lineTo(cx + (halfW / h) * capH, top + capH);
    g.lineTo(cx + (halfW / h) * capH * 0.35, top + capH * 0.8);
    g.lineTo(cx - (halfW / h) * capH * 0.2, top + capH);
    g.lineTo(cx - (halfW / h) * capH, top + capH * 0.75);
    g.closePath();
    g.fill();
  }

  // A rolling band of cloud tops: a soft line of bumps with a flat body below.
  function cloudBand(g, y, bump, col, shade, rng) {
    const tops = [];
    for (let x = -bump; x < VIEW_W + bump * 2; x += bump * (0.9 + rng() * 0.6)) tops.push([x, bump * (0.7 + rng() * 0.5)]);
    g.fillStyle = shade;
    g.beginPath();
    for (const [x, r] of tops) { g.moveTo(x + r, y + 6); g.arc(x, y + 6, r, 0, Math.PI * 2); }
    g.fill();
    g.fillStyle = col;
    g.beginPath();
    for (const [x, r] of tops) { g.moveTo(x + r * 0.92, y); g.arc(x, y, r * 0.92, 0, Math.PI * 2); }
    g.fill();
    g.fillRect(0, y, VIEW_W, VIEW_H - y);
  }

  // ----- tiles + spikes, drawn once per room -----
  function paintTiles(g, lv, th, rng) {
    const solid = (cx, cy) => cellAt(lv, cx, cy) === SOLID;
    // A soft dark shadow around every platform shape: separation from bright scenery
    // (signs, the moon, the sun) without making the platform look bigger than it is.
    g.save();
    glow(g, 'rgba(0,0,0,0.85)', 14);
    g.fillStyle = th.fill;
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) if (solid(cx, cy)) g.fillRect(cx * TILE, cy * TILE, TILE, TILE);
    }
    g.restore();
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (!solid(cx, cy)) continue;
        const x = cx * TILE;
        const y = cy * TILE;
        g.fillStyle = th.fill;
        g.fillRect(x, y, TILE, TILE);
        if (th.tiles === 'cap') {
          // earth: a few faint flecks so it reads as ground, not a hole
          g.fillStyle = 'rgba(255,255,255,0.045)';
          for (let k = 0; k < 3; k++) g.fillRect(x + 3 + rng() * (TILE - 8), y + 8 + rng() * (TILE - 12), 2, 2);
        } else if (th.tiles === 'stone') {
          g.fillStyle = 'rgba(255,255,255,0.06)';
          g.fillRect(x, y + TILE / 2, TILE, 1);
          g.fillRect(x + (cy % 2 ? 8 : 22), y, 1, TILE / 2);
          g.fillRect(x + (cy % 2 ? 22 : 8), y + TILE / 2, 1, TILE / 2);
        } else {
          // neon: faint inner panel lines
          g.fillStyle = 'rgba(255,255,255,0.025)';
          g.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
        }
      }
    }
    // Exposed edges, where the room's character lives: glow lines (neon), pink
    // moss (stone), or a cap of grass / sand / snow on top (cap).
    g.save();
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (!solid(cx, cy)) continue;
        const x = cx * TILE;
        const y = cy * TILE;
        const top = !solid(cx, cy - 1);
        const bottom = !solid(cx, cy + 1);
        const left = !solid(cx - 1, cy);
        const right = !solid(cx + 1, cy);
        if (th.tiles === 'stone') {
          if (top) {
            g.fillStyle = th.edge2;
            g.fillRect(x, y, TILE, 5);
            g.fillStyle = th.edge;
            for (let k = 0; k < 4; k++) g.fillRect(x + rng() * (TILE - 3), y + rng() * 3, 3, 2);
          }
          g.fillStyle = 'rgba(255,183,213,0.12)';
          if (left) g.fillRect(x, y, 2, TILE);
          if (right) g.fillRect(x + TILE - 2, y, 2, TILE);
          continue;
        }
        if (th.tiles === 'cap') {
          if (top) {
            g.fillStyle = th.edge2;
            g.fillRect(x, y, TILE, 7);
            g.fillStyle = th.edge;
            g.fillRect(x, y, TILE, 5);
            if (th.cap === 'grass') {
              g.fillStyle = th.edge2; // blade marks
              for (let k = 0; k < 5; k++) g.fillRect(x + 2 + k * 6 + rng() * 2, y + 2, 1.5, 3);
            } else if (th.cap === 'snow') {
              g.fillStyle = th.edge; // drips hanging off the snow cap
              for (let k = 0; k < 2; k++) g.fillRect(x + 4 + rng() * (TILE - 10), y + 5, 3, 2 + rng() * 4);
            } else {
              g.fillStyle = th.edge2; // sand grains
              for (let k = 0; k < 5; k++) g.fillRect(x + rng() * (TILE - 2), y + 1 + rng() * 3, 1.5, 1.5);
            }
          }
          g.fillStyle = th.edge2;
          g.globalAlpha = 0.5;
          if (left) g.fillRect(x, y, 2, TILE);
          if (right) g.fillRect(x + TILE - 2, y, 2, TILE);
          g.globalAlpha = 1;
          continue;
        }
        glow(g, th.edge, 10);
        g.strokeStyle = th.edge;
        g.lineWidth = 2;
        g.beginPath();
        if (top) { g.moveTo(x, y + 1); g.lineTo(x + TILE, y + 1); }
        if (bottom) { g.moveTo(x, y + TILE - 1); g.lineTo(x + TILE, y + TILE - 1); }
        if (left) { g.moveTo(x + 1, y); g.lineTo(x + 1, y + TILE); }
        if (right) { g.moveTo(x + TILE - 1, y); g.lineTo(x + TILE - 1, y + TILE); }
        g.stroke();
        if (top && th.tiles === 'neon') {
          g.shadowBlur = 0;
          g.strokeStyle = th.edge2;
          g.globalAlpha = 0.5;
          g.beginPath(); g.moveTo(x, y + 5); g.lineTo(x + TILE, y + 5); g.stroke();
          g.globalAlpha = 1;
        }
      }
    }
    g.restore();
  }

  // Ice day: a glassy blue sheen with a few glints on every walkable surface.
  function paintIce(g, lv) {
    g.save();
    for (let cy = 1; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (lv.grid[cy * COLS + cx] !== SOLID || lv.grid[(cy - 1) * COLS + cx] !== EMPTY) continue;
        const x = cx * TILE;
        const y = cy * TILE;
        const grad = g.createLinearGradient(0, y - 3, 0, y + 9);
        grad.addColorStop(0, 'rgba(225,248,255,1)');
        grad.addColorStop(0.45, 'rgba(150,215,255,0.9)');
        grad.addColorStop(1, 'rgba(120,200,255,0.1)');
        g.fillStyle = grad;
        g.fillRect(x, y - 3, TILE, 12); // ice sits on top of the grass/sand/snow cap
        if ((cx * 7 + cy * 3) % 5 === 0) {
          g.fillStyle = 'rgba(255,255,255,0.9)';
          g.fillRect(x + 8, y, 6, 1.5);
          g.fillRect(x + 10, y - 1, 1.5, 3.5);
        }
      }
    }
    g.restore();
  }

  // A one-way plank: a thin board with a bright top edge and little posts, clearly
  // not a solid block (you can see — and jump — right through it).
  function paintPlanks(g, lv, th) {
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (lv.grid[cy * COLS + cx] !== ONEWAY) continue;
        const x = cx * TILE;
        const y = cy * TILE;
        g.fillStyle = th.fill;
        g.fillRect(x, y, TILE, 9);
        g.fillStyle = th.edge;
        g.fillRect(x, y, TILE, 3);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x + 4, y + 9, 3, 6);
        g.fillRect(x + TILE - 7, y + 9, 3, 6);
        g.strokeStyle = 'rgba(255,255,255,0.18)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x + 1, y + 6);
        g.lineTo(x + TILE - 1, y + 6);
        g.stroke();
      }
    }
  }

  // A spring: dark base like a platform, a zig-zag coil, and a bright plate on top
  // (gold with a dark rim, so it reads on any sky as "step here, something happens").
  function paintSprings(g, lv, th) {
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (lv.grid[cy * COLS + cx] !== SPRING) continue;
        const x = cx * TILE;
        const y = cy * TILE;
        g.fillStyle = th.fill;
        g.fillRect(x, y + 12, TILE, TILE - 12);
        g.strokeStyle = '#d8dae4';
        g.lineWidth = 3;
        g.beginPath();
        for (let k = 0; k <= 4; k++) g.lineTo(x + (k % 2 ? 8 : TILE - 8), y + 4 + k * 2);
        g.stroke();
        g.save();
        g.shadowColor = 'rgba(255,209,102,0.9)';
        g.shadowBlur = 10;
        g.fillStyle = '#ffd166';
        g.strokeStyle = '#3a2a00';
        g.lineWidth = 1.5;
        g.beginPath();
        g.rect(x + 1, y - 4, TILE - 2, 8); // the plate stands proud of the surface
        g.fill();
        g.restore();
        g.strokeStyle = '#3a2a00';
        g.strokeRect(x + 1, y - 4, TILE - 2, 8);
        // a faint "up" chevron: this tile throws you
        g.strokeStyle = 'rgba(255,209,102,0.75)';
        g.lineWidth = 2.5;
        g.beginPath();
        g.moveTo(x + 8, y - 9);
        g.lineTo(x + TILE / 2, y - 16);
        g.lineTo(x + TILE - 8, y - 9);
        g.stroke();
      }
    }
  }

  // Spikes get their own layer, drawn *above* the splats: blood may stain the room,
  // but it must never hide the spike that keeps killing you.
  function paintSpikes(g, lv, th) {
    g.save();
    if (th.glow !== false) glow(g, th.spike, 8);
    g.fillStyle = th.spike;
    g.strokeStyle = th.spikeLine || 'transparent';
    g.lineWidth = 1.5;
    g.lineJoin = 'round';
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const c = lv.grid[cy * COLS + cx];
        if (isSpike(c)) drawSpikeTile(g, c, cx * TILE, cy * TILE, !!th.spikeLine);
      }
    }
    g.restore();
  }

  const SPIKE_TEETH = 3;
  function drawSpikeTile(g, code, x, y, outline = false) {
    const step = TILE / SPIKE_TEETH;
    g.beginPath();
    for (let i = 0; i < SPIKE_TEETH; i++) {
      const o = i * step;
      if (code === SPIKE_UP) {
        g.moveTo(x + o, y + TILE);
        g.lineTo(x + o + step / 2, y + TILE - SPIKE_LEN);
        g.lineTo(x + o + step, y + TILE);
      } else if (code === SPIKE_DOWN) {
        g.moveTo(x + o, y);
        g.lineTo(x + o + step / 2, y + SPIKE_LEN);
        g.lineTo(x + o + step, y);
      } else if (code === SPIKE_RIGHT) {
        g.moveTo(x, y + o);
        g.lineTo(x + SPIKE_LEN, y + o + step / 2);
        g.lineTo(x, y + o + step);
      } else {
        g.moveTo(x + TILE, y + o);
        g.lineTo(x + TILE - SPIKE_LEN, y + o + step / 2);
        g.lineTo(x + TILE, y + o + step);
      }
    }
    g.fill();
    if (outline) g.stroke();
  }

  // ----- weather, drawn live: stateless functions of time, so nothing to update -----
  const rnd = (i) => ((Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1 + 1) % 1;
  function drawWeather(th, layer) {
    const t = artT;
    ctx.save();
    // Moon day: slow motes drifting *up* — the room feels light before you jump.
    if (layer === 'back' && game.level && game.level.twist === 'moon') {
      for (let i = 0; i < 30; i++) {
        const x = (rnd(i + 300) * VIEW_W + Math.sin(t * 0.6 + i) * 12) % VIEW_W;
        const y = VIEW_H - ((rnd(i + 340) * VIEW_H + t * (10 + rnd(i + 380) * 14)) % VIEW_H);
        ctx.fillStyle = `rgba(235,235,255,${0.45 + 0.35 * rnd(i + 420)})`;
        ctx.beginPath();
        ctx.arc(x, y, 1.6 + rnd(i + 460) * 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (th.ambience === 'clouds' && layer === 'back') {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      for (let i = 0; i < 5; i++) {
        const x = ((rnd(i) * (VIEW_W + 300) + t * (8 + rnd(i + 9) * 10)) % (VIEW_W + 300)) - 150;
        const y = 60 + rnd(i + 20) * 260;
        const s = 0.5 + rnd(i + 40) * 0.6;
        ctx.beginPath();
        for (const [dx, dy, r] of [[-30, 0, 18], [0, -8, 24], [30, 0, 18]]) {
          ctx.moveTo(x + dx * s + r * s, y + dy * s);
          ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    } else if ((th.ambience === 'gulls' || th.ambience === 'birds') && layer === 'back') {
      // gulls glide alone; the dawn birds fly in a loose V
      const gulls = th.ambience === 'gulls';
      ctx.strokeStyle = gulls ? '#2b3a4a' : '#4a4a6a';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      const n = gulls ? 5 : 7;
      for (let i = 0; i < n; i++) {
        let x;
        let y;
        if (gulls) {
          x = ((rnd(i) * (VIEW_W + 100) + t * (30 + rnd(i + 3) * 20)) % (VIEW_W + 100)) - 50;
          y = 90 + rnd(i + 7) * 200 + Math.sin(t * 0.8 + i) * 10;
        } else {
          const lead = ((t * 26) % (VIEW_W + 300)) - 150;
          const rank = Math.ceil(i / 2);
          x = lead - rank * 16;
          y = 120 + (i % 2 ? 1 : -1) * rank * 9 + Math.sin(t * 2 + i) * 2;
        }
        const flap = Math.sin(t * (gulls ? 5 : 9) + i * 1.7) * 3;
        ctx.beginPath();
        ctx.moveTo(x - 7, y - 2 + flap);
        ctx.quadraticCurveTo(x - 3, y - 4, x, y);
        ctx.quadraticCurveTo(x + 3, y - 4, x + 7, y - 2 + flap);
        ctx.stroke();
      }
    } else if (th.ambience === 'snow' && layer === 'front') {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let i = 0; i < 90; i++) {
        const sp = 25 + rnd(i) * 45;
        const y = ((rnd(i + 300) * (VIEW_H + 20) + t * sp) % (VIEW_H + 20)) - 10;
        const x = ((rnd(i + 600) * VIEW_W + Math.sin(t * 0.7 + i) * 20 + t * 8) % VIEW_W + VIEW_W) % VIEW_W;
        ctx.beginPath();
        ctx.arc(x, y, 1 + rnd(i + 900) * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (th.ambience === 'sand' && layer === 'front') {
      ctx.strokeStyle = 'rgba(232,200,160,0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 50; i++) {
        const sp = 120 + rnd(i) * 160;
        const x = ((rnd(i + 100) * (VIEW_W + 80) + t * sp) % (VIEW_W + 80)) - 40;
        const y = 250 + rnd(i + 200) * 280 + Math.sin(t + i) * 6;
        const len = 8 + rnd(i + 300) * 18;
        ctx.moveTo(x, y);
        ctx.lineTo(x + len, y - len * 0.08);
      }
      ctx.stroke();
    } else if (th.ambience === 'motes' && layer === 'back') {
      ctx.fillStyle = '#fff3c4';
      for (let i = 0; i < 34; i++) {
        const x = ((rnd(i) * VIEW_W + t * (6 + rnd(i + 5) * 8) + Math.sin(t * 0.5 + i) * 14) % VIEW_W + VIEW_W) % VIEW_W;
        const y = 120 + rnd(i + 50) * 330 + Math.sin(t * 0.9 + i * 2) * 10;
        ctx.globalAlpha = 0.25 + 0.5 * Math.abs(Math.sin(t * 1.3 + i));
        ctx.fillRect(x, y, 2, 2);
      }
    } else if (th.ambience === 'stars' && layer === 'back') {
      for (let i = 0; i < 40; i++) {
        ctx.globalAlpha = 0.25 + 0.75 * Math.abs(Math.sin(t * (0.8 + rnd(i) * 2) + i));
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(rnd(i + 50) * VIEW_W, rnd(i + 90) * VIEW_H * 0.42, 2, 2);
      }
    } else if (th.ambience === 'petals' && layer === 'front') {
      ctx.fillStyle = 'rgba(255,190,220,0.85)';
      for (let i = 0; i < 45; i++) {
        const sp = 30 + rnd(i) * 40;
        const y = ((rnd(i + 200) * (VIEW_H + 40) + t * sp) % (VIEW_H + 40)) - 20;
        const x = ((rnd(i + 400) * VIEW_W + t * 25 + Math.sin(t * 1.3 + i) * 25) % VIEW_W + VIEW_W) % VIEW_W;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(t * (1 + rnd(i + 7)) + i);
        ctx.fillRect(-3, -1.5, 6, 3);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  function drawSaws(lv) {
    const th = themeOf(lv);
    for (const s of lv.saws) {
      const pos = sawPos(s, game.levelClock);
      ctx.strokeStyle = th.saw;
      ctx.globalAlpha = 0.22;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.stroke();
      ctx.globalAlpha = 1;

      const spin = game.levelClock * 9;
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.rotate(spin);
      if (th.glow !== false) glow(ctx, th.saw, 12);
      ctx.fillStyle = th.saw;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a0 = (i / 8) * Math.PI * 2;
        const a1 = ((i + 0.5) / 8) * Math.PI * 2;
        ctx.lineTo(Math.cos(a0) * s.r, Math.sin(a0) * s.r);
        ctx.lineTo(Math.cos(a1) * (s.r * 0.66), Math.sin(a1) * (s.r * 0.66));
      }
      ctx.closePath();
      ctx.fill();
      if (th.sawLine) { // daytime: a dark rim instead of a glow
        ctx.strokeStyle = th.sawLine;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.arc(0, 0, s.r * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // The goal: a Claude-style spark — uneven rounded rays around a bright core —
  // floating and slowly turning over a glowing pad, in a soft column of light.
  // Warm gold reads against every theme.  Hitbox unchanged: g is still 22x34.
  const SPARK_RAYS = [1, 0.72, 0.9, 0.66, 0.95, 0.7, 0.86, 0.62, 1, 0.75, 0.88]; // uneven, like the logo
  // A shard: a spinning four-point star in Claude orange-gold.  Waiting at its spot,
  // or (once picked up) orbiting Clawd until the goal — or a death — settles it.
  function drawStar(cx, cy, r, spin, alpha, outline = null) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = alpha;
    // a soft pulsing halo, so it reads as "something to grab" on any sky
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.2);
    halo.addColorStop(0, 'rgba(255,181,71,0.45)');
    halo.addColorStop(1, 'rgba(255,181,71,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, r * (2 + 0.2 * Math.sin(artT * 4)), 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(spin);
    ctx.shadowColor = SHARD_GOLD;
    ctx.shadowBlur = 14;
    ctx.fillStyle = SHARD_GOLD;
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const rr = k % 2 ? r * 0.38 : r;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    if (outline) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = outline;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff6dc';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  function drawShard(sh) {
    const cx = sh.x + sh.w / 2;
    const cy = sh.y + sh.h / 2;
    if (!game.shardHeld) {
      const bob = Math.sin(artT * 3) * 2;
      // daytime themes get a dark rim (like their spikes): gold on a bright sky needs it
      drawStar(cx, cy + bob, 14, artT * 1.5, 1, themeOf(game.level).glow === false ? '#5c3500' : null);
      return;
    }
    const p = game.player;
    if (!p || game.state === 'dying') return;
    drawStar(p.x + p.w / 2 + Math.cos(artT * 5) * 16, p.y - 4 + Math.sin(artT * 5) * 6, 7, artT * 4, 0.95, themeOf(game.level).glow === false ? '#5c3500' : null);
  }

  // The key: a chunky gold key, bobbing, with a halo (dark rim on bright skies).
  function drawKey(k) {
    const cx = k.x + k.w / 2;
    const cy = k.y + k.h / 2 + Math.sin(artT * 3 + 1) * 2;
    const rim = themeOf(game.level).glow === false ? '#5c3500' : null;
    ctx.save();
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, 26);
    halo.addColorStop(0, 'rgba(255,209,102,0.45)');
    halo.addColorStop(1, 'rgba(255,209,102,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(cx, cy);
    ctx.rotate(-0.5);
    ctx.fillStyle = '#ffd166';
    ctx.strokeStyle = rim || 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(-6, 0, 6.5, 0, Math.PI * 2); // bow
    ctx.rect(-1, -2.5, 13, 5);         // shaft
    ctx.rect(7, 2, 3, 4);              // teeth
    ctx.rect(11, 2, 2.5, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.arc(-6, 0, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // A locked goal: a padlock over it until the key is in hand.
  function drawLock(g) {
    const cx = g.x + g.w / 2;
    const cy = g.y + g.h / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(10,10,25,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy - 2, 5, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(cx - 7, cy - 2, 14, 10);
    ctx.fillStyle = '#3a2a00';
    ctx.fillRect(cx - 1, cy + 1, 2, 4);
    ctx.restore();
  }

  function drawGoal(g) {
    const t = artT;
    const cx = g.x + g.w / 2;
    const floor = g.y + g.h;
    const cy = g.y + 12 + Math.sin(t * 2.2) * 2.5; // gentle bob
    ctx.save();
    // column of light rising from the pad
    const beam = ctx.createLinearGradient(0, floor, 0, floor - 90);
    beam.addColorStop(0, 'rgba(255,209,102,0.28)');
    beam.addColorStop(1, 'rgba(255,209,102,0)');
    ctx.fillStyle = beam;
    ctx.fillRect(cx - 13, floor - 90, 26, 90);
    // pad: a glowing ellipse on the ledge
    glow(ctx, '#ffd166', 14);
    ctx.fillStyle = 'rgba(255,209,102,0.55)';
    ctx.beginPath();
    ctx.ellipse(cx, floor - 1, 14, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // a soft dark backing, so the gold reads on bright and golden skies too
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(20,12,30,0.32)';
    ctx.beginPath();
    ctx.arc(cx, cy, 17, 0, Math.PI * 2);
    ctx.fill();
    // the spark
    const pulse = 0.85 + 0.15 * Math.sin(t * 4);
    glow(ctx, '#ff9d3c', 18 * pulse);
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.6);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#e8743b';
    ctx.lineWidth = 4.2;
    ctx.beginPath();
    SPARK_RAYS.forEach((len, k) => {
      const a = (k / SPARK_RAYS.length) * Math.PI * 2;
      ctx.moveTo(Math.cos(a) * 2, Math.sin(a) * 2);
      ctx.lineTo(Math.cos(a) * 12 * len * pulse, Math.sin(a) * 12 * len * pulse);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#ffd9a8'; // hot inner line along each ray
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = '#fff6e6';
    ctx.beginPath();
    ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // motes orbiting it
    ctx.save();
    ctx.fillStyle = '#ffe2a8';
    for (let k = 0; k < 5; k++) {
      const a = t * 1.6 + (k / 5) * Math.PI * 2;
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 3 + k);
      ctx.fillRect(cx + Math.cos(a) * 17 - 1, cy + Math.sin(a) * 6 - 1, 2, 2);
    }
    ctx.restore();
  }

  // Draws Clawd standing on (cx, bottom), squashed/stretched about his feet.
  function drawClawd(cx, bottom, facing, legPose, colors, sx = 1, sy = 1, cling = 0, grip = 0) {
    ctx.save();
    ctx.translate(cx, bottom);
    ctx.scale(sx, sy);
    const u = CLAWD_UNIT;
    const rects = clawdRects(facing, legPose, cling, grip);
    ctx.fillStyle = colors.outline;
    for (const r of rects) {
      if (r.part === 'eye') continue;
      ctx.fillRect((r.x - CLAWD_W / 2) * u - 1, (r.y - CLAWD_H) * u - 1, r.w * u + 2, r.h * u + 2);
    }
    for (const r of rects) {
      ctx.fillStyle = colors[r.part];
      ctx.fillRect((r.x - CLAWD_W / 2) * u, (r.y - CLAWD_H) * u, r.w * u, r.h * u);
    }
    ctx.restore();
  }

  function legPoseFor(p) {
    if (!p.onGround) return 'air';
    if (Math.abs(p.vx) < 30) return 'stand';
    return Math.floor(game.walkPhase / 9) % 2; // swap leg pairs every 9px travelled
  }

  function drawPlayer(p) {
    // Turbo day: speed streaks behind you when you're really moving.
    if (game.level && game.level.twist === 'turbo' && Math.abs(p.vx) > 300) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,230,140,0.55)';
      ctx.lineWidth = 2;
      const back = p.vx > 0 ? -1 : 1;
      for (let k = 0; k < 3; k++) {
        const y = p.y + 4 + k * 6;
        const x = p.x + p.w / 2 + back * (p.w / 2 + 4);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + back * (12 + k * 5), y);
        ctx.stroke();
      }
      ctx.restore();
    }
    const s = game.squash;
    const grip = p.sliding ? Math.floor(game.slideAnim / 0.09) % 2 : 0;
    drawClawd(p.x + p.w / 2, p.y + p.h, p.facing, legPoseFor(p), playerColors(), 1 + 0.3 * s, 1 - 0.25 * s, p.clinging, grip);
  }

  function drawGhost(gh) {
    const p = gh.p;
    ctx.save();
    for (let i = 0; i < gh.trail.length; i++) {
      const t = gh.trail[i];
      ctx.globalAlpha = (i / gh.trail.length) * 0.35;
      ctx.fillStyle = '#9ad1ff';
      ctx.fillRect(t.x - 2, t.y - 2, 4, 4);
    }
    let alpha = gh.done ? Math.max(0, 0.45 * (1 - gh.wait)) : 0.45;
    if (gh.delay > 0) {
      alpha = 0.3 + 0.25 * Math.abs(Math.sin(gh.delay * 9)); // waiting at spawn: pulse
      const left = gh.delay / gh.delayTotal;
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = '#9ad1ff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x + p.w / 2, p.y + p.h / 2, 24, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
      ctx.stroke();
    }
    ctx.globalAlpha = alpha;
    drawClawd(p.x + p.w / 2, p.y + p.h, p.facing, p.onGround ? 'stand' : 'air', GHOST_COLORS, 1, 1, p.clinging);
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function render() {
    const lv = game.level;
    if (!lv) {
      ctx.fillStyle = '#14142b';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      return;
    }
    const th = themeOf(lv);
    const art = roomArt(lv);
    ctx.drawImage(art.bg, 0, 0, VIEW_W, VIEW_H);
    drawWeather(th, 'back');

    ctx.save();
    if (game.shake > 0 && !reduceMotion) {
      const m = game.shake * 14;
      ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
    }

    if (lv.updrafts) drawUpdrafts(lv.updrafts);
    if (lv.signs) drawSigns(lv.signs);
    ctx.drawImage(art.fg, 0, 0, VIEW_W, VIEW_H);
    if (lv.switches) drawSwitches(lv, game.player && game.state !== 'swarm' ? game.player.phase : 0);
    if (lv.belts) drawBelts(lv);

    ctx.fillStyle = 'rgba(180,88,59,0.5)'; // Clawd-coloured splats
    for (const sp of game.splats) {
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.drawImage(art.spikes, 0, 0, VIEW_W, VIEW_H);

    drawSaws(lv);
    drawGoal(lv.goal);
    if (game.flag && game.state !== 'swarm') drawFlag(game.flag);
    if (lv.shard && game.state !== 'swarm') drawShard(lv.shard);
    if (lv.key && game.state !== 'swarm' && !(game.player && game.player.hasKey && game.state !== 'dying')) {
      drawLock(lv.goal);
      drawKey(lv.key);
    }
    if (game.ghostOn && game.ghost && game.state === 'playing') drawGhost(game.ghost);
    if (game.state === 'playing') drawRacers();
    if (game.state === 'swarm') drawSwarm();
    else if (game.player && game.state !== 'dying') drawPlayer(game.player);
    if (game.state === 'playing') drawRacers(true);

    for (const pt of game.particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, pt.life * 2.5));
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - 3, pt.y - 3, 6, 6);
    }
    for (const r of game.rings) {
      ctx.globalAlpha = Math.max(0, r.life * 2);
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (game.flash > 0) {
      ctx.globalAlpha = game.flash * 0.22;
      ctx.fillStyle = '#ff3a4a';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = '800 16px system-ui, -apple-system, sans-serif';
    for (const pu of game.popups) {
      ctx.globalAlpha = Math.min(1, pu.life * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillText(pu.text, pu.x + 1.5, pu.y + 1.5);
      ctx.fillStyle = pu.color;
      ctx.fillText(pu.text, pu.x, pu.y);
    }
    ctx.globalAlpha = 1;
    if (devState.debug) drawDebug(lv);
    ctx.restore();
    drawWeather(th, 'front');
    if (game.intro > 0 && game.player) { // room start: a circle opening around you
      const k = 1 - game.intro / INTRO_T;
      const r = 20 + k * k * Math.hypot(VIEW_W, VIEW_H);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, VIEW_W, VIEW_H);
      ctx.arc(game.player.x + game.player.w / 2, game.player.y + game.player.h / 2, r, 0, Math.PI * 2, true);
      ctx.fillStyle = '#0b0b16';
      ctx.fill('evenodd');
      ctx.restore();
    }

    drawHud();
  }

  // On/off blocks follow *your* jumps, so they're drawn live, never baked into the
  // room art.  Each colour also has a shape (● red, ■ blue) for colour-blind players.
  const SWITCH_COLORS = { [SWITCH_A]: ['#ff4d6d', '#ffc2cc'], [SWITCH_B]: ['#3d9bff', '#bfe0ff'] };
  function drawSwitches(lv, phase) {
    const on = phase ? SWITCH_B : SWITCH_A;
    const pop = reduceMotion ? 0 : (game.swapT || 0) / 0.14; // a quick pulse on each swap
    ctx.save();
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const c = lv.grid[cy * COLS + cx];
        if (!isSwitch(c)) continue;
        const [fill, light] = SWITCH_COLORS[c];
        const x = cx * TILE;
        const y = cy * TILE;
        if (c === on) {
          const grow = pop * 2;
          ctx.fillStyle = fill;
          ctx.fillRect(x + 1 - grow, y + 1 - grow, TILE - 2 + grow * 2, TILE - 2 + grow * 2);
          ctx.fillStyle = light;
          ctx.fillRect(x + 1, y + 1, TILE - 2, 3);
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillRect(x + 1, y + TILE - 4, TILE - 2, 3);
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          ctx.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
          ctx.strokeStyle = fill;
          ctx.globalAlpha = 0.75;
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(x + 3, y + 3, TILE - 6, TILE - 6);
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          ctx.fillStyle = fill;
        }
        const mx = x + TILE / 2;
        const my = y + TILE / 2;
        if (c === SWITCH_A) { ctx.beginPath(); ctx.arc(mx, my, 4, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(mx - 4, my - 4, 8, 8);
      }
    }
    ctx.restore();
  }

  const INTRO_T = 0.32; // s for the room-start iris
  // Conveyors: a steel body with an amber running edge and chevrons sliding the way it
  // pushes (stopped for reduced motion — the chevrons still point the way).
  function drawBelts(lv) {
    const shift = reduceMotion ? 0 : (artT * PHYS.beltV * 0.25) % 15;
    ctx.save();
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const c = lv.grid[cy * COLS + cx];
        if (!isBelt(c)) continue;
        const x = cx * TILE;
        const y = cy * TILE;
        const d = c === BELT_R ? 1 : -1;
        ctx.fillStyle = '#2b2f3a';
        ctx.fillRect(x, y, TILE, TILE);
        ctx.fillStyle = '#ffb000';
        ctx.fillRect(x, y, TILE, 4);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x, y + TILE - 5, TILE, 5);
        ctx.strokeStyle = '#ffcc4d';
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (let k = -1; k < 2; k++) {
          const cxk = x + k * 15 + (d > 0 ? shift : 15 - shift) + 7.5;
          if (cxk < x + 3 || cxk > x + TILE - 3) continue;
          ctx.moveTo(cxk - d * 4, y + 9);
          ctx.lineTo(cxk + d * 3, y + 15);
          ctx.lineTo(cxk - d * 4, y + 21);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  const PACE_AHEAD = '#7dffa1';
  const PACE_BEHIND = '#ff7a7a';
  function drawHud() {
    ctx.font = '600 17px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(0, 0, VIEW_W, 30);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    const retry = solo();
    const muteTag = sfx.muted ? ' · 🔇' : '';
    const tag = muteTag + (game.mode === 'endless' || game.mode === 'tutorial' ? ' · Esc: quit' : game.mode === 'archive' ? ' · past level (Esc: back)' : retry ? ' · retry (Esc: back)' : game.practice ? ' · practice' : '') + (game.ghostOn ? ' · 👻 ghost' : '') + (game.flag ? ' · 🚩 flag' : '');
    const day = game.mode === 'tutorial' ? '🎓 How to play' : game.mode === 'endless' ? '∞ Endless' : set === today ? `#${dayNum}` : niceDate(set.date);
    const roomLabel = game.mode === 'tutorial' ? 'reach the ★' : game.mode === 'endless' ? `Room ${game.endless.depth + 1} · ❤ ${game.endless.lives}`
      : game.levelIdx === BONUS_ROOM ? '☠ Bonus' : `Room ${game.levelIdx + 1}/3`;
    const assistTag = assist < 1 ? ` · 🐢 ${Math.round(assist * 100)}%` : '';
    const lockTag = assistTag + (game.level.key ? (game.player && game.player.hasKey ? ' · 🔑' : ' · 🔒') : '');
    const twistTag = lockTag + (game.level.twist && TWISTS[game.level.twist] ? ` · ${TWISTS[game.level.twist].icon} ${TWISTS[game.level.twist].name}` : '');
    ctx.fillText(`${day} · ${roomLabel} · ${game.level.cfg.name}${twistTag} · ${themeOf(game.level).name}${tag}`, 14, 7);
    ctx.textAlign = 'right';
    const best = set.bests[game.levelIdx];
    // Before your first input the room clock says so itself — in the HUD bar, never
    // over the playfield, where a hint could cover a spike while you plan your route.
    const waiting = game.state === 'playing' && !game.roomStarted;
    const roomPart = waiting ? '⏳ starts on your first move'
      : `room ${formatRoomTime(game.state === 'rankCard' && game.lastClear ? game.lastClear.time : game.roomTime)}`;
    const bestPart = best ? ` · best ${formatRoomTime(best.time)}` : '';
    const deaths = retry ? game.retryDeaths : game.deaths.reduce((a, b) => a + b, 0);
    const total = retry ? '' : `   ⏱ ${formatTime(game.time)}`;
    // Drawn right to left in pieces so "best" can show your pace like a speedrun
    // split: green while this attempt is still on pace, red once it's behind.
    const tail = `   💀 ${deaths}${total}`;
    let x = VIEW_W - 14;
    ctx.fillText(tail, x, 7);
    x -= ctx.measureText(tail).width;
    if (bestPart) {
      const live = game.state === 'playing' && game.roomStarted && !game.attemptFlag; // a flag run starts mid-room: no pace
      ctx.fillStyle = !live ? '#ffffff' : game.roomTime <= best.time ? PACE_AHEAD : PACE_BEHIND;
      ctx.fillText(bestPart, x, 7);
      x -= ctx.measureText(bestPart).width;
    }
    ctx.fillStyle = waiting ? `rgba(255,209,102,${0.65 + 0.35 * Math.abs(Math.sin(artT * 3))})` : '#ffffff';
    ctx.fillText(roomPart, x, 7);

  }

  // ---------- rank card ----------
  // A full-screen card after every clear: your rank as giant ASCII art that decodes
  // out of noise like a terminal, plus the whole ladder in real seconds for this room.
  const NOISE = '░▒▓█╔╗╚╝═║#@%&*+=<>/\\?';
  const CARD_REVEAL = 0.7;   // s to decode the letter
  const CARD_ARM = 0.45;     // s before a key press can dismiss it — the jump you were
                             // holding when you touched the goal must not skip the card
  const card = { art: null, el: null, t0: 0, glitch: false, id: 0 }; // id: which card a late server reply belongs to

  // LiveSplit-style delta against a previous time: green when faster, red when slower.
  function splitTag(time, ref) {
    if (ref == null || !Number.isFinite(ref)) return '';
    const d = Math.round((time - ref) / DT) * DT;
    if (d === 0) return ' <span class="split even">±0.00</span>';
    return ` <span class="split ${d < 0 ? 'ahead' : 'behind'}">${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}</span>`;
  }

  function showRankCard(again = false) {
    if (!again) card.id++; // a re-shown card still takes the server's late reply
    if (!again) card.net = null;
    const c = game.lastClear;
    const ghostT = game.level.ghostTime;
    const rIdx = RANKS.indexOf(c.rank);
    const impossible = c.rank.name === 'IMPOSSIBLE';
    const best = set.bests[game.levelIdx];
    const last = !solo() && game.levelIdx === LEVELS.length - 1;

    const ladder = RANKS.map((r, k) => {
      const limit = ghostT * r.upTo;
      const cut = r.upTo === Infinity ? `&gt; ${formatRoomTime(ghostT * RANKS[k - 1].upTo)}` : `≤ ${formatRoomTime(limit)}`;
      const note = r.name === 'IMPOSSIBLE' ? 'ghost · you\'d have to cheat' : '';
      const you = k === rIdx;
      return `<div class="lad${you ? ' you' : ''}${k < rIdx ? ' above' : ''}" style="--rc:${r.color}">
        <span class="lad-mark">${you ? '▶' : ''}</span><span class="lad-name">${r.name}</span>
        <span class="lad-cut">${cut}</span><span class="lad-note">${you ? `you · ${formatRoomTime(c.time)}` : note}</span></div>`;
    }).join('');

    let chase = '';
    if (rIdx > 0) {
      const up = RANKS[rIdx - 1];
      const need = c.time - ghostT * up.upTo;
      chase = up.name === 'IMPOSSIBLE'
        ? `match the ghost's ${formatRoomTime(ghostT)} for <b style="color:${up.color}">IMPOSSIBLE</b> — good luck`
        : `<b>${Math.max(0.01, need).toFixed(2)}s</b> faster for <b style="color:${up.color}">${up.name}</b>`;
    } else {
      chase = 'you matched a frame-perfect bot… did you cheat?';
    }

    const primary = game.mode === 'archive' ? 'Back to past levels' : game.mode === 'retry' ? 'Back to results' : last ? 'See results' : 'Next room ▶';
    overlay.classList.add('card');
    overlay.hidden = false;
    ghostBtn.hidden = true;
    overlay.innerHTML = `
      <div class="card-top">${game.levelIdx === BONUS_ROOM ? '☠ BONUS' : `ROOM ${game.levelIdx + 1}`} · ${game.level.cfg.name.toUpperCase()}${game.level.twist && TWISTS[game.level.twist] ? ` · ${TWISTS[game.level.twist].icon} ${TWISTS[game.level.twist].name.toUpperCase()}` : ''} · CLEAR</div>
      <pre class="rank-art${impossible ? ' glitch' : ''}" style="--rc:${c.rank.color}"></pre>
      <div class="card-time"><span class="big">${formatRoomTime(c.time)}</span>
        <span class="card-sub">ghost ${formatRoomTime(ghostT)} · ×${(Math.round(c.time / DT) / Math.round(ghostT / DT)).toFixed(2)}${game.attemptAssist ? ' · 🐢 assisted' : ''}</span></div>
      <div class="card-best">${c.newBest ? `✨ NEW BEST${splitTag(c.time, c.prevBest)}` : best && best.time < c.time ? `best ${formatRoomTime(best.time)}${splitTag(c.time, best.time)}` : ''}${
        game.shardClear ? `<span class="card-shard">✦ SHARD${game.shardClear.first ? ' COLLECTED' : ''}</span>`
        : game.level.shard && !set.shards[game.levelIdx] ? '<span class="card-shard missed">✧ this room hides a shard</span>' : ''}</div>
      <div class="ladder">${ladder}</div>
      <div class="card-chase">${chase}</div>
      <div class="card-net" id="cardNet"></div>
      <div class="card-crowd" id="cardCrowd"></div>
      <div class="card-btns">
        ${solo() ? '<button id="cardRetry" class="secondary">Retry <kbd>R</kbd></button>' : ''}
        ${game.tries.length > 1 ? `<button id="cardReplay" class="secondary">▶ Replay ${game.triesTotal > game.tries.length ? `last ${game.tries.length}` : `all ${game.tries.length}`} <kbd>P</kbd></button>` : ''}
        <button id="cardNext">${primary} <kbd>Enter</kbd></button>
      </div>`;
    // same arming delay as keys: a tap that skipped the replay can't land on a button
    const armed = (fn) => () => { if (performance.now() / 1000 - card.t0 >= CARD_ARM) fn(); };
    overlay.querySelector('#cardNext').addEventListener('click', armed(cardNext));
    const rb = overlay.querySelector('#cardRetry');
    if (rb) rb.addEventListener('click', armed(cardRetry));
    const pb = overlay.querySelector('#cardReplay');
    if (pb) pb.addEventListener('click', armed(startSwarm));


    card.art = asciiWord(c.rank.name);
    card.el = overlay.querySelector('.rank-art');
    card.t0 = performance.now() / 1000;
    card.glitch = impossible;
    card.sting = again ? card.pendingSting || null : c.rank.name; // played once the letter finishes decoding
    // Fit the art to the card's width: the word IMPOSSIBLE is ~75 columns wide.
    const cols = Math.max(...card.art.map((l) => l.length));
    const width = overlay.clientWidth || 900;
    card.el.style.fontSize = `${Math.min(impossible ? 22 : 30, (width * 0.82) / (cols * 0.62))}px`;
    if (again && card.net) setCardNet(card.id, card.net[0], card.net[1]);
    if (!again) card.crowd = null;
    else if (card.crowd) { const cc = overlay.querySelector('#cardCrowd'); if (cc) cc.textContent = card.crowd; }
    cardTick();
  }

  // Called every frame while the card is up: decode the letter, then (IMPOSSIBLE
  // only) keep it glitching forever.
  function cardTick() {
    if (game.state !== 'rankCard' || !card.el) return;
    const t = performance.now() / 1000 - card.t0;
    if (card.sting && t >= CARD_REVEAL) { sfx.rank(card.sting); card.sting = null; }
    const p = Math.min(1, t / CARD_REVEAL);
    const rows = card.art.length;
    const out = card.art.map((line, r) => line.split('').map((ch, x) => {
      if (ch === ' ') return ' ';
      // sweep diagonally: a character settles once the wave passes it
      const settle = (x / line.length) * 0.75 + (r / rows) * 0.25;
      if (p < settle) return Math.random() < p * 1.3 ? NOISE[(Math.random() * NOISE.length) | 0] : ' ';
      if (card.glitch && Math.random() < 0.012) return NOISE[(Math.random() * NOISE.length) | 0];
      return ch;
    }).join(''));
    card.el.textContent = out.join('\n');
  }

  function cardKey(e) {
    if (e.repeat || performance.now() / 1000 - card.t0 < CARD_ARM) return;
    if (e.code === 'Enter' || e.code === 'Space' || e.code === 'ArrowRight' || e.code === 'NumpadEnter') cardNext();
    else if (e.code === 'KeyR') cardRetry();
    else if (e.code === 'KeyP') startSwarm();
    else if (e.code === 'Escape' && solo()) leaveSolo(game.levelIdx);
  }

  // ---------- overlays ----------
  function hideOverlay() {
    overlay.classList.remove('card');
    card.el = null;
    overlay.hidden = true;
    overlay.innerHTML = '';
  }

  function showTitle() {
    sfx.musicStop();
    ghostBtn.hidden = true;
    overlay.hidden = false;
    overlay.innerHTML = `
      <h1>Daily Jump</h1>
      <p class="sub">#${dayNum} · ${dateKey}</p>
      ${streakLine() ? `<p class="streak">${streakLine()}</p>` : ''}
      ${twistBanner()}
      ${STATIC_HOST ? '<p class="twist">📡 Offline mode — the game server is away, so today\'s rooms are built on this device. Leaderboards are back soon.</p>' : ''}
      <p class="challenge" id="challenge" hidden></p>
      <p>Three rooms, one screen each.<br>Same rooms for everyone today.</p>
      <p class="keys"><kbd>←</kbd><kbd>→</kbd> / <kbd>A</kbd><kbd>D</kbd> move &nbsp; <kbd>Space</kbd> / <kbd>Z</kbd> jump &nbsp; <kbd>R</kbd> restart room &nbsp; <kbd>G</kbd> ghost &nbsp; <kbd>V</kbd> racers &nbsp; <kbd>M</kbd> sound &nbsp; <kbd>N</kbd> music</p>
      <p class="pad-keys">🎮 stick / D-pad move &nbsp; <b>A</b> jump &nbsp; <b>Y</b> restart room &nbsp; <b>X</b> ghost</p>
      <p class="touch-keys">◀ ▶ move &nbsp; <b>JUMP</b> (hold to go higher) &nbsp; ↻ restart room</p>${dev ? '<p class="hint">Dev mode — results are not saved. 🛠 bottom-left opens the menu.</p>' : ''}
      <button id="start">Start</button>
      ${game.tutorialCleared ? '<p class="twist">🎓 You\'re ready — today\'s rooms use everything you just learned.</p>' : ''}
      <div class="menu-row">${API ? '<button id="pastLevels" class="secondary">Past levels</button>' : ''}${endlessButton()}<button id="tutorial" class="secondary">${tutorialDone() ? '🎓 How to play' : 'New? 🎓 How to play'}</button></div>
      <div class="menu-row chips"><button id="assist" class="secondary chip">${assistLabel()}</button><button id="skin" class="secondary chip">${skinLabel()}</button><button id="contrast" class="secondary chip">${highContrast ? '👁 High contrast: on' : '👁 High contrast'}</button>${installChip()}</div>
      ${statsHtml()}
      ${badgesHtml()}
      <p class="hint">Hold jump to go higher. Press into a wall to slide, jump to kick off it — chain kicks to climb. Stuck? ${touch.on ? 'The 👻 button' : '<kbd>G</kbd>'} shows the level-checker's run (marks your result 👻).</p>`;
    overlay.querySelector('#start').addEventListener('click', () => startRun(false));
    const eb = overlay.querySelector('#endless');
    if (eb) eb.addEventListener('click', () => startEndless('title'));
    overlay.querySelector('#tutorial').addEventListener('click', startTutorial);
    bindInstall();
    showChallenge();
    const hb = overlay.querySelector('#contrast');
    if (hb) hb.addEventListener('click', () => { const on = toggleContrast(); hb.textContent = on ? '👁 High contrast: on' : '👁 High contrast'; });
    const sb = overlay.querySelector('#skin');
    if (sb) sb.addEventListener('click', () => { cycleSkin(); sb.textContent = skinLabel(); });
    const ab = overlay.querySelector('#assist');
    if (ab) ab.addEventListener('click', () => { cycleAssist(); ab.textContent = assistLabel(); });
    const past = overlay.querySelector('#pastLevels');
    if (past) past.addEventListener('click', () => { game.arcReturn = 'title'; showArchive(); });
    armSecret();
  }

  // Today's twist, from the rooms themselves (stored days from before twists have none).
  const dayTwist = () => { const t = roomAt(0).twist; return t && TWISTS[t] ? TWISTS[t] : null; };
  function twistBanner() {
    const t = dayTwist();
    return t ? `<p class="twist">Today's twist: <b>${t.icon} ${t.name}</b> — ${t.desc}</p>` : '';
  }

  function shareText(result) {
    const squares = result.deaths.map((d) => (d === 0 ? '🟩' : d <= 4 ? '🟨' : '🟥')).join('');
    const ghost = (result.ghost ? ' 👻' : '') + (result.assist ? ' 🐢' : '');
    const corners = result.cornerKicks ? ` ⚡${result.cornerKicks}` : '';
    const rt = result.roomTimes;
    const ranks = Array.isArray(rt) && rt.length === LEVELS.length && rt.every(Number.isFinite)
      ? `\n${rt.map((t, i) => rankFor(t, roomAt(i).ghostTime).name).join(' · ')}`
      : '';
    const st = streak().current;
    const fire = st >= 2 ? ` 🔥${st}` : '';
    const shardRooms = LEVELS.map((_, i) => roomAt(i)).filter((r) => r.shard).length;
    const shardsGot = LEVELS.filter((_, i) => today.shards[i]).length;
    const shardTxt = shardsGot ? ` ✦${shardsGot}/${shardRooms}` : '';
    const nb = today.bests[BONUS_ROOM];
    const nightmare = nb ? `\n☠ ${BONUS.name} ${formatRoomTime(nb.time)}${nb.ghost ? ' 👻' : ''}` : '';
    const tw = dayTwist();
    return `Daily Jump #${dayNum}${tw ? ` ${tw.icon}` : ''} ⏱ ${formatTime(result.time)}${ghost}${fire}${shardTxt}\n${squares} 💀 ${result.deaths.join('/')}${corners}${ranks}${nightmare}${API ? `\n${shareLink()}` : ''}`; // a link back, so friends can play too
  }

  // Today's boards: your name (renamable), overall top 10, and each room's top 5
  // with your own place underneath if you're further down.
  // The weekly league: days completed this week first, then the sum of those days.
  function weekHtml(wk) {
    if (!wk || !wk.top || !wk.top.length) return '';
    const row = (e) => `<li class="${e.me ? 'me' : ''}"><span class="lb-place">${e.place}</span><span class="lb-name">${esc(e.name)}${e.ghost ? ' 👻' : ''}${e.assist ? ' 🐢' : ''}</span><span class="lb-days">${'●'.repeat(e.days)}${'○'.repeat(Math.max(0, 7 - e.days))}</span><span class="lb-time">${formatTime(e.time)}</span></li>`;
    const mine = wk.mine && !wk.top.some((e) => e.me) ? row(wk.mine) : '';
    return `<div class="lb-week"><h3>🏆 This week <small>${niceDate(wk.from)} – ${niceDate(wk.to)} · days played, then total time</small></h3>
      <ol>${wk.top.map(row).join('')}${mine}</ol></div>`;
  }

  async function loadBoard() {
    const el = overlay.querySelector('#board');
    if (!el) return;
    let lb;
    try {
      lb = await api('GET', `/api/leaderboard/${dateKey}`);
      lb.week = await api('GET', `/api/week/${dateKey}`).catch(() => null);
    } catch {
      el.innerHTML = '<p class="hint">⚠ leaderboard unavailable</p>';
      return;
    }
    if (!overlay.contains(el)) return; // screen changed while we waited
    const row = (e) => `<li class="${e.me ? 'me' : ''}"><span class="lb-place">${e.place}</span><span class="lb-name">${esc(e.name)}${e.ghost ? ' 👻' : ''}${e.assist ? ' 🐢' : ''}${e.streak >= 2 ? ` <span class="lb-streak">🔥${e.streak}</span>` : ''}</span><span class="lb-time">${formatRoomTime(e.time)}</span>${e.rank ? `<span class="lb-rank" style="color:${RANKS.find((r) => r.name === e.rank).color}">${e.rank === 'IMPOSSIBLE' ? '!!' : e.rank}</span>` : '<span></span>'}</li>`;
    const roomCol = (b, i) => {
      const meInTop = b.top.slice(0, 5).some((e) => e.me);
      const mine = b.mine && !meInTop
        ? `<li class="me"><span class="lb-place">${b.mine.place}</span><span class="lb-name">you</span><span class="lb-time">${formatRoomTime(b.mine.time)}</span><span></span></li>` : '';
      const typical = [
        b.median != null && b.total >= 2 ? `median ${formatRoomTime(b.median)}` : '',
        b.medianDeaths != null ? `typically 💀 ${b.medianDeaths}` : '',
        b.entered >= 5 ? `${Math.min(100, Math.round((100 * (b.cleared || 0)) / b.entered))}% clear it` : '',
      ].filter(Boolean).join(' · ');
      return `<div class="lb-col"><h3>${cfgFor(i).name} <small>${b.total} player${b.total === 1 ? '' : 's'}</small>${typical ? `<small class="lb-typical">${typical}</small>` : ''}</h3>
        <ol>${b.top.slice(0, 5).map(row).join('') || '<li class="lb-empty">nobody yet</li>'}${mine}</ol></div>`;
    };
    const who = player && player.token
      ? `Playing as <b id="lbName">${esc(lb.you ? lb.you.name : player.name)}</b> <button class="link" id="rename">rename</button>`
      : 'Clear a room to join today’s board.';
    el.innerHTML = `
      <div class="lb-who">${who}</div>
      <div class="lb-overall"><h3>Today · all three rooms <small>sum of best verified times</small></h3>
        <ol>${lb.overall.map(row).join('') || '<li class="lb-empty">nobody has cleared all three yet</li>'}</ol></div>
      ${weekHtml(lb.week)}
      <div class="lb-rooms">${lb.rooms.map(roomCol).join('')}</div>
      ${lb.bonus ? `<div class="lb-rooms lb-bonus">${roomCol(lb.bonus, BONUS_ROOM)}</div>` : ''}`;
    const rename = el.querySelector('#rename');
    if (rename) rename.addEventListener('click', () => startRename(el));
  }

  function startRename(el) {
    const who = el.querySelector('.lb-who');
    who.innerHTML = `<form id="nameForm"><input id="nameInput" maxlength="20" value="${esc(player.name)}" aria-label="Your name"> <button type="submit" class="link">save</button></form>`;
    const input = who.querySelector('#nameInput');
    input.focus();
    input.select();
    // keep the game's keys (space, arrows, R, G...) out of the text field
    input.addEventListener('keydown', (e) => e.stopPropagation());
    who.querySelector('#nameForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const p = await api('PATCH', '/api/players/me', { name: input.value });
        player = { ...player, name: p.name };
        try { localStorage.setItem(PLAYER_KEY, JSON.stringify(player)); } catch { /* session only */ }
        loadBoard();
      } catch (err) {
        input.setCustomValidity(err.message);
        input.reportValidity();
      }
    });
  }

  // ---------- past levels ----------
  // Every stored day before today, as day cards (newest first) or one flat list of
  // rooms ordered by difficulty, filterable by Easy / Medium / Hard / Brutal.
  // Each room shows its theme, a 1-10 difficulty meter, the ghost's time, how
  // many have cleared it, and your best + rank.  Click one to play it.
  const DIFF_COLORS = { Easy: '#7bc950', Medium: '#ffd166', Hard: '#ff9f43', Brutal: '#ff5d73' };
  const arc = { days: null, sort: 'newest', filter: 'All', error: null };
  const archiveSets = new Map(); // date -> set, so replaying a day doesn't refetch it

  function niceDate(date) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function archiveBack() {
    if (game.arcReturn === 'results' && game.shownResult) {
      game.state = 'results';
      showResults(game.shownResult, game.shownPractice);
    } else {
      game.state = 'title';
      showTitle();
    }
  }

  async function showArchive(highlight = null) {
    sfx.musicStop();
    game.state = 'archive';
    game.mode = 'run';
    ghostBtn.hidden = true;
    overlay.classList.remove('card');
    card.el = null;
    overlay.hidden = false;
    overlay.innerHTML = `
      <h1>Past levels</h1>
      <div class="arc-tools">
        <div class="seg" id="arcSort">${[['newest', 'Newest'], ['hardest', 'Hardest'], ['easiest', 'Easiest']]
          .map(([k, label]) => `<button data-sort="${k}" class="${arc.sort === k ? 'on' : ''}">${label}</button>`).join('')}</div>
        <div class="seg" id="arcFilter">${['All', 'Easy', 'Medium', 'Hard', 'Brutal']
          .map((k) => `<button data-filter="${k}" class="${arc.filter === k ? 'on' : ''}" ${k !== 'All' ? `style="--dc:${DIFF_COLORS[k]}"` : ''}>${k}</button>`).join('')}</div>
      </div>
      <div class="arc-list" id="arcList"><p class="hint">loading…</p></div>
      <button id="arcBack" class="secondary">Back <kbd>Esc</kbd></button>`;
    overlay.querySelector('#arcBack').addEventListener('click', archiveBack);
    overlay.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => { arc.sort = b.dataset.sort; showArchive(); }));
    overlay.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { arc.filter = b.dataset.filter; showArchive(); }));
    try {
      arc.days = (await api('GET', '/api/archive')).days;
      arc.error = null;
    } catch {
      arc.error = 'Could not reach the server.';
    }
    if (game.state !== 'archive') return; // left while loading
    renderArchive(highlight);
  }

  function renderArchive(highlight) {
    const list = overlay.querySelector('#arcList');
    if (!list) return;
    if (arc.error) { list.innerHTML = `<p class="hint">⚠ ${esc(arc.error)}</p>`; return; }
    const rooms = [];
    for (const d of arc.days) {
      const local = loadBests(d.date);
      for (const r of d.rooms) {
        // your best: the better of this browser's and the server's
        const l = local[r.room];
        const time = Math.min(l ? l.time : Infinity, r.mine ? r.mine.time : Infinity);
        rooms.push({ ...r, date: d.date, dayNum: d.dayNum, best: Number.isFinite(time) ? time : null });
      }
    }
    const shown = rooms.filter((r) => arc.filter === 'All' || r.label === arc.filter);
    if (!arc.days.length) { list.innerHTML = '<p class="hint">No past levels yet — the archive fills up one day at a time.</p>'; return; }
    if (!shown.length) { list.innerHTML = `<p class="hint">No ${arc.filter.toLowerCase()} rooms yet.</p>`; return; }
    const tile = (r, withDate) => {
      const th = THEMES[r.theme] || THEMES[THEME_KEYS[0]];
      const rank = r.best ? rankFor(r.best, r.ghostTime) : null;
      const hl = highlight && highlight.date === r.date && highlight.room === r.room;
      const meter = Array.from({ length: 10 }, (_, k) => `<i class="${k < r.rating ? 'f' : ''}"></i>`).join('');
      return `<button class="tile${hl ? ' hl' : ''}" data-date="${r.date}" data-room="${r.room}"
          style="--s1:${th.sky[0]};--s2:${th.sky[1]};--s3:${th.sky[2]};--e:${th.edge};--f:${th.fill};--dc:${DIFF_COLORS[r.label]}">
        <span class="tile-art"><span class="tile-icon">${th.icon}</span>${r.twist && TWISTS[r.twist] ? `<span class="tile-twist" title="${TWISTS[r.twist].name} day">${TWISTS[r.twist].icon} ${TWISTS[r.twist].name}</span>` : ''}</span>
        <span class="tile-body">
          <span class="tile-top"><b>${r.name}</b><span class="tile-theme">${esc(th.name)}</span></span>
          ${withDate ? `<span class="tile-date">${niceDate(r.date)}</span>` : ''}
          <span class="meter" title="difficulty ${r.rating}/10">${meter}</span>
          <span class="tile-diff">${r.label} · ${r.rating}/10</span>
          <span class="tile-meta">ghost ${formatRoomTime(r.ghostTime)} · ${r.players} cleared${r.avgDeaths != null ? ` · ~${r.avgDeaths.toFixed(1)} deaths` : ''}</span>
          <span class="tile-best">${r.best ? `best ${formatRoomTime(r.best)} <b style="color:${rank.color}">${rank.name === 'IMPOSSIBLE' ? '!!' : rank.name}</b>` : '<span class="muted">not played</span>'}</span>
        </span>
      </button>`;
    };
    if (arc.sort === 'newest') {
      const byDay = new Map();
      for (const r of shown) {
        if (!byDay.has(r.date)) byDay.set(r.date, []);
        byDay.get(r.date).push(r);
      }
      list.innerHTML = [...byDay.entries()].map(([date, rs]) => {
        const all = rooms.filter((r) => r.date === date);
        const avg = all.reduce((a, r) => a + r.rating, 0) / all.length;
        const num = rs[0].dayNum >= 1 ? `#${rs[0].dayNum} · ` : '';
        return `<section class="day"><header><b>${niceDate(date)}</b><span>${num}day difficulty ${avg.toFixed(1)}</span></header>
          <div class="day-rooms">${rs.map((r) => tile(r, false)).join('')}</div></section>`;
      }).join('');
    } else {
      const dir = arc.sort === 'hardest' ? -1 : 1;
      shown.sort((a, b) => dir * (a.score - b.score) || (a.date < b.date ? 1 : -1));
      list.innerHTML = `<div class="flat">${shown.map((r) => tile(r, true)).join('')}</div>`;
    }
    list.querySelectorAll('.tile').forEach((b) => {
      b.addEventListener('click', () => playArchived(b.dataset.date, Number(b.dataset.room)));
    });
  }

  async function playArchived(date, room) {
    let s = archiveSets.get(date);
    if (!s) {
      try {
        const data = await api('GET', `/api/levels/${date}`);
        s = { date, dayNum: data.dayNum, rooms: data.rooms.map((r) => deserializeLevel(r.level, r.room, r.theme)), bests: loadBests(date), shards: loadShards(date) };
        archiveSets.set(date, s);
      } catch {
        return; // stay on the list
      }
    }
    s.bests = loadBests(date); // pick up anything set elsewhere
    set = s;
    game.mode = 'archive';
    game.retryDeaths = 0;
    game.particles = [];
    game.popups = [];
    hideOverlay();
    ghostBtn.hidden = false;
    loadLevel(room);
  }

  let countdownTimer = null;
  function roomRowsHtml(result, highlight) {
    const c = game.lastClear;
    return LEVELS.map((cfg, i) => {
      const d = result.deaths[i];
      const b = today.bests[i];
      const room = roomAt(i);
      const rank = b ? rankFor(b.time, room.ghostTime) : null;
      const justNow = highlight === i && c
        ? `<div class="room-now">${c.newBest ? '✨ new best!' : `this try ${formatRoomTime(c.time)} · ${c.rank.name}`}</div>`
        : '';
      return `
        <div class="room-row${highlight === i ? ' hl' : ''}">
          <div class="room-name">${cfg.name}${shardMark(i, room)}<small>${d === 0 ? 'flawless' : `${d} death${d === 1 ? '' : 's'}`} · ghost ${formatRoomTime(room.ghostTime)}</small></div>
          <div class="room-best">${b ? `${formatRoomTime(b.time)}${b.ghost ? ' 👻' : ''}${b.assist ? ' 🐢' : ''}` : '—'}${justNow}</div>
          <div class="rank" style="color:${rank ? rank.color : 'inherit'}">${rank ? rank.name : ''}</div>
          <button class="retry" data-room="${i}">Retry</button>
        </div>`;
    }).join('') + bonusRowHtml(highlight);
  }

  // ✦ collected · ✧ this room has one you haven't got yet
  function shardMark(i, room) {
    if (today.shards[i]) return ' <span class="shard-mark" title="shard collected">✦</span>';
    return room && room.shard ? ' <span class="shard-mark missed" title="this room hides a shard">✧</span>' : '';
  }

  function bonusRowHtml(highlight) {
    const i = BONUS_ROOM;
    const b = today.bests[i];
    const room = today.rooms[i];
    const ghostTime = room ? room.ghostTime : b && b.ghostTime;
    const rank = b && ghostTime ? rankFor(b.time, ghostTime) : null;
    const c = game.lastClear;
    const justNow = highlight === i && c
      ? `<div class="room-now">${c.newBest ? '✨ new best!' : `this try ${formatRoomTime(c.time)} · ${c.rank.name}`}</div>` : '';
    return `
        <div class="room-row bonus-row${highlight === i ? ' hl' : ''}">
          <div class="room-name">☠ ${BONUS.name}${room ? shardMark(i, room) : ''}<small>bonus room · not in your daily total</small></div>
          <div class="room-best">${b ? `${formatRoomTime(b.time)}${b.ghost ? ' 👻' : ''}${b.assist ? ' 🐢' : ''}` : '—'}${justNow}</div>
          <div class="rank" style="color:${rank ? rank.color : 'inherit'}">${rank ? rank.name : ''}</div>
          <button class="retry" id="bonus">${b ? 'Retry' : 'Enter'}</button>
        </div>`;
  }

  // The link in shared results: the server's permanent share URL when it has one.
  const shareLink = () => {
    const m = document.querySelector && document.querySelector('meta[name="share-url"]');
    const v = m && m.getAttribute && m.getAttribute('content');
    return v && /^https?:\/\//.test(v) ? v : API;
  };
  const canShareSheet = () => typeof navigator.share === 'function' &&
    (touch.on || !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches));

  function showResults(result, practice, highlight = null) {
    sfx.musicStop();
    overlay.classList.remove('card');
    card.el = null;
    game.shownResult = result;
    game.shownPractice = practice;
    ghostBtn.hidden = true;
    overlay.hidden = false;
    const text = shareText(result);
    overlay.innerHTML = `
      <h1>${practice ? 'Practice run' : 'Done!'}</h1>
      <p class="sub">Daily Jump #${dayNum}</p>
      <div class="big">${formatTime(result.time)}</div>
      ${!practice && streakLine() ? `<p class="streak">${streakLine()}</p>` : ''}
      <div class="room-rows">
        <div class="room-head"><span>Room</span><span>Best</span><span>Rank</span><span></span></div>
        ${roomRowsHtml(result, highlight)}
      </div>
      ${result.cornerKicks ? `<p class="hint">⚡ ${result.cornerKicks} corner kick${result.cornerKicks === 1 ? '' : 's'}</p>` : ''}
      <div class="board" id="board">${API ? '<p class="hint">loading leaderboard…</p>' : (STATIC_HOST ? '<p class="hint">📡 Offline mode: leaderboards are back when the server is — your result is saved on this device.</p>' : '<p class="hint">Leaderboards need the server: <code>cd server && npm start</code>, then open http://127.0.0.1:8787</p>')}</div>
      <pre class="share">${text}</pre>
      <div class="menu-row">${practice ? '' : `<button id="share">${canShareSheet() ? 'Share result' : 'Copy result'}</button>`}${game.mapRun && game.mapRun.result === result ? '<button id="deathMap" class="secondary">📸 Death map</button>' : ''}${API && !practice ? '<button id="challengeBtn" class="secondary">⚔ Challenge a friend</button>' : ''}</div>
      <div class="menu-row"><button id="again" class="secondary">${practice ? 'Practice again' : 'Practice run'}</button>${API ? '<button id="pastLevels" class="secondary">Past levels</button>' : ''}${endlessButton()}</div>
      ${statsHtml()}
      ${badgesHtml()}
      <p class="hint">Next rooms in <span id="countdown"></span></p>`;
    const shareBtn = overlay.querySelector('#share');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        // Phones get the native share sheet (Messages, WhatsApp…); desktops copy.
        if (canShareSheet()) {
          try {
            await navigator.share({ text });
            return;
          } catch (err) {
            if (err && err.name === 'AbortError') return; // closed the sheet: nothing to do
          }
        }
        try {
          await navigator.clipboard.writeText(text);
          shareBtn.textContent = 'Copied!';
        } catch {
          shareBtn.textContent = 'Copy failed — select the text above';
        }
      });
    }
    overlay.querySelector('#again').addEventListener('click', () => startRun(true));
    const mapBtn = overlay.querySelector('#deathMap');
    if (mapBtn) mapBtn.addEventListener('click', () => shareDeathMap(mapBtn, game.mapRun, practice).catch(() => { mapBtn.textContent = '⚠ could not make the map'; }));
    const cb = overlay.querySelector('#challengeBtn');
    if (cb) {
      cb.addEventListener('click', async () => {
        try {
          const link = await challengeLink();
          const text = `⚔ I challenge you to today's Daily Jump — race my ghost: ${link}`;
          if (canShareSheet()) { try { await navigator.share({ text }); return; } catch (err) { if (err && err.name === 'AbortError') return; } }
          await navigator.clipboard.writeText(text);
          cb.textContent = '⚔ Challenge link copied!';
        } catch {
          cb.textContent = '⚠ could not make a link (offline?)';
        }
      });
    }
    const past = overlay.querySelector('#pastLevels');
    if (past) past.addEventListener('click', () => { game.arcReturn = 'results'; showArchive(); });
    if (API) loadBoard();
    overlay.querySelectorAll('[data-room]').forEach((btn) => {
      btn.addEventListener('click', () => startRetry(Number(btn.dataset.room)));
    });
    const eb = overlay.querySelector('#endless');
    if (eb) eb.addEventListener('click', () => startEndless('results'));
    const bonusBtn = overlay.querySelector('#bonus');
    if (bonusBtn) bonusBtn.addEventListener('click', startBonus);
    armSecret();
    clearInterval(countdownTimer);
    const tick = () => {
      const el = document.getElementById('countdown');
      if (!el) return clearInterval(countdownTimer);
      if (dayRolledOver() && game.state === 'results') return location.reload();
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const s = Math.max(0, Math.floor((next - now) / 1000));
      const pad = (n) => String(n).padStart(2, '0');
      el.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  // ---------- secret: unlock the dev menu ----------
  // Click the date line three times, then the title, within a few seconds — on the
  // title screen or the results screen.  Unlocking sticks (localStorage) until you
  // pick "exit dev mode" in the menu.
  const SECRET = ['sub', 'sub', 'sub', 'title'];
  let secretClicks = [];
  function armSecret() {
    const hit = (what) => () => {
      const now = Date.now();
      secretClicks = secretClicks.filter((c) => now - c.t < 4000).concat({ what, t: now }).slice(-SECRET.length);
      if (secretClicks.map((c) => c.what).join() === SECRET.join()) {
        secretClicks = [];
        enableDev();
      }
    };
    overlay.querySelector('h1').addEventListener('click', hit('title'));
    overlay.querySelector('.sub').addEventListener('click', hit('sub'));
  }

  function enableDev() {
    if (dev && devPanel) { devState.menuOpen = true; renderDev(); return; }
    dev = true;
    try { localStorage.setItem(DEV_FLAG, '1'); } catch { /* unlock just won't persist */ }
    if (inRun()) game.practice = true; // nothing from here on gets saved
    setupDev();
    devState.menuOpen = true;
    renderDev();
  }

  function exitDev() {
    try { localStorage.removeItem(DEV_FLAG); } catch { /* nothing stored */ }
    const q = new URLSearchParams(location.search);
    q.delete('dev');
    const rest = q.toString();
    location.search = rest ? `?${rest}` : '';
  }

  // ---------- dev tools ----------
  const devState = { god: false, debug: false, timeScale: 1, menuOpen: false };
  let devPanel = null;
  let devLive = null;

  function devGoto(i) {
    if (i >= LEVELS.length) { finishRun(); return; }
    if (!inRun()) startRun(true);
    loadLevel(Math.max(0, i));
  }

  function devDay(delta) {
    const [y, m, d] = dateKey.split('-').map(Number);
    location.search = `?dev&date=${dateKeyFor(new Date(y, m - 1, d + delta))}`;
  }

  const DEV_GROUPS = [
    ['Rooms', [
      ['◀ room', '[', () => devGoto(game.levelIdx - 1)],
      ['room ▶', ']', () => devGoto(inRun() ? game.levelIdx + 1 : 0)],
      ['restart', 'R', () => inRun() && respawn()],
      ['results', 'Y', () => inRun() && finishRun()],
    ]],
    ['Days', [
      ['◀ day', '-', () => devDay(-1)],
      ['day ▶', '=', () => devDay(1)],
      ['random', '0', () => devDay(Math.floor(Math.random() * 730) - 365)],
      ['today', '', () => { location.search = '?dev'; }],
    ]],
    ['Cheats & view', [
      ['god', 'I', () => { devState.god = !devState.god; }, () => devState.god],
      ['debug draw', 'H', () => { devState.debug = !devState.debug; }, () => devState.debug],
      ['slow-mo', 'T', () => { devState.timeScale = devState.timeScale === 1 ? 0.25 : 1; }, () => devState.timeScale !== 1],
      ['ghost', 'G', () => inRun() && toggleGhost(), () => game.ghostOn],
      ['theme ▶', 'K', () => {
        const lv = game.level;
        lv.themeOverride = THEME_KEYS[(THEME_KEYS.indexOf(themeKeyOf(lv)) + 1) % THEME_KEYS.length];
      }],
    ]],
  ];
  const DEV_ACTIONS = DEV_GROUPS.flatMap(([, items]) => items);
  const DEV_KEYS = { BracketLeft: '◀ room', BracketRight: 'room ▶', KeyY: 'results', Minus: '◀ day', Equal: 'day ▶', Digit0: 'random', KeyI: 'god', KeyH: 'debug draw', KeyT: 'slow-mo', KeyK: 'theme ▶' };

  function devKey(e) {
    if (e.code === 'Backquote') { devState.menuOpen = !devState.menuOpen; renderDev(); return; }
    const label = DEV_KEYS[e.code];
    if (!label) return;
    DEV_ACTIONS.find((a) => a[0] === label)[2]();
    renderDev();
  }

  let devFab = null;
  function setupDev() {
    if (devPanel) return;
    devFab = document.createElement('button');
    devFab.className = 'dev-fab';
    devFab.type = 'button';
    devFab.textContent = '🛠 dev';
    devFab.addEventListener('mousedown', (e) => e.preventDefault());
    devFab.addEventListener('click', () => { devState.menuOpen = !devState.menuOpen; renderDev(); });
    document.body.appendChild(devFab);
    devPanel = document.createElement('div');
    devPanel.className = 'dev';
    document.body.appendChild(devPanel);
    // Click the room to teleport there — handy for testing one jump over and over.
    canvas.addEventListener('click', (e) => {
      if (game.state !== 'playing') return;
      const r = canvas.getBoundingClientRect();
      const p = game.player;
      p.x = ((e.clientX - r.left) / r.width) * VIEW_W - p.w / 2;
      p.y = ((e.clientY - r.top) / r.height) * VIEW_H - p.h / 2;
      p.vx = p.vy = 0;
    });
    renderDev();
  }

  function renderDev() {
    if (!devPanel) return;
    devPanel.hidden = !devState.menuOpen;
    devFab.classList.toggle('on', devState.menuOpen);
    if (!devState.menuOpen) { devLive = null; return; }
    const lv = game.level;
    const b = lv.bot || {};
    const rh = lv.routeHazards || {};
    let n = 0;
    devPanel.innerHTML = `
      <div class="dev-head">${dateKey} · ${game.levelIdx === BONUS_ROOM ? 'bonus' : `room ${game.levelIdx + 1}/${LEVELS.length}`} ${lv.cfg.name} · ${themeOf(lv).name}</div>
      <div class="dev-info">bot ${formatTime(b.time || 0)} · attempt ${b.fallback ? 'FALLBACK' : b.attempt} · goal rank ${lv.goalRank ?? '-'}<br>
        route lined with ${rh.spikes ?? 0} spikes / ${rh.saws ?? 0} saws · ${lv.saws.length} saws total</div>
      <div class="dev-live"></div>
      ${DEV_GROUPS.map(([title, items]) => `
        <div class="dev-group">${title}</div>
        <div class="dev-btns">${items.map(([label, key, , isOn]) =>
          `<button data-i="${n++}" class="${isOn && isOn() ? 'on' : ''}">${label}${key ? ` <kbd>${key}</kbd>` : ''}</button>`).join('')}</div>`).join('')}
      <div class="dev-foot">
        <span>click the room to teleport · <kbd>\`</kbd> menu</span>
        <button class="dev-exit">exit dev mode</button>
      </div>`;
    devLive = devPanel.querySelector('.dev-live');
    devPanel.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      if (btn.classList.contains('dev-exit')) { btn.addEventListener('click', exitDev); return; }
      btn.addEventListener('click', () => { DEV_ACTIONS[Number(btn.dataset.i)][2](); renderDev(); });
    });
  }

  function updateDevLive() {
    if (!devLive || !game.player) return;
    const p = game.player;
    const f = (v) => Math.round(v).toString().padStart(4);
    devLive.textContent =
      `x${f(p.x)} y${f(p.y)}  vx${f(p.vx)} vy${f(p.vy)}  ` +
      `${p.onGround ? 'GROUND' : p.sliding ? 'SLIDE ' : 'AIR   '}` +
      `${p.wallLeft ? ' wallL' : ''}${p.wallRight ? ' wallR' : ''}  ` +
      `cell ${Math.floor((p.x + p.w / 2) / TILE)},${Math.floor((p.y + p.h / 2) / TILE)}`;
  }

  // The solver's full route, sampled once per room for the debug overlay.
  const traceCache = new Map();
  function routeTrace(lv) {
    if (!traceCache.has(lv)) {
      const pts = [];
      const gh = makeGhost(lv);
      for (let i = 0; !gh.done && i < 120 * 60; i++) {
        stepGhost(gh, lv);
        if (i % 2 === 0) pts.push([gh.p.x + gh.p.w / 2, gh.p.y + gh.p.h / 2]);
      }
      traceCache.set(lv, pts);
    }
    return traceCache.get(lv);
  }

  function drawDebug(lv) {
    ctx.save();
    // what the solver treats as deadly: every tile any saw's patrol can touch
    ctx.fillStyle = 'rgba(255,60,60,0.18)';
    for (let i = 0; i < lv.botMask.length; i++) {
      if (lv.botMask[i]) ctx.fillRect((i % COLS) * TILE, Math.floor(i / COLS) * TILE, TILE, TILE);
    }
    // real hitboxes
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffe066';
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const c = lv.grid[cy * COLS + cx];
        if (!isSpike(c)) continue;
        const r = spikeRect(c, cx, cy);
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      }
    }
    ctx.strokeStyle = '#ff7eb6';
    ctx.strokeRect(lv.goal.x + 0.5, lv.goal.y + 0.5, lv.goal.w - 1, lv.goal.h - 1);
    for (const sw of lv.saws) {
      const pos = sawPos(sw, game.levelClock);
      ctx.strokeStyle = '#ff4d4d';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, sw.r * 0.78, 0, Math.PI * 2);
      ctx.stroke();
    }
    // the solver's route
    const pts = routeTrace(lv);
    ctx.strokeStyle = 'rgba(120,220,255,0.8)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.setLineDash([]);
    if (game.player) {
      const p = game.player;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
    }
    ctx.restore();
  }

  // ---------- main loop ----------
  resize();
  window.addEventListener('resize', resize);

  // Online, fetch today's stored rooms first; offline (or if the server can't be
  // reached) they're generated locally, synchronously, as before.
  async function fetchToday() {
    try {
      const data = await Promise.race([
        api('GET', `/api/levels/${dateKey}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]);
      for (const r of data.rooms) today.rooms[r.room] = deserializeLevel(r.level, r.room, r.theme);
    } catch { /* fall back to generating them here */ }
  }

  // A returning player's official days from the server: refresh the streak line
  // wherever it's showing once they arrive.
  async function syncServerStreak() {
    if (!API || dev || !(player && player.token)) return;
    try {
      const me = await api('GET', '/api/players/me');
      if (!Array.isArray(me.days)) return;
      serverDays = me.days.filter((d) => validDateKey(d) === d);
      const line = streakLine();
      if (!line || (game.state !== 'title' && game.state !== 'results') || overlay.hidden) return;
      // update (or add) just the streak line — redrawing the screen could eat a click
      let el = overlay.querySelector('p.streak');
      const sub = overlay.querySelector('.sub');
      if (!el && sub) {
        el = document.createElement('p');
        el.className = 'streak';
        sub.insertAdjacentElement('afterend', el);
      }
      if (el) el.textContent = line;
      const share = overlay.querySelector('pre.share');
      if (share && game.state === 'results' && game.shownResult) share.textContent = shareText(game.shownResult);
    } catch { /* offline: the browser's own days will do */ }
  }

  function finishBoot() {
    syncServerStreak();
    const existing = dev ? null : loadResult(); // dev always starts at the title
    game.level = roomAt(0); // backdrop behind the menu
    game.player = makePlayer(game.level.spawn);
    if (existing) {
      game.state = 'results';
      showResults(existing, false);
    } else {
      showTitle();
    }
    if (dev) {
      setupDev(); // menu starts closed; 🛠 or ` opens it
      // Dev URL shortcuts: &theme=cloudSea forces a theme on every room, &room=2
      // skips the title and drops you straight into that room (as a practice run).
      const forcedTheme = params.get('theme');
      if (THEMES[forcedTheme]) LEVELS.forEach((_, i) => { roomAt(i).themeOverride = forcedTheme; });
      const startRoom = Number(params.get('room'));
      if (startRoom >= 1 && startRoom <= LEVELS.length) devGoto(startRoom - 1);
      if (startRoom === BONUS_ROOM + 1) { startRun(true); loadLevel(BONUS_ROOM); } // &room=4: the bonus room
      if (params.has('past') && API) { game.arcReturn = 'title'; showArchive(); } // &past opens the archive
    }
  }

  let last = performance.now();
  let acc = 0;
  function frame(now) {
    pollPad();
    const elapsed = Math.min(0.1, (now - last) / 1000) * devState.timeScale * assist;
    acc += elapsed;
    artT += elapsed;
    last = now;
    while (acc >= DT) {
      update(DT);
      acc -= DT;
    }
    render();
    cardTick();
    syncTouch();
    syncTip();
    if (dev) updateDevLive();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  if (API) {
    overlay.hidden = false;
    overlay.innerHTML = '<p class="hint">loading today\u2019s rooms…</p>';
    fetchToday().then(finishBoot);
  } else {
    finishBoot();
  }
}

// Room times are short, so they get hundredths: 2.41s.
function formatRoomTime(t) {
  return `${t.toFixed(2)}s`;
}

function formatTime(t) {
  const tenths = Math.round(t * 10); // round first so 59.97s shows as 1:00.0, not 0:60.0
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// Accepts only real calendar dates like 2026-10-12 (rejects 2026-13-45).
function validDateKey(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return null;
  const [y, m, d] = str.split('-').map(Number);
  return dateKeyFor(new Date(y, m - 1, d)) === str ? str : null;
}

if (typeof document !== 'undefined') {
  boot();
}
if (typeof module !== 'undefined') {
  module.exports = {
    LEVELS, TILE, COLS, ROWS, EMPTY, SOLID, SPIKE_UP, SPIKE_DOWN, SPIKE_RIGHT, SPIKE_LEFT,
    PHYS, CHUNK_T,
    generateLevel, buildRoom, fallbackRoom, levelSeed, themesForDay, serializeLevel, deserializeLevel, GENERATOR_VERSION, difficultyScore, levelDifficulty, DIFFICULTY_CUTS, buildBotMask, DIFFICULTY_LABELS, inputMask, encodeReplay, decodeReplay, verifyReplay, MAX_REPLAY_STEPS, DT, placeKey, turnsOf, toleranceOf, placeShard, runChunks, THEMES, THEME_KEYS, solveRoom, makeGhost, stepGhost, traceRoute, ghostTimeOf, rankFor, RANKS, asciiWord, mulberry32,
    makePlayer, stepPlayer, hitsHazard, SWITCH_A, SWITCH_B, isSwitch, BELT_L, BELT_R, isBelt, switchLandings, tutorialLevel, clawdRects, CLAWD_COLORS, GHOST_COLORS, CLAWD_UNIT, CLAWD_W, CLAWD_H, hitsSpikes, reachedGoal, cellAt,
    hashString, dateKeyFor, dayNumberFor, shiftDateKey, streakFrom, TWISTS, twistForDay, physFor, BONUS, BONUS_ROOM, cfgFor, bonusTheme, formatTime, formatRoomTime, validDateKey,
  };
}
