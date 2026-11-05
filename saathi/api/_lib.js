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
const USERS = "saathi:users";
const EMAILS = "saathi:emails";
const MEDIA = "saathi:media"; // photos, payment QR codes and voice notes, read one at a time
const CONVS = "saathi:convs"; // one row per chat: a ride plus one passenger
const msgKind = (conv) => "saathi:msg:" + conv; // messages of one chat
const LOCS = "saathi:loc"; // latest live location per ride, only while the driver shares it
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
  if (!id) return null;
  if (BACKEND === "redis") { const [raw] = await redis([["HGET", kind, id]]); return raw ? JSON.parse(raw) : null; }
  const { rows } = await sql("SELECT data FROM saathi.items WHERE kind = $1 AND id = $2", [kind, id]);
  return rows[0] ? rows[0].data : null;
}
async function put(kind, id, obj) {
  if (BACKEND === "redis") { await redis([["HSET", kind, id, JSON.stringify(obj)]]); return; }
  await sql("INSERT INTO saathi.items (kind, id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()", [kind, id, JSON.stringify(obj)]);
}
// Insert only when the id is free (used for one account per email). Returns true if inserted.
async function putNew(kind, id, obj) {
  if (BACKEND === "redis") { const [n] = await redis([["HSETNX", kind, id, JSON.stringify(obj)]]); return n === 1; }
  const r = await sql("INSERT INTO saathi.items (kind, id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (kind, id) DO NOTHING", [kind, id, JSON.stringify(obj)]);
  return r.rowCount === 1;
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
  const [rides, bookings, users] = await Promise.all([all(RIDES), all(BOOKINGS), all(USERS)]);
  return { rides, bookings, users };
}

/* ---------- accounts and sessions ---------- */
const SECRET = process.env.SESSION_SECRET || process.env.SUPABASE_JWT_SECRET ||
  crypto.createHash("sha256").update("saathi:" + (PG_URL || KV_TOKEN || "dev")).digest("hex");
const COOKIE = "saathi_session";
const SESSION_DAYS = 30;
const b64u = (s) => Buffer.from(s).toString("base64url");
function signSession(userId, ver) {
  const body = b64u(JSON.stringify({ u: userId, v: ver || 1, e: Date.now() + SESSION_DAYS * 86400000 }));
  const mac = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + mac;
}
function readSession(req) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)saathi_session=([^;]+)/);
  if (!m) return null;
  const [body, mac] = m[1].split(".");
  if (!body || !mac) return null;
  const want = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  try { const s = JSON.parse(Buffer.from(body, "base64url").toString()); return s.e > Date.now() ? s : null; } catch (_) { return null; }
}
function setSession(res, user) {
  res.setHeader("Set-Cookie", COOKIE + "=" + signSession(user.id, user.ver) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + SESSION_DAYS * 86400);
}
function clearSession(res) {
  res.setHeader("Set-Cookie", COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
}
async function currentUser(req) {
  const s = readSession(req);
  if (!s) return null;
  const u = await get(USERS, s.u);
  return u && (u.ver || 1) === s.v ? u : null;
}
function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return { salt, hash };
}
function checkPassword(pw, user) {
  const { hash } = hashPassword(pw, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
}
const mediaUrl = (id) => (id ? "/api/media?id=" + id : "");
// Only ever sent to the user themself.
const publicUser = (u) => u && {
  id: u.id, name: u.name, email: u.email, phone: u.phone || "", gender: u.gender || "", bio: u.bio || "", createdAt: u.createdAt,
  photo: mediaUrl(u.photo), qr: mediaUrl(u.qr), qrId: u.qr || "", altName: u.altName || "", altPhone: u.altPhone || "",
};

/* ---------- uploaded files (sent as data: URLs inside JSON) ---------- */
const MAGIC = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/webp": (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
  "audio/webm": (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  "audio/ogg": (b) => b.toString("latin1", 0, 4) === "OggS",
  "audio/mp4": (b) => b.toString("latin1", 4, 8) === "ftyp",
  "audio/x-m4a": (b) => b.toString("latin1", 4, 8) === "ftyp",
  "audio/aac": (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0,
  "audio/mpeg": (b) => b.toString("latin1", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
};
// Returns [{mime, b64, size}, null] or [null, reason]. Checks the real file signature, not just the label.
function parseDataUrl(v, prefix, maxBytes) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+)((?:;[a-z0-9-]+=[^;,]*)*);base64,([A-Za-z0-9+/]+=*)$/i.exec(typeof v === "string" ? v : "");
  if (!m) return [null, "bad"];
  const mime = m[1].toLowerCase();
  const check = MAGIC[mime];
  if (!mime.startsWith(prefix) || !check) return [null, "type"];
  if (m[3].length * 0.75 > maxBytes + 4) return [null, "size"];
  const buf = Buffer.from(m[3], "base64");
  if (buf.length < 12 || !check(buf)) return [null, "type"];
  return [{ mime, b64: m[3], size: buf.length }, null];
}
// Indian mobile numbers: keep 10 digits, stored as +91XXXXXXXXXX.
function normPhone(v) {
  const d = String(v || "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(d) ? "+91" + d : null;
}
const normEmail = (v) => { const e = String(v || "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 120 ? e : null; };

/* ---------- email (free Brevo plan: its HTTP API key, or any SMTP login) ---------- */
const MAIL_KEY = process.env.BREVO_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "";
const MAIL_NAME = process.env.MAIL_FROM_NAME || "Saathi";
const MAIL_API = process.env.BREVO_API_URL || "https://api.brevo.com/v3/smtp/email";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || process.env.SMTP_KEY || "";
const SMTP_HOST = process.env.SMTP_HOST || "smtp-relay.brevo.com";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const MAIL_VIA = MAIL_KEY ? "api" : SMTP_USER && SMTP_PASS ? "smtp" : null;
const mailOn = () => !!(MAIL_VIA && MAIL_FROM);
let transport = null;
function smtp() {
  if (!transport) {
    transport = require("nodemailer").createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 6000, greetingTimeout: 6000, socketTimeout: 8000,
    });
  }
  return transport;
}
const escH = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function sendMail(to, subject, lines, link) {
  if (!mailOn() || !to) return false;
  // A line is plain text, or {text, url} for a link.
  const text = lines.map((l) => (typeof l === "string" ? l : l.text + ": " + l.url)).join("\n\n") + (link ? "\n\nOpen Saathi: " + link.url : "");
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0f1a14;max-width:520px">' +
    '<p style="font-size:20px;font-weight:700;color:#0b7a4b;margin:0 0 16px">saathi</p>' +
    lines.map((l) => (typeof l === "string" ? "<p>" + escH(l) + "</p>" : '<p><a href="' + escH(l.url) + '" style="color:#0b7a4b;font-weight:600">' + escH(l.text) + "</a></p>")).join("") +
    (link ? '<p><a href="' + escH(link.url) + '" style="display:inline-block;background:#0b7a4b;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700">' + escH(link.label) + "</a></p>" : "") +
    '<p style="color:#56675e;font-size:13px">You get these emails because you use Saathi.</p></div>';
  try {
    if (MAIL_VIA === "smtp") {
      let timer;
      const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), 9000); });
      await Promise.race([smtp().sendMail({ from: { name: MAIL_NAME, address: MAIL_FROM }, to, subject, text, html }), limit]).finally(() => clearTimeout(timer));
      return true;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(MAIL_API, {
      method: "POST", signal: ctl.signal,
      headers: { "api-key": MAIL_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { email: MAIL_FROM, name: MAIL_NAME }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
    });
    clearTimeout(t);
    return r.ok;
  } catch (_) { return false; }
}
function siteUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = req.headers["x-forwarded-proto"] || (/^localhost|^127\./.test(host) ? "http" : "https");
  return host ? proto + "://" + host : "";
}

