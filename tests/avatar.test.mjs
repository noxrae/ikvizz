// Avatar creator: config saves, clamps to valid ranges, and propagates to peers.
const BASE = 'http://localhost:4321';
const results = [];
const ok = (name, cond) => results.push([name, !!cond]);

async function login(username) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'aether123' }),
  });
  return (await r.json()).token;
}
const authed = (tok, path, opts = {}) => fetch(BASE + '/api' + path, {
  method: opts.method || (opts.body ? 'POST' : 'GET'),
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
}).then(x => x.json().catch(() => ({})));

const tokA = await login('aarav');
const tokR = await login('rahul');
ok('login', tokA && tokR);

// Save a valid config.
const cfg = { skin: 3, hairColor: 2, bg: 4, face: 1, hair: 5, eyes: 2, brows: 1, mouth: 1, beard: 3, glasses: 1 };
const saved = await authed(tokA, '/me/avatar', { method: 'PATCH', body: { config: cfg } });
const savedCfg = JSON.parse(saved.user?.avatar_config || 'null');
ok('config saved & echoed', savedCfg && savedCfg.skin === 3 && savedCfg.hair === 5 && savedCfg.glasses === 1);

// Persists across a fresh /me (reload).
const meAgain = await authed(tokA, '/me');
ok('config persists on reload', JSON.parse(meAgain.user?.avatar_config || 'null')?.beard === 3);

// Out-of-range / junk indices are clamped, never stored raw.
const dirty = await authed(tokA, '/me/avatar', { method: 'PATCH', body: { config: { skin: 999, hair: -4, eyes: 'x', bogus: 7 } } });
const dc = JSON.parse(dirty.user?.avatar_config || 'null');
ok('bad indices clamped to defaults', dc && dc.skin === 0 && dc.hair === 1 && dc.eyes === 0 && dc.bogus === undefined);

// Peer sees my avatar_config in their people list.
const people = await authed(tokR, '/people');
const meFromPeer = (people.people || []).find(p => p.username === 'aarav');
ok('avatar_config reaches peers', meFromPeer && meFromPeer.avatar_config != null);

// Clearing removes it entirely.
const cleared = await authed(tokA, '/me/avatar', { method: 'PATCH', body: { config: null } });
ok('clear removes avatar_config', cleared.user && cleared.user.avatar_config == null);

let pass = 0;
for (const [name, cond] of results) { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (cond) pass++; }
console.log(`${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
