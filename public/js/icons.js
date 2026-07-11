/* ============================================================================
   IKVIZZ icon system — hand-drawn, stroke-based, 24×24 grid.
   One visual voice across the whole product: 1.8px strokes, round caps,
   currentColor. No OS emojis in the chrome — these are ours.
   ============================================================================ */

export const ICONS = {
  // ---- brand ----------------------------------------------------------------
  aether: `<path d="M12 3.2 20.2 20H3.8L12 3.2Z"/><path d="M7.4 14.2h9.2"/>`,

  // ---- worlds & navigation ----------------------------------------------------
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>`,
  orbit: `<circle cx="12" cy="12" r="3.1"/><ellipse cx="12" cy="12" rx="9.2" ry="4.4" transform="rotate(-22 12 12)"/><circle cx="18.6" cy="7.6" r="1.3" fill="currentColor" stroke="none"/>`,
  rocket: `<path d="M12 2.8c3.2 1.7 4.8 4.8 4.8 8.3l-2.9 2.9h-3.8L7.2 11c0-3.5 1.6-6.5 4.8-8.2Z"/><circle cx="12" cy="8.7" r="1.6"/><path d="M8.2 12.6 5.7 15c-.6 1.7-.7 3.3-.7 3.3s1.6-.1 3.3-.7l2.4-2.4"/><path d="M15.8 12.6l2.5 2.4c.6 1.7.7 3.3.7 3.3s-1.6-.1-3.3-.7l-2.4-2.4"/><path d="M12 17v4"/>`,
  db: `<ellipse cx="12" cy="5.6" rx="7.4" ry="2.9"/><path d="M4.6 5.6v12.8c0 1.6 3.3 2.9 7.4 2.9s7.4-1.3 7.4-2.9V5.6"/><path d="M4.6 12c0 1.6 3.3 2.9 7.4 2.9s7.4-1.3 7.4-2.9"/>`,
  planet: `<circle cx="12" cy="12" r="5"/><ellipse cx="12" cy="12" rx="10" ry="3.2" transform="rotate(-18 12 12)"/>`,
  home: `<path d="m4 11 8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5.4h4V20"/>`,
  star4: `<path d="M12 3c.8 4.4 2 6.4 6.6 7.2-4.6.8-5.8 2.8-6.6 7.2-.8-4.4-2-6.4-6.6-7.2C10 9.4 11.2 7.4 12 3Z"/>`,
  grad: `<path d="M2.5 9.5 12 5l9.5 4.5L12 14 2.5 9.5Z"/><path d="M6.6 11.6v4c0 1.3 2.4 2.6 5.4 2.6s5.4-1.3 5.4-2.6v-4"/><path d="M21 10.2v4.8"/>`,

  // ---- actions ------------------------------------------------------------------
  search: `<circle cx="11" cy="11" r="6.5"/><path d="m16.2 16.2 4.8 4.8"/>`,
  plus: `<path d="M12 5.5v13M5.5 12h13"/>`,
  send: `<path d="M20.5 3.5 11 13"/><path d="M20.5 3.5 14 20.5l-3-7.5-7.5-3 17-6.5Z"/>`,
  paperclip: `<path d="m19.8 11.7-7.6 7.6a4.9 4.9 0 0 1-6.9-6.9l8.2-8.2a3.3 3.3 0 0 1 4.6 4.6l-8 8a1.6 1.6 0 0 1-2.3-2.3l7.2-7.2"/>`,
  lock: `<rect x="5.2" y="10.8" width="13.6" height="9.4" rx="2.4"/><path d="M8.6 10.8V7.9a3.4 3.4 0 0 1 6.8 0v2.9"/><circle cx="12" cy="15.4" r="1.2" fill="currentColor" stroke="none"/>`,
  unlock: `<rect x="5.2" y="10.8" width="13.6" height="9.4" rx="2.4"/><path d="M8.6 10.8V7.9A3.4 3.4 0 0 1 15.2 7"/><circle cx="12" cy="15.4" r="1.2" fill="currentColor" stroke="none"/>`,
  sparkle: `<path d="M11 4.5c.6 3.3 1.6 4.8 5 5.4-3.4.6-4.4 2.1-5 5.4-.6-3.3-1.6-4.8-5-5.4 3.4-.6 4.4-2.1 5-5.4Z"/><path d="M18 13.5c.3 1.9.9 2.7 2.9 3.1-2 .4-2.6 1.2-2.9 3.1-.3-1.9-.9-2.7-2.9-3.1 2-.4 2.6-1.2 2.9-3.1Z"/>`,
  star: `<path d="m12 3.6 2.5 5.2 5.8.8-4.2 4 1 5.7L12 16.6l-5.1 2.7 1-5.7-4.2-4 5.8-.8L12 3.6Z"/>`,
  check: `<path d="m4.5 12.5 5 5L19.5 7"/>`,
  checkCircle: `<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.4 2.6 2.6 5-5.5"/>`,
  x: `<path d="M6 6l12 12M18 6 6 18"/>`,
  chevLeft: `<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>`,
  trash: `<path d="M4.5 6.5h15M9.5 6V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3V6"/><path d="m6.5 6.5.8 12.4a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12.4"/><path d="M10 10.5v6.5M14 10.5v6.5"/>`,
  logout: `<path d="M9.5 4H6.6A2.6 2.6 0 0 0 4 6.6v10.8A2.6 2.6 0 0 0 6.6 20h2.9"/><path d="m15 8 4 4-4 4M19 12H9.5"/>`,
  theme: `<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none"/>`,
  link: `<path d="m9.6 14.4 4.8-4.8"/><path d="m11.2 6.6 1.7-1.7a4 4 0 0 1 5.7 5.7l-1.8 1.7"/><path d="m12.8 17.4-1.7 1.7a4 4 0 0 1-5.7-5.7l1.8-1.7"/>`,
  pen: `<path d="m4 20 1-4L16.4 4.6a2.1 2.1 0 0 1 3 3L8 19l-4 1Z"/><path d="m14.4 6.6 3 3"/>`,
  mic: `<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/>`,
  stop: `<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>`,
  dots: `<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>`,
  reply: `<path d="M9.5 7 4.5 12l5 5"/><path d="M4.5 12h8.5a6.5 6.5 0 0 1 6.5 6.5v.5"/>`,
  forward: `<path d="m14.5 7 5 5-5 5"/><path d="M19.5 12H11a6.5 6.5 0 0 0-6.5 6.5v.5"/>`,
  call: `<path d="M6.6 3.5c.6 0 1.2.4 1.4 1l1 3c.2.5 0 1.1-.4 1.5l-1.4 1.3a12.2 12.2 0 0 0 6.5 6.5l1.3-1.4c.4-.4 1-.6 1.5-.4l3 1c.6.2 1 .8 1 1.4v2.2c0 .9-.7 1.6-1.6 1.5C10.4 20.5 3.5 13.6 3 5.1c-.1-.9.6-1.6 1.5-1.6h2.1Z"/>`,
  video: `<rect x="3" y="6.5" width="12.5" height="11" rx="2.4"/><path d="m15.5 10.6 5-3.1v9l-5-3.1"/>`,
  videoOff: `<rect x="3" y="6.5" width="12.5" height="11" rx="2.4"/><path d="m15.5 10.6 5-3.1v9l-5-3.1"/><path d="m4 4 16 16"/>`,
  micOff: `<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/><path d="m4.5 3.5 15 17"/>`,
  screen: `<rect x="3" y="4.5" width="18" height="12.5" rx="2.2"/><path d="M9 20.5h6M12 17v3.5"/>`,
  copy: `<rect x="9" y="9" width="11.5" height="11.5" rx="2"/><path d="M6 15H4.9A1.9 1.9 0 0 1 3 13.1V4.9C3 3.9 3.9 3 4.9 3h8.2C14.1 3 15 3.9 15 4.9V6"/>`,
  camera: `<path d="M4 8.6c0-1.1.9-2 2-2h1.5l1.3-2.1h6.4l1.3 2.1H18a2 2 0 0 1 2 2v8.9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8.6Z"/><circle cx="12" cy="12.8" r="3.3"/>`,
  chevDown: `<path d="m5.5 9.5 6.5 6.5 6.5-6.5"/>`,
  battery: `<rect x="3" y="8" width="15.5" height="8" rx="2.2"/><path d="M21 10.5v3M6 10.8v2.4"/>`,
  phone: `<rect x="7" y="3" width="10" height="18" rx="2.6"/><path d="M10.5 17.8h3"/>`,
  zap: `<path d="M13 2.5 4.5 13.5h6L9 21.5 19.5 10h-6l-.5-7.5Z"/>`,
  mappin: `<path d="M12 21s7-6.4 7-12A7 7 0 0 0 5 9c0 5.6 7 12 7 12Z"/><circle cx="12" cy="9.2" r="2.6"/>`,
  eye: `<path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12Z"/><circle cx="12" cy="12" r="3"/>`,
  eyeOff: `<path d="M4.5 6.2C3.1 7.6 2.6 9 2.6 9S6 15.2 12 15.2c1.4 0 2.6-.3 3.7-.8M9.3 5.1c.9-.2 1.8-.3 2.7-.3 6 0 9.4 6.2 9.4 6.2s-.9 1.6-2.5 3"/><path d="M10 10a2.8 2.8 0 0 0 3.9 3.9"/><path d="m4 4 16 16"/>`,
  download: `<path d="M12 4v10"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>`,
  share: `<path d="M12 15V4"/><path d="m8 7.5 4-4 4 4"/><path d="M6 12H5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-1"/>`,
  play: `<path fill="currentColor" stroke="none" d="M8 5.4c0-.8.9-1.3 1.5-.8l10 6.6c.6.4.6 1.2 0 1.6l-10 6.6c-.7.4-1.5 0-1.5-.8z"/>`,
  pause: `<path fill="currentColor" stroke="none" d="M8 5h2.6v14H8zM13.4 5H16v14h-2.6z"/>`,
  bell: `<path d="M12 3.5a5.8 5.8 0 0 1 5.8 5.8c0 4 1 5.3 2 6.4H4.2c1-1.1 2-2.4 2-6.4A5.8 5.8 0 0 1 12 3.5Z"/><path d="M9.8 19.2a2.3 2.3 0 0 0 4.4 0"/>`,
  pin: `<path d="M9 3.8h6l-.8 6.4 2.6 2.6c.4.4.1 1.2-.5 1.2H7.7c-.6 0-.9-.8-.5-1.2l2.6-2.6L9 3.8Z"/><path d="M12 14v6.5"/>`,
  music: `<path d="M9 18.2V6l10-2v11.6"/><circle cx="6.6" cy="18.2" r="2.4"/><circle cx="16.6" cy="15.6" r="2.4"/>`,
  pulse: `<path d="M3 12h4l2.2-5.5 3.6 10.6L15 12h6"/>`,
  crown: `<path d="M4.6 17 3.4 7.6l4.7 3.3L12 5l3.9 5.9 4.7-3.3L19.4 17H4.6Z"/><path d="M5.4 20h13.2"/>`,
  note: `<path d="M6 3.5h9.5L20 8v12.5H6V3.5Z"/><path d="M15.5 3.5V8H20"/><path d="M9 12h6M9 15.5h6"/>`,

  // ---- signals & meaning ----------------------------------------------------------
  flag: `<path d="M5.5 21V4"/><path d="M5.5 4.8h11.6l-2.3 3.4 2.3 3.4H5.5"/>`,
  bulb: `<path d="M9.2 18c-.2-1.6-1-2.6-1.9-3.6a6.1 6.1 0 1 1 9.4 0c-.9 1-1.7 2-1.9 3.6"/><path d="M9.5 21h5M9.2 18h5.6"/>`,
  help: `<circle cx="12" cy="12" r="8.5"/><path d="M9.4 9.2a2.7 2.7 0 0 1 5.3.7c0 1.8-2.7 2.2-2.7 3.8"/><circle cx="12" cy="17" r=".5" fill="currentColor" stroke="none"/>`,
  mountain: `<path d="m3 19 6.5-11 3.9 6.4L16 11l5 8H3Z"/>`,
  alert: `<path d="M12 4.2 2.9 19.5h18.2L12 4.2Z"/><path d="M12 10v4.2"/><circle cx="12" cy="16.8" r=".5" fill="currentColor" stroke="none"/>`,
  clock: `<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2.4"/>`,
  timer: `<circle cx="12" cy="13.5" r="7.6"/><path d="M12 9.8v3.7l2.4 1.5"/><path d="M9.5 2.8h5M12 2.8v3"/>`,
  message: `<path d="M20.5 11.6a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1.2-4.5a8.5 8.5 0 1 1 15.8-4.4Z"/>`,
  flame: `<path d="M12 21c-3.9 0-6.5-2.4-6.5-5.9C5.5 11.2 9 9.6 9.5 6c2.6 1.5 3.5 3.7 3.1 5.8 1.2-.4 2-1.3 2.3-2.7 2 1.7 3.6 3.9 3.6 6 0 3.5-2.6 5.9-6.5 5.9Z"/>`,
  trend: `<path d="m3.5 17 5.4-5.4 3.5 3.5 8-8.1"/><path d="M15.2 7h5.3v5.3"/>`,
  dna: `<path d="M8 3c0 4.6 8 4.4 8 9s-8 4.4-8 9"/><path d="M16 3c0 4.6-8 4.4-8 9s8 4.4 8 9"/><path d="M8.7 6.3h6.6M8.7 17.7h6.6M9.8 12h4.4"/>`,
  diamond: `<path d="M12 3.6 20.4 12 12 20.4 3.6 12 12 3.6Z"/>`,
  comet: `<path d="M13.8 5.2 3.5 15.5M10.6 8.4 5.9 13"/><path d="M17.3 8.6c.5 2.7 1.3 3.9 4 4.4-2.7.5-3.5 1.7-4 4.4-.5-2.7-1.3-3.9-4-4.4 2.7-.5 3.5-1.7 4-4.4Z"/>`,

  // ---- contexts ---------------------------------------------------------------------
  circleDot: `<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>`,
  briefcase: `<rect x="3.5" y="7.8" width="17" height="12.2" rx="2.4"/><path d="M9 7.8V6.2A2.2 2.2 0 0 1 11.2 4h1.6A2.2 2.2 0 0 1 15 6.2v1.6"/><path d="M3.5 13h17"/>`,
  calendar: `<rect x="4" y="5.5" width="16" height="15" rx="2.4"/><path d="M4 10.2h16M8.5 3.4v3.8M15.5 3.4v3.8"/>`,
  target: `<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.7"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>`,
  car: `<path d="m5.6 11.6 1.4-4C7.3 6.6 8.2 6 9.1 6h5.8c.9 0 1.8.6 2.1 1.5l1.4 4.1"/><rect x="3.6" y="11.6" width="16.8" height="5.6" rx="1.8"/><path d="M6.4 17.2v1.9M17.6 17.2v1.9"/><circle cx="7.4" cy="14.4" r=".6" fill="currentColor" stroke="none"/><circle cx="16.6" cy="14.4" r=".6" fill="currentColor" stroke="none"/>`,
  dumbbell: `<path d="M7 7.5v9M17 7.5v9M3.8 9.5v5M20.2 9.5v5M7 12h10"/>`,
  moon: `<path d="M20 14.3A8.4 8.4 0 1 1 9.7 4 6.9 6.9 0 0 0 20 14.3Z"/>`,
  compass: `<circle cx="12" cy="12" r="8.5"/><path d="m15.6 8.4-1.9 5.3-5.3 1.9 1.9-5.3 5.3-1.9Z"/>`,

  // ---- rooms of life -------------------------------------------------------------------
  pan: `<circle cx="10" cy="13.5" r="6.3"/><path d="m15.5 10.5 5-5"/><path d="M8 12.2c.5-1 1.4-1.7 2.6-1.9"/>`,
  bed: `<path d="M3 19.5V9.5"/><path d="M3 16h18v3.5"/><circle cx="7" cy="11.3" r="1.9"/><path d="M11 13.2V9.4h5.6A4.4 4.4 0 0 1 21 13.8V16"/>`,
  book: `<path d="M5 19.3A2.7 2.7 0 0 1 7.7 16.6H19V3.5H7.7A2.7 2.7 0 0 0 5 6.2v13.1Z"/><path d="M5 19.3A2.7 2.7 0 0 0 7.7 22H19v-5.4"/>`,
  shield: `<path d="M12 3 5.2 5.7v5.5c0 4.5 2.9 7.9 6.8 9.8 3.9-1.9 6.8-5.3 6.8-9.8V5.7L12 3Z"/><path d="m9.3 11.6 2 2 3.4-3.8"/>`,
  coins: `<circle cx="9" cy="9.2" r="5.6"/><path d="M15.9 7.5a5.6 5.6 0 1 1-8.3 7.4"/><path d="M9 6.8v4.8M6.6 9.2h4.8"/>`,
  heart: `<path d="M12 20.2S4.5 15.5 4.5 10a4.3 4.3 0 0 1 7.5-3 4.3 4.3 0 0 1 7.5 3c0 5.5-7.5 10.2-7.5 10.2Z"/>`,
  sprout: `<path d="M12 21.5v-7.3"/><path d="M12 14.2c0-3.6-2.5-6.1-6.2-6.1 0 3.7 2.5 6.1 6.2 6.1Z"/><path d="M12 12c0-3 2.1-5 5.7-5 0 3-2.1 5-5.7 5Z"/>`,

  // ---- garden growth stages ---------------------------------------------------------------
  seed: `<path d="M12 4.2c3.4 3 4.9 5.7 4.9 8.3a4.9 4.9 0 0 1-9.8 0c0-2.6 1.5-5.3 4.9-8.3Z"/>`,
  plant: `<path d="M8.2 14.2h7.6l-.9 6.3H9.1l-.9-6.3Z"/><path d="M12 14.2c0-3.4-2.2-5.4-5.4-5.4 0 3.3 2.2 5.4 5.4 5.4Z"/><path d="M12 14.2c0-3.4 2.2-5.4 5.4-5.4 0 3.3-2.2 5.4-5.4 5.4Z"/><path d="M12 14.2V9.6"/>`,
  tree: `<path d="M12 21.5v-5.3"/><path d="M12 16.2c-4.5 0-7.2-2.6-7.2-6.6C4.8 5.7 7.9 3 12 3s7.2 2.7 7.2 6.6c0 4-2.7 6.6-7.2 6.6Z"/><path d="m12 16.2-2.6-2.6M12 13l2.2-2.2"/>`,

  // ---- people & personas ----------------------------------------------------------------------
  user: `<circle cx="12" cy="8.2" r="3.7"/><path d="M5.2 19.8c.8-3.9 3.5-5.9 6.8-5.9s6 2 6.8 5.9"/>`,
  users: `<circle cx="9.4" cy="8.6" r="3.3"/><path d="M3.6 19.4c.7-3.4 3-5.2 5.8-5.2s5.1 1.8 5.8 5.2"/><path d="M15.3 5.8a3.3 3.3 0 0 1 0 5.6M17.2 14.6c1.9.8 3.1 2.4 3.6 4.8"/>`,
  smile: `<circle cx="12" cy="12" r="8.5"/><path d="M8.6 14c.9 1.3 2 2 3.4 2s2.5-.7 3.4-2"/><circle cx="9.2" cy="9.8" r=".5" fill="currentColor" stroke="none"/><circle cx="14.8" cy="9.8" r=".5" fill="currentColor" stroke="none"/>`,
  gamepad: `<rect x="3" y="8" width="18" height="9.6" rx="4.8"/><path d="M8.2 11v3.2M6.6 12.6h3.2"/><circle cx="15.3" cy="11.6" r=".6" fill="currentColor" stroke="none"/><circle cx="17.6" cy="13.8" r=".6" fill="currentColor" stroke="none"/>`,

  // ---- knowledge subjects -------------------------------------------------------------------------
  cpu: `<rect x="7" y="7" width="10" height="10" rx="1.8"/><rect x="10.2" y="10.2" width="3.6" height="3.6" rx=".6"/><path d="M9.5 3.5V7M14.5 3.5V7M9.5 17v3.5M14.5 17v3.5M3.5 9.5H7M3.5 14.5H7M17 9.5h3.5M17 14.5h3.5"/>`,
  chart: `<path d="M4 20h16"/><path d="M7 20v-6.5M12 20V9M17 20V4.8"/>`,
  network: `<circle cx="12" cy="5.6" r="2.3"/><circle cx="5.6" cy="17.8" r="2.3"/><circle cx="18.4" cy="17.8" r="2.3"/><path d="M10.9 7.6 6.7 15.8M13.1 7.6l4.2 8.2M7.9 17.8h8.2"/>`,
  image: `<rect x="4" y="5" width="16" height="14" rx="2.4"/><circle cx="9" cy="10" r="1.7"/><path d="m4.6 16.8 4.4-4.4 3 3 3.4-3.4 4 4"/>`,
  layers: `<path d="m12 3.6 8.4 4.3L12 12.2 3.6 7.9 12 3.6Z"/><path d="m4.6 12.2 7.4 3.8 7.4-3.8M4.6 16.2l7.4 3.8 7.4-3.8"/>`,
  sigma: `<path d="M17.3 7V4.8H6.7l5.6 7.2-5.6 7.2h10.6V17"/>`,
  limit: `<path d="M19.5 4.5v15"/><path d="M4 12h11.2M11.8 8.4 15.4 12l-3.6 3.6"/>`,
  grid: `<rect x="4" y="4" width="6.8" height="6.8" rx="1.4"/><rect x="13.2" y="4" width="6.8" height="6.8" rx="1.4"/><rect x="4" y="13.2" width="6.8" height="6.8" rx="1.4"/><rect x="13.2" y="13.2" width="6.8" height="6.8" rx="1.4"/>`,
};

