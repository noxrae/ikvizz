// ============================================================================
// IKVIZZ — entrypoint. Express serves the SPA + REST API; Socket.IO rides the
// same HTTP server. Local-first: one process, one SQLite file. On ephemeral
// hosts (Render free) the file is restored from — and snapshotted back to —
// Supabase Storage, so data survives redeploys and sleep.
// ============================================================================
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreIfMissing, startSnapshots } from './persist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const PORT = process.env.PORT || 4321;

// CRITICAL ORDER: pull the latest snapshot down BEFORE any module opens SQLite.
// (db.js opens the file at import time, so these imports must come afterward.)
await restoreIfMissing(DATA_DIR);

const { api } = await import('./routes.js');
const { createSocketLayer } = await import('./sockets.js');
const { startCloud } = await import('./cloud.js');
const { fileGate } = await import('./auth.js');
const { db } = await import('./db.js');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' })); // media uploads travel as base64 JSON
app.use('/api', api);
// Uploaded media: gated to signed-in users (via the session cookie, since
// <img>/<audio> can't send a bearer token), never sniffed into executable
// content, and non-media is forced to download rather than render on our origin.
app.use('/files', fileGate, (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=2592000');
  if (!/\.(png|jpe?g|gif|webp|mp3|m4a|ogg|wav|mp4|webm|mov)$/i.test(req.path)) {
    res.setHeader('Content-Disposition', 'attachment');
  }
  next();
}, express.static(path.join(__dirname, '..', 'data', 'uploads'), { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA fallback — every non-API route renders the app shell
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const server = http.createServer(app);
createSocketLayer(server);

server.listen(PORT, () => {
  console.log(`
  ─────────────────────────────────────────────
   IKVIZZ  ·  understanding, not messages
   http://localhost:${PORT}
  ─────────────────────────────────────────────`);
  startCloud();               // Milestone 4: optional Postgres mirror (no-op if unconfigured)
  startSnapshots(db, DATA_DIR); // durable persistence: snapshot data → Supabase Storage
});
