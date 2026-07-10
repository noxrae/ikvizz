// ============================================================================
// IKVIZZ — Avatar creator engine (Snapchat/Bitmoji-style, layered SVG).
//
// Pure, DOM-free string building so the SAME code renders an avatar in the
// browser (the creator + everywhere avatars show) AND on the server (which
// validates the config and can render a preview). The client never ships raw
// SVG to the server — only a config of integer choices, which the server
// clamps to these ranges. That makes the whole feature XSS-proof by
// construction: every pixel comes from these fixed templates, never user text.
// ============================================================================

export const AV = {
  skin:   ['#ffd9b8', '#f2c196', '#e0a878', '#c68642', '#a1663a', '#6f4423'],
  hairColor: ['#2b2b2b', '#5b3a29', '#8a5a2b', '#c99a3f', '#d9d4cc', '#b23b3b', '#5566cc', '#e07ab0'],
  bg:     ['#ffe3d0', '#d8f5e6', '#d0eeff', '#ede0ff', '#fff1c2', '#ffd6e6'],
  face:   ['round', 'oval', 'square'],
  hair:   ['none', 'short', 'buzz', 'bun', 'long', 'curly', 'flattop'],
  eyes:   ['calm', 'wide', 'happy', 'sleepy'],
  brows:  ['flat', 'raised', 'angled'],
  mouth:  ['smile', 'grin', 'neutral', 'smirk'],
  beard:  ['none', 'stubble', 'mustache', 'full'],
  glasses:['none', 'round', 'square'],
};

// Field → how many options it has (drives clamping + the UI swatch counts).
export const AV_FIELDS = Object.fromEntries(Object.entries(AV).map(([k, v]) => [k, v.length]));

/** A blank, sensible starting face. */
export const AV_DEFAULT = {
  skin: 0, hairColor: 0, bg: 2, face: 0, hair: 1,
  eyes: 0, brows: 0, mouth: 0, beard: 0, glasses: 0,
};

/** Clamp any incoming config to valid indices (server trusts this, not input). */
export function normalizeAvatar(cfg) {
  const out = { ...AV_DEFAULT };
  if (cfg && typeof cfg === 'object') {
    for (const k of Object.keys(AV_DEFAULT)) {
      const n = Number(cfg[k]);
      if (Number.isInteger(n) && n >= 0 && n < AV[k].length) out[k] = n;
    }
  }
  return out;
}

// ---- part geometry (viewBox 0 0 100 100) -----------------------------------
const darken = (hex, amt = 0.14) => {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((n >> 16) & 255) * (1 - amt)) | 0;
  const g = Math.max(0, ((n >> 8) & 255) * (1 - amt)) | 0;
  const b = Math.max(0, (n & 255) * (1 - amt)) | 0;
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
};

function faceShape(kind, skin) {
  const shade = darken(skin, 0.1);
  const ears = `<circle cx="26" cy="55" r="6" fill="${shade}"/><circle cx="74" cy="55" r="6" fill="${shade}"/>`;
  const neck = `<rect x="42" y="76" width="16" height="16" rx="6" fill="${shade}"/>`;
  if (kind === 'oval') return `${neck}${ears}<ellipse cx="50" cy="52" rx="24" ry="30" fill="${skin}"/>`;
  if (kind === 'square') return `${neck}${ears}<rect x="27" y="26" width="46" height="54" rx="16" fill="${skin}"/>`;
  return `${neck}${ears}<circle cx="50" cy="52" r="27" fill="${skin}"/>`; // round
}

function hairPart(kind, color) {
  if (kind === 'none') return '';
  const c = color;
  switch (kind) {
    case 'buzz':   return `<path d="M24 48c0-17 12-27 26-27s26 10 26 27c-6-9-16-13-26-13s-20 4-26 13Z" fill="${c}" opacity="0.9"/>`;
    case 'short':  return `<path d="M23 50c-2-20 12-32 27-32s29 12 27 32c-3-8-5-11-9-13 1 4 1 7 0 10-2-8-6-12-10-14 0 4-1 7-2 9-3-7-4-9-6-11-6 1-11 5-14 12-1-3-2-6-2-10-4 2-6 5-8 12Z" fill="${c}"/>`;
    case 'bun':    return `<circle cx="50" cy="16" r="8" fill="${c}"/><path d="M24 50c-2-19 12-31 26-31s28 12 26 31c-4-9-6-12-10-14 1-6-6-11-16-11s-17 5-16 11c-4 2-6 5-10 14Z" fill="${c}"/>`;
    case 'long':   return `<path d="M20 70c-4-10-3-22-2-30C20 22 33 14 50 14s30 8 32 26c1 8 2 20-2 30-3-24-4-30-8-34 2 10 1 22-1 30-2-22-3-28-6-32-3 22-4 28-6 40h-18c-2-12-3-18-6-40-3 4-4 10-6 32-2-8-3-20-1-30-4 4-5 10-8 34Z" fill="${c}"/>`;
    case 'curly':  return `<path d="M24 48c-6-2-8-10-3-15-4-6 1-14 8-13-1-8 8-13 15-9 4-5 13-5 17 1 8-2 15 5 12 13 6 1 9 9 4 14 5 4 3 13-4 14-4-9-6-12-10-14 0-6-8-11-18-11s-16 5-16 11c-4 2-6 5-9 14-6-1-9-9-3-13Z" fill="${c}"/>`;
    case 'flattop':return `<path d="M24 46V34c0-6 11-11 26-11s26 5 26 11v12c-6-7-16-10-26-10s-20 3-26 10Z" fill="${c}"/>`;
    default:       return '';
  }
}