/* ============================================================================
   IKVIZZ MOODS — our own emoji. Soft 3D-feel blobs with soul: radial-lit
   gradients, squishy silhouettes, hand-drawn faces. No OS emoji anywhere.
   ============================================================================ */
const FACE = 'stroke="rgba(28,20,38,.82)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" fill="none"';
const EYE = 'fill="rgba(28,20,38,.82)" stroke="none"';

const moodBlob = (id, c1, c2, face) => `
  <defs><radialGradient id="mg-${id}" cx="36%" cy="26%" r="85%">
    <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
  </radialGradient></defs>
  <path d="M32 5.5c14.8 0 25.5 8.8 26.8 20.6C60.2 38.5 52 58.5 32 58.5S3.8 38.5 5.2 26.1C6.5 14.3 17.2 5.5 32 5.5Z" fill="url(#mg-${id})"/>
  <ellipse cx="24" cy="16" rx="9" ry="5" fill="rgba(255,255,255,.35)" transform="rotate(-18 24 16)"/>
  ${face}`;

export const MOODS = {
  joy: { label: 'joy', svg: moodBlob('joy', '#FFE28A', '#F5A623', `
    <path d="M20 27q3.5-5 7 0M37 27q3.5-5 7 0" ${FACE}/>
    <path d="M20 36q12 13 24 0" ${FACE} fill="rgba(28,20,38,.82)"/>`) },
  love: { label: 'love', svg: moodBlob('love', '#FFB3C8', '#F2557E', `
    <path d="M23 22c-2.6 0-4.5 2-4.5 4.3 0 3.2 4.5 6.2 4.5 6.2s4.5-3 4.5-6.2C27.5 24 25.6 22 23 22Z" transform="translate(-4 0) scale(.9)" ${EYE}/>
    <path d="M45 22c-2.6 0-4.5 2-4.5 4.3 0 3.2 4.5 6.2 4.5 6.2s4.5-3 4.5-6.2C49.5 24 47.6 22 45 22Z" transform="translate(-3 0) scale(.9)" ${EYE}/>
    <path d="M25 42q7 6 14 0" ${FACE}/>`) },
  hyped: { label: 'hyped', svg: moodBlob('hyped', '#FFC08A', '#F57C3A', `
    <path d="M23 21l1.4 3.6L28 26l-3.6 1.4L23 31l-1.4-3.6L18 26l3.6-1.4L23 21Z" ${EYE}/>
    <path d="M43 21l1.4 3.6L48 26l-3.6 1.4L43 31l-1.4-3.6L38 26l3.6-1.4L43 21Z" ${EYE}/>
    <ellipse cx="32" cy="41" rx="6.5" ry="7.5" ${EYE}/>`) },
  jk: { label: 'jk', svg: moodBlob('jk', '#8FEBCB', '#2FBE8F', `
    <path d="M19 26h9" ${FACE}/>
    <circle cx="43" cy="26" r="3.2" ${EYE}/>
    <path d="M22 36q10 9 20 1" ${FACE}/>
    <path d="M30 39q1 6 5 6.5 3-2 1.5-7.5" fill="#F2557E" stroke="rgba(28,20,38,.5)" stroke-width="1.6"/>`) },
  unsure: { label: 'unsure', svg: moodBlob('unsure', '#D6C6FF', '#9A7BF7', `
    <circle cx="23" cy="27" r="3" ${EYE}/><circle cx="43" cy="27" r="3" ${EYE}/>
    <path d="M17.5 19q4-3 8-1.5" ${FACE}/>
    <path d="M22 39q5-4 10 0t10 0" ${FACE}/>`) },
  serious: { label: 'serious', svg: moodBlob('serious', '#AFC3E4', '#5F7BAF', `
    <path d="M19 26h8M37 26h8" ${FACE}/>
    <path d="M24 39h16" ${FACE}/>`) },
  down: { label: 'down', svg: moodBlob('down', '#9FCBFF', '#4A90E2', `
    <circle cx="23" cy="26" r="3" ${EYE}/><circle cx="43" cy="26" r="3" ${EYE}/>
    <path d="M23 42q9-8 18 0" ${FACE}/>
    <path d="M47 32q4 5 0 8-4-3 0-8Z" fill="#BFE0FF" stroke="rgba(28,20,38,.35)" stroke-width="1.4"/>`) },
  blown: { label: 'mind blown', svg: moodBlob('blown', '#E0AEFF', '#9646E8', `
    <circle cx="23" cy="26" r="5.5" fill="#fff" stroke="rgba(28,20,38,.6)" stroke-width="1.8"/>
    <circle cx="43" cy="26" r="5.5" fill="#fff" stroke="rgba(28,20,38,.6)" stroke-width="1.8"/>
    <circle cx="23" cy="26" r="2.2" ${EYE}/><circle cx="43" cy="26" r="2.2" ${EYE}/>
    <ellipse cx="33" cy="42" rx="5" ry="6" ${EYE}/>
    <path d="M12 12l2 3M52 12l-2 3" ${FACE}/>`) },
  // ── custom neon-styled popular emoji ──────────────────────────────────────
  skull: { label: 'dead 💀', svg: `
    <defs><radialGradient id="mg-skull" cx="40%" cy="28%" r="80%"><stop offset="0%" stop-color="#c9fff0"/><stop offset="100%" stop-color="#2fe0b0"/></radialGradient></defs>
    <path d="M32 6c12 0 20 8 20 19 0 6-3 10-6 13v6H18v-6c-3-3-6-7-6-13C12 14 20 6 32 6Z" fill="url(#mg-skull)" stroke="#0b3d33" stroke-width="1.5"/>
    <circle cx="23" cy="28" r="6.2" fill="#0b2b26"/><circle cx="41" cy="28" r="6.2" fill="#0b2b26"/>
    <path d="M32 34l-3 6h6l-3-6Z" fill="#0b2b26"/>
    <path d="M24 46v5M32 46v6M40 46v5" stroke="#0b3d33" stroke-width="2" stroke-linecap="round"/>
    <path d="M28 3c-2 4 1 6-1 9M38 2c2 5-2 7 0 10" stroke="#ff7b3a" stroke-width="2.4" stroke-linecap="round" fill="none"/>` },
  heartbreak: { label: 'broken 💔', svg: `
    <defs><radialGradient id="mg-hb" cx="38%" cy="26%" r="85%"><stop offset="0%" stop-color="#ffc2dd"/><stop offset="100%" stop-color="#ff2d78"/></radialGradient></defs>
    <path d="M32 54S8 40 8 22C8 13 15 8 22 8c4 0 8 2 10 6 2-4 6-6 10-6 7 0 14 5 14 14 0 18-24 32-24 32Z" fill="url(#mg-hb)" stroke="#7a0b39" stroke-width="1.5"/>
    <path d="M30 12l-5 12 9 6-7 14" fill="none" stroke="#2a0a18" stroke-width="2.6" stroke-linejoin="round"/>` },
  cry: { label: 'crying 😂', svg: moodBlob('cry', '#8FE7FF', '#2FA8E0', `
    <path d="M18 25q4 4 9 0M37 25q4 4 9 0" ${FACE}/>
    <path d="M20 37q12 12 24 0" ${FACE} fill="rgba(28,20,38,.82)"/>
    <path d="M16 28c-2 5-3 8-1 11 3-1 4-4 4-8Z" fill="#39c0ff" stroke="rgba(10,40,60,.4)" stroke-width="1.2"/>
    <path d="M48 28c2 5 3 8 1 11-3-1-4-4-4-8Z" fill="#39c0ff" stroke="rgba(10,40,60,.4)" stroke-width="1.2"/>`) },

  // ══ SYNORA VIBES — proprietary ceramic emoji, soft clay + pearl finishes ══
  // A tactile token language that exists nowhere else. Warm, matte, expressive.
  groan: { label: 'existential groan', svg: `
    <defs><radialGradient id="v-groan" cx="38%" cy="26%" r="82%"><stop offset="0%" stop-color="#fff3e6"/><stop offset="55%" stop-color="#ffd7a8"/><stop offset="100%" stop-color="#e8a765"/></radialGradient></defs>
    <path d="M32 6c14 0 23 9 23 22 0 9-4 15-4 22 0 4-3 6-6 5-3-1-5-3-8-3s-5 2-8 3c-3 1-6-1-6-5 0-7-4-13-4-22C19 15 18 6 32 6Z" fill="url(#v-groan)" stroke="rgba(120,70,20,.35)" stroke-width="1.5"/>
    <ellipse cx="23" cy="16" rx="8" ry="4" fill="rgba(255,255,255,.5)" transform="rotate(-16 23 16)"/>
    <path d="M20 28q4-3 8 0M36 28q4-3 8 0" fill="none" stroke="rgba(90,55,20,.85)" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="32" cy="44" rx="7" ry="9" fill="rgba(90,55,20,.8)"/>` },
  chrome: { label: 'meta-irony', svg: `
    <defs>
      <radialGradient id="v-chrome" cx="38%" cy="24%" r="82%"><stop offset="0%" stop-color="#fdeaf1"/><stop offset="100%" stop-color="#f2a9c4"/></radialGradient>
      <linearGradient id="v-heart" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#eaf0ff"/><stop offset="45%" stop-color="#c8b6ff"/><stop offset="100%" stop-color="#8f7bd6"/></linearGradient>
    </defs>
    <circle cx="32" cy="32" r="27" fill="url(#v-chrome)" stroke="rgba(150,60,100,.3)" stroke-width="1.5"/>
    <ellipse cx="24" cy="17" rx="8" ry="4" fill="rgba(255,255,255,.55)" transform="rotate(-16 24 17)"/>
    <path d="M22 22c-2.6 0-4.6 2.1-4.6 4.6 0 3.6 4.6 6.6 4.6 6.6s4.6-3 4.6-6.6C26.6 24.1 24.6 22 22 22Z" fill="url(#v-heart)" stroke="rgba(70,50,120,.5)" stroke-width="1"/>
    <path d="M42 22c-2.6 0-4.6 2.1-4.6 4.6 0 3.6 4.6 6.6 4.6 6.6s4.6-3 4.6-6.6C46.6 24.1 44.6 22 42 22Z" fill="url(#v-heart)" stroke="rgba(70,50,120,.5)" stroke-width="1"/>
    <path d="M24 44q8 4 16 0" fill="none" stroke="rgba(150,60,100,.7)" stroke-width="3" stroke-linecap="round"/>` },
  vibepass: { label: 'vibe check: passed', svg: `
    <defs><radialGradient id="v-vibe" cx="36%" cy="24%" r="84%"><stop offset="0%" stop-color="#eafff2"/><stop offset="55%" stop-color="#b9f5cf"/><stop offset="100%" stop-color="#79d79b"/></radialGradient></defs>
    <path d="M32 5l7 4h8l1 8 5 6-5 6-1 8h-8l-7 4-7-4h-8l-1-8-5-6 5-6 1-8h8l7-4Z" fill="url(#v-vibe)" stroke="rgba(30,110,60,.35)" stroke-width="1.5"/>
    <ellipse cx="24" cy="17" rx="8" ry="4" fill="rgba(255,255,255,.55)" transform="rotate(-16 24 17)"/>
    <path d="M22 33l7 7 14-15" fill="none" stroke="rgba(20,90,50,.9)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` },
  braincell: { label: 'shared braincell', svg: `
    <defs>
      <radialGradient id="v-p1" cx="35%" cy="30%" r="75%"><stop offset="0%" stop-color="#fff" /><stop offset="100%" stop-color="#c9b7f0"/></radialGradient>
      <radialGradient id="v-p2" cx="35%" cy="30%" r="75%"><stop offset="0%" stop-color="#fff" /><stop offset="100%" stop-color="#f2b6d2"/></radialGradient>
    </defs>
    <path d="M22 32h20" stroke="rgba(120,90,160,.55)" stroke-width="4" stroke-linecap="round"/>
    <circle cx="20" cy="32" r="13" fill="url(#v-p1)" stroke="rgba(110,80,160,.4)" stroke-width="1.3"/>
    <circle cx="44" cy="32" r="13" fill="url(#v-p2)" stroke="rgba(160,80,130,.4)" stroke-width="1.3"/>
    <ellipse cx="16" cy="27" rx="4.5" ry="2.5" fill="rgba(255,255,255,.75)"/>
    <ellipse cx="40" cy="27" rx="4.5" ry="2.5" fill="rgba(255,255,255,.75)"/>` },
  overthink: { label: 'the overthinker', svg: `
    <defs><radialGradient id="v-ot" cx="38%" cy="26%" r="82%"><stop offset="0%" stop-color="#eef2ff"/><stop offset="55%" stop-color="#c7d0f0"/><stop offset="100%" stop-color="#8f9cc9"/></radialGradient></defs>
    <circle cx="32" cy="34" r="24" fill="url(#v-ot)" stroke="rgba(70,80,120,.35)" stroke-width="1.5"/>
    <ellipse cx="24" cy="19" rx="8" ry="4" fill="rgba(255,255,255,.5)" transform="rotate(-16 24 19)"/>
    <circle cx="24" cy="34" r="3" fill="rgba(50,60,100,.85)"/><circle cx="40" cy="34" r="3" fill="rgba(50,60,100,.85)"/>
    <path d="M24 45q8 3 16 0" fill="none" stroke="rgba(70,80,120,.7)" stroke-width="2.6" stroke-linecap="round"/>
    <g stroke="rgba(70,80,120,.75)" stroke-width="2" fill="none">
      <circle cx="46" cy="12" r="5"/><path d="M46 5.5v-2M46 20.5v-2M39.5 12h-2M54.5 12h-2M41.5 7.5l-1.4-1.4M52 18l-1.4-1.4M50.5 7.5l1.4-1.4M41.5 16.5l-1.4 1.4"/>
    </g>` },
  tea: { label: 'spilling the tea', svg: `
    <defs><radialGradient id="v-tea" cx="38%" cy="26%" r="80%"><stop offset="0%" stop-color="#fffdf6"/><stop offset="100%" stop-color="#e9d9b8"/></radialGradient></defs>
    <path d="M14 32c-4 0-6 2-6 5 0 8 9 16 24 16s24-8 24-16c0-3-2-5-6-5H14Z" fill="url(#v-tea)" stroke="rgba(120,95,40,.4)" stroke-width="1.5"/>
    <path d="M50 35c6-1 9 1 9 5s-4 6-9 6" fill="none" stroke="rgba(120,95,40,.5)" stroke-width="2.4"/>
    <path d="M20 30q6 6 12 0" fill="none" stroke="rgba(120,95,40,.5)" stroke-width="2"/>
    <g stroke="rgba(180,150,90,.8)" stroke-width="2.4" stroke-linecap="round" fill="none">
      <path d="M24 20c-2-3 2-5 0-8M32 18c-2-3 2-5 0-8M40 20c-2-3 2-5 0-8"/>
    </g>` },
};

