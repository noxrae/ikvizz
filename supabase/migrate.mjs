// Apply the full Supabase schema (base + AETHER tables + auth trigger) to the
// Postgres given by SUPABASE_DB_URL. Every file is safe to re-run.
// Run with: node --env-file=.env supabase/migrate.mjs
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DB_URL;
if (!url) { console.error('SUPABASE_DB_URL missing in .env'); process.exit(1); }

const FILES = ['./schema.sql', './schema2-aether.sql', './schema3-auth.sql'];
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });

try {
  await client.connect();
  for (const f of FILES) {
    const res = await client.query(readFileSync(new URL(f, import.meta.url), 'utf8'));
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    console.log(`${f} OK →`, last.rows?.[0]?.result || `${last.rows?.length ?? 0} rows`);
  }
  console.log('MIGRATION OK');
} catch (e) {
  console.error('MIGRATION FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
