// Shared helpers for the Saathi API. Files starting with "_" are not routes on Vercel.
const crypto = require("crypto");

const STORE_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const STORE_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const RIDES = "saathi:rides";
const BOOKINGS = "saathi:bookings";
const MAX_RIDES = 2000;

const hasStore = () => !!(STORE_URL && STORE_TOKEN);

// Upstash Redis REST pipeline: an array of commands in, an array of results out.
async function redis(cmds) {
  const r = await fetch(STORE_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + STORE_TOKEN, "Content-Type": "application/json" },
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

async function loadAll() {
  const [r, b] = await redis([["HGETALL", RIDES], ["HGETALL", BOOKINGS]]);
  return { rides: parsePairs(r), bookings: parsePairs(b) };
}

// Each browser keeps a random key; the server only ever stores a hash of it.
function uidFrom(req) {
  const k = String(req.headers["x-saathi-key"] || "");
  if (!/^[A-Za-z0-9-]{20,80}$/.test(k)) return null;
  return crypto.createHash("sha256").update(k).digest("hex").slice(0, 24);
}

const str = (v, n) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, n) : "");
const text = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const int = (v) => { const n = Number(v); return Number.isFinite(n) && Math.round(n) === n ? n : NaN; };
const newId = () => crypto.randomBytes(9).toString("hex");

function utcDay(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

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

module.exports = { RIDES, BOOKINGS, MAX_RIDES, hasStore, redis, loadAll, uidFrom, str, text, int, newId, utcDay, send, fail, readBody, guard };