export const MOOD_KINDS = Object.keys(MOODS);

/** Render a mood blob at a given pixel size. */
export function mood(kind, size = 22, cls = '') {
  const m = MOODS[kind];
  if (!m) return icon(kind, size, cls); // fall back to line icons for legacy kinds
  return `<span class="ic mood-ic ${cls}"><svg class="i" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">${m.svg}</svg></span>`;
}

/** Standalone inline icon. `cls` lands on the wrapper for color/size control. */
export function icon(name, size = 18, cls = '') {
  const body = ICONS[name];
  if (!body) return `<span class="ic ${cls}">${name}</span>`; // legacy emoji/text fallback
  return `<span class="ic ${cls}"><svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg></span>`;
}

/** Raw <g> for embedding inside another SVG, centered on (0,0). */
export function iconInSvg(name, px = 16) {
  const body = ICONS[name];
  if (!body) return `<text dy="5" text-anchor="middle" style="font-size:${px * 0.8}px">${name}</text>`;
  const s = px / 24;
  return `<g transform="translate(${-px / 2},${-px / 2}) scale(${s})" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}

/** Curated picker sets so user-created things stay on-brand. */
export const PICKS = {
  space:   ['rocket', 'briefcase', 'book', 'heart', 'compass', 'home', 'grad', 'users'],
  persona: ['smile', 'briefcase', 'gamepad', 'book', 'heart', 'compass', 'users', 'star'],
  concept: ['cpu', 'chart', 'network', 'image', 'layers', 'sigma', 'limit', 'trend', 'grid', 'book', 'bulb', 'flame'],
};