/* ---------- places ---------- */
function kmBetween(a, b) {
  const R = 6371, r = (x) => (x * Math.PI) / 180;
  const dLa = r(b[0] - a[0]), dLo = r(b[1] - a[1]);
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const ridePt = (r, end) => (Number.isFinite(r[end + "Lat"]) && Number.isFinite(r[end + "Lon"]) ? [r[end + "Lat"], r[end + "Lon"]] : null);
const placeHead = (s) => String(s || "").split(",")[0].trim().toLowerCase();
// Same place: within 25 km when both have coordinates, otherwise the same first part of the name.
function samePlace(a, b, end) {
  const pa = ridePt(a, end), pb = ridePt(b, end);
  if (pa && pb) return kmBetween(pa, pb) <= 25;
  return placeHead(a[end]) === placeHead(b[end]);
}

/* ---------- request helpers ---------- */
const str = (v, n) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, n) : "");
const text = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const int = (v) => { if (v === null || v === undefined || v === "") return NaN; const n = Number(v); return Number.isFinite(n) && Math.round(n) === n ? n : NaN; };
const newId = () => crypto.randomBytes(9).toString("hex");
const utcDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const queryId = (req) => String((req.query && req.query.id) || new URL(req.url, "http://x").searchParams.get("id") || "").slice(0, 64);
const queryParam = (req, k) => String((req.query && req.query[k]) || new URL(req.url, "http://x").searchParams.get(k) || "");

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
const fail = (res, code, error, message) => send(res, code, { error, message });

// Returns the parsed JSON body, or {_tooLarge: true} when it's over the limit.
async function readBody(req, limit) {
  limit = limit || 100000;
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { if (req.body.length > limit) return { _tooLarge: true }; try { return JSON.parse(req.body); } catch (_) { return {}; } }
  return new Promise((resolve) => {
    const parts = []; let n = 0, big = false;
    req.on("data", (c) => { n += c.length; if (n > limit) big = true; else parts.push(c); });
    req.on("end", () => { if (big) return resolve({ _tooLarge: true }); try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); } catch (_) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}
// Writes must be JSON: a plain cross-site form can't send that, which blocks forged requests.
function jsonOnly(req, res) {
  if (/application\/json/i.test(String(req.headers["content-type"] || ""))) return true;
  fail(res, 415, "json_only", "Send this as JSON.");
  return false;
}
// Guard used by every write route: storage connected, JSON body, signed in.
async function requireUser(req, res) {
  if (!hasStore()) { fail(res, 503, "no_store", "Saathi isn't connected to its database yet."); return null; }
  // Only POST can come from a plain cross-site form; PATCH and DELETE need a CORS preflight.
  if (req.method === "POST" && !jsonOnly(req, res)) return null;
  const u = await currentUser(req);
  if (!u) { fail(res, 401, "signed_out", "Log in to do this."); return null; }
  return u;
}

module.exports = {
  RIDES, BOOKINGS, USERS, EMAILS, MEDIA, CONVS, LOCS, msgKind, kmBetween, samePlace, MAX_RIDES, BACKEND, hasStore, all, get, put, putNew, del, count, loadAll,
  setSession, clearSession, currentUser, hashPassword, checkPassword, publicUser, mediaUrl, parseDataUrl, normPhone, normEmail,
  mailOn, sendMail, siteUrl, str, text, int, newId, utcDay, queryId, queryParam, send, fail, readBody, jsonOnly, requireUser,
};
