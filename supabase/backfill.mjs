// Milestone 4 — push the EXISTING local universe (chats, messages, reactions,
// votes, read markers, live moments) into Supabase, then drain the outbox.
// New writes mirror automatically; this catches up on history.
// Run with: npm run cloud:backfill   (server may keep running — the outbox is
// shared through SQLite, so both processes flushing is safe: every sync is an
// idempotent upsert keyed by locally-minted uuids.)
import { CLOUD_ENABLED, cloudBackfill, flushDrain } from '../server/cloud.js';

if (!CLOUD_ENABLED) {
  console.error('Cloud is off — set SUPABASE_DB_URL (and SUPABASE_SERVICE_KEY) in .env first.');
  process.exit(1);
}

const counts = cloudBackfill();
console.log(`Queued: ${counts.chats} chats · ${counts.messages} messages · ${counts.stories} moments (+reactions/votes/reads)`);

const r = await flushDrain();
if (r.drained) console.log('BACKFILL OK — outbox drained, your universe is mirrored.');
else {
  console.error(`Backfill incomplete: ${r.remaining} items still queued (they will keep retrying while the server runs).`);
  process.exitCode = 1;
}
process.exit();
