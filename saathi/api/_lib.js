// Shared helpers for the Saathi API. Files starting with "_" are not routes on Vercel.
// Storage works with either Upstash Redis (KV_REST_API_URL / KV_REST_API_TOKEN) or any
// Postgres, such as Supabase or Neon (POSTGRES_URL). Postgres gets its own table on first use.
const crypto = require("crypto");

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const PG_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL_NON_POOLING || "";
const BACKEND = KV_URL && KV_TOKEN ? "redis" : PG_URL ? "pg" : null;
const RIDES = "saathi:rides";
const BOOKINGS = "saathi:bookings";
const MAX_RIDES = 2000;

const hasStore = () => !!BACKEND;

/* ---------- Upstash Redis (REST) ---------- */
async function redis(cmds) {
  const r = await fetch(KV_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + KV_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("store " + r.status);
  const out = await r.json();
  return out.map((x) => {
    if (x && x.error) throw new Error(x.error);
    return x ? x.result : null;
  });
}
function parsePairs(arr) {
  const out = [];
  for (let i = 0; arr && i < arr.length; i += 2) {
    try { out.push(JSON.parse(arr[i + 1])); } catch (_) { /* skip a bad row */ }
  }
  return out;
}

/* ---------- Postgres (Supabase, Neon, any) ---------- */
// A schema of its own keeps the table out of Supabase's public REST API.
const SETUP = [
  "CREATE SCHEMA IF NOT EXISTS saathi",
  "CREATE TABLE IF NOT EXISTS saathi.items (kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (kind, id))",
  "ALTER TABLE saathi.items ENABLE ROW LEVEL SECURITY",
];
let pool = null;
let ready = null;
function getPool() {
  if (pool) return pool;
  const { Pool } = require("pg");
  const u = new URL(PG_URL);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  u.search = ""; // drop sslmode, pgbouncer and provider-specific flags; SSL is set below
  pool = new Pool({ connectionString: u.toString(), ssl: local ? false : { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 });
  pool.on("error", () => {});
  return pool;
}
async function sql(text, params) {
  const p = getPool();
  if (!ready) {
    ready = (async () => { for (const s of SETUP) await p.query(s); })();
    ready.catch(() => { ready = null; });
  }
  await ready;
  return p.query(text, params);
}

/* ---------- one interface for both ---------- */
async function all(kind) {
  if (BACKEND === "redis") { const [r] = await redis([["HGETALL", kind]]); return parsePairs(r); }
  const { rows } = await sql("SELECT data FROM saathi.items WHERE kind = $1", [kind]);
  return rows.map((r) => r.data);
}
async function get(kind, id) {
  if (BACKEND === "redis") { const [raw] = await redis([["HGET", kind, id]]); return raw ? JSON.parse(raw) : null; }
  const { rows } = await sql("SELECT data FROM saathi.items WHERE kind = $1 AND id = $2", [kind, id]);
  return rows[0] ? rows[0].data : null;
}
async function put(kind, id, obj) {
  if (BACKEND === "redis") { await redis([["HSET", kind, id, JSON.stringify(obj)]]); return; }
  await sql("INSERT INTO saathi.items (kind, id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()", [kind, id, JSON.stringify(obj)]);
}
async function del(kind, id) {
  if (BACKEND === "redis") { await redis([["HDEL", kind, id]]); return; }
  await sql("DELETE FROM saathi.items WHERE kind = $1 AND id = $2", [kind, id]);
}
async function count(kind) {
  if (BACKEND === "redis") { const [n] = await redis([["HLEN", kind]]); return Number(n) || 0; }
  const { rows } = await sql("SELECT count(*)::int AS n FROM saathi.items WHERE kind = $1", [kind]);
  return rows[0].n;
}
async function loadAll() {
  const [rides, bookings] = await Promise.all([all(RIDES), all(BOOKINGS)]);
  return { rides, bookings };
}

/* ---------- request helpers ---------- */
// Each browser keeps a random key; the server only ever stores a hash of it.
function uidFrom(req) {
  const k = String(req.headers["x-saathi-key"] || "");
  if (!/^[A-Za-z0-9-]{20,80}$/.test(k)) return null;
  return crypto.createHash("sha256").update(k).digest("hex").slice(0, 24);
}
const str = (v, n) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, n) : "");
const text = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const int = (v) => { if (v === null || v === undefined || v === "") return NaN; const n = Number(v); return Number.isFinite(n) && Math.round(n) === n ? n : NaN; };
const newId = () => crypto.randomBytes(9).toString("hex");
const utcDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const queryId = (req) => String((req.query && req.query.id) || new URL(req.url, "http://x").searchParams.get("id") || "").slice(0, 64);

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
const fail = (res, code, error, message) => send(res, code, { error, message });

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (_) { return {}; } }
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 100000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (_) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

// Guard used by every write route.
function guard(req, res) {
  if (!hasStore()) { fail(res, 503, "no_store", "Shared storage isn't connected yet."); return null; }
  const uid = uidFrom(req);
  if (!uid) { fail(res, 400, "no_key", "Your browser didn't send its Saathi key. Reload the page and try again."); return null; }
  return uid;
}

module.exports = { RIDES, BOOKINGS, MAX_RIDES, BACKEND, hasStore, all, get, put, del, count, loadAll, uidFrom, str, text, int, newId, utcDay, queryId, send, fail, readBody, guard };