function eyesPart(kind) {
  const L = 39, R = 61, y = 50;
  const white = (cx) => `<ellipse cx="${cx}" cy="${y}" rx="5" ry="6" fill="#fff"/>`;
  const pupil = (cx, r = 2.6) => `<circle cx="${cx}" cy="${y + 0.5}" r="${r}" fill="#3a2a20"/>`;
  switch (kind) {
    case 'wide':   return `${white(L)}${white(R)}${pupil(L)}${pupil(R)}`;
    case 'happy':  return `<path d="M34 51q5-6 10 0" stroke="#3a2a20" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M56 51q5-6 10 0" stroke="#3a2a20" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
    case 'sleepy': return `<path d="M34 50h10" stroke="#3a2a20" stroke-width="2.6" stroke-linecap="round"/><path d="M56 50h10" stroke="#3a2a20" stroke-width="2.6" stroke-linecap="round"/>${pupil(L, 2)}${pupil(R, 2)}`;
    default:       return `<circle cx="${L}" cy="${y}" r="3.2" fill="#3a2a20"/><circle cx="${R}" cy="${y}" r="3.2" fill="#3a2a20"/>`; // calm
  }
}

function browsPart(kind, color) {
  const c = darken(color, 0.05);
  switch (kind) {
    case 'raised': return `<path d="M33 40q6-4 12-1" stroke="${c}" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M55 39q6-3 12 1" stroke="${c}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
    case 'angled': return `<path d="M33 41l12-3" stroke="${c}" stroke-width="2.8" stroke-linecap="round"/><path d="M67 41l-12-3" stroke="${c}" stroke-width="2.8" stroke-linecap="round"/>`;
    default:       return `<path d="M33 41h12" stroke="${c}" stroke-width="2.8" stroke-linecap="round"/><path d="M55 41h12" stroke="${c}" stroke-width="2.8" stroke-linecap="round"/>`; // flat
  }
}

function mouthPart(kind) {
  switch (kind) {
    case 'grin':    return `<path d="M42 63q8 8 16 0Z" fill="#fff" stroke="#b5504f" stroke-width="1.6"/><path d="M42 63q8 8 16 0" stroke="#a33f3f" stroke-width="1.8" fill="none"/>`;
    case 'neutral': return `<path d="M43 64h14" stroke="#a33f3f" stroke-width="2.6" stroke-linecap="round"/>`;
    case 'smirk':   return `<path d="M43 64q7 4 14-2" stroke="#a33f3f" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
    default:        return `<path d="M42 63q8 6 16 0" stroke="#a33f3f" stroke-width="2.8" fill="none" stroke-linecap="round"/>`; // smile
  }
}

function beardPart(kind, color) {
  if (kind === 'none') return '';
  const c = color;
  switch (kind) {
    case 'stubble':  return `<path d="M30 58c3 12 10 20 20 20s17-8 20-20c-4 8-11 13-20 13s-16-5-20-13Z" fill="${c}" opacity="0.32"/>`;
    case 'mustache': return `<path d="M42 61q8 5 16 0-3 4-8 4-5 0-8-4Z" fill="${c}"/>`;
    case 'full':     return `<path d="M29 56c2 15 10 24 21 24s19-9 21-24c-3 7-4 10-7 12 0-4 0-7-1-9-3 6-6 9-13 9s-10-3-13-9c-1 2-1 5-1 9-3-2-4-5-7-12Z" fill="${c}"/>`;
    default:         return '';
  }
}

function glassesPart(kind) {
  if (kind === 'none') return '';
  const s = 'stroke="#2c2c34" stroke-width="2.2" fill="rgba(255,255,255,0.18)"';
  const bridge = `<path d="M45 50h10" stroke="#2c2c34" stroke-width="2.2"/>`;
  if (kind === 'square') return `<rect x="30" y="45" width="14" height="11" rx="2.5" ${s}/><rect x="56" y="45" width="14" height="11" rx="2.5" ${s}/>${bridge}`;
  return `<circle cx="39" cy="50" r="7" ${s}/><circle cx="61" cy="50" r="7" ${s}/>${bridge}`; // round
}

/**
 * Build the full avatar SVG markup from a config of choices.
 * Returns an <svg> string ready to drop into innerHTML — safe because every
 * value is drawn from the fixed palettes/templates above (no user text).
 */
export function buildAvatar(cfg, px = 0) {
  const c = normalizeAvatar(cfg);
  const skin = AV.skin[c.skin];
  const hairCol = AV.hairColor[c.hairColor];
  const bg = AV.bg[c.bg];
  const size = px ? ` width="${px}" height="${px}"` : '';
  // Long hair sits partly BEHIND the head; everything else is layered front.
  const backHair = c.hair === 4 /* long */ || c.hair === 3 /* bun */
    ? hairPart(AV.hair[c.hair], hairCol) : '';
  const frontHair = c.hair === 4 || c.hair === 3 ? '' : hairPart(AV.hair[c.hair], hairCol);
  return `<svg viewBox="0 0 100 100"${size} class="av-svg" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
    + `<rect width="100" height="100" fill="${bg}"/>`
    + backHair
    + faceShape(AV.face[c.face], skin)
    + eyesPart(AV.eyes[c.eyes])
    + browsPart(AV.brows[c.brows], hairCol)
    + mouthPart(AV.mouth[c.mouth])
    + beardPart(AV.beard[c.beard], hairCol)
    + glassesPart(AV.glasses[c.glasses])
    + frontHair
    + `</svg>`;
}
