// GET    /api/track?ride=...   where the driver is now (the driver and riders with a confirmed seat only)
// POST   /api/track {rideId, lat, lon, acc, heading, speed}   the driver shares their location
// DELETE /api/track?ride=...   the driver stops sharing
// Only the latest point is kept, never a history, and it's hidden as soon as sharing stops.
const L = require("./_lib");

const LIVE_MS = 10 * 60000; // a point older than this counts as "not sharing"
const NOTIFY_GAP_MS = 6 * 3600000; // one "on the way" email per trip

async function access(user, rideId) {
  const ride = await L.get(L.RIDES, rideId);
  if (!ride) return null;
  if (ride.driverUid === user.id) return { ride, role: "driver" };
  const bookings = await L.all(L.BOOKINGS);
  return bookings.some((b) => b.rideId === rideId && b.uid === user.id && b.status === "confirmed") ? { ride, role: "passenger" } : null;
}
const num = (v, min, max) => { const n = Number(v); return v !== null && v !== "" && Number.isFinite(n) && n >= min && n <= max ? n : null; };

module.exports = async (req, res) => {
  const user = await L.requireUser(req, res).catch(() => { L.fail(res, 502, "store_unreachable", "Couldn't reach the server just now."); return null; });
  if (!user) return;
  try {
    if (req.method === "GET") {
      const rideId = L.queryParam(req, "ride").slice(0, 64);
      const a = await access(user, rideId);
      if (!a) return L.fail(res, 404, "not_found", "Live tracking is for the driver and riders with a confirmed seat.");
      const loc = await L.get(L.LOCS, rideId);
      const now = Date.now();
      const sharing = !!loc && loc.active && now - loc.at < LIVE_MS && a.ride.status === "open";
      return L.send(res, 200, {
        role: a.role, status: a.ride.status, sharing,
        loc: sharing ? { lat: loc.lat, lon: loc.lon, acc: loc.acc, heading: loc.heading, speed: loc.speed, age: now - loc.at } : null,
      });
    }

    if (req.method === "POST") {
      const b = await L.readBody(req);
      const rideId = String(b.rideId || "").slice(0, 64);
      const a = await access(user, rideId);
      if (!a || a.role !== "driver") return L.fail(res, 403, "not_yours", "Only the driver can share their location for this ride.");
      if (a.ride.status !== "open") return L.fail(res, 409, "cancelled", "This ride is cancelled.");
      if (a.ride.date < L.utcDay(-1) || a.ride.date > L.utcDay(1)) return L.fail(res, 409, "not_today", "You can share your live location on the day of the ride.");
      const lat = num(b.lat, -90, 90), lon = num(b.lon, -180, 180);
      if (lat === null || lon === null) return L.fail(res, 400, "invalid", "That location couldn't be read.");
      const now = Date.now();
      const prev = await L.get(L.LOCS, rideId);
      const doc = {
        rideId, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6,
        acc: num(b.acc, 0, 100000), heading: num(b.heading, 0, 360), speed: num(b.speed, 0, 100),
        at: now, active: true, notifiedAt: prev ? prev.notifiedAt || 0 : 0,
      };
      const notify = now - doc.notifiedAt > NOTIFY_GAP_MS;
      if (notify) doc.notifiedAt = now;
      await L.put(L.LOCS, rideId, doc);
      if (notify && L.mailOn()) {
        const [bookings, users] = await Promise.all([L.all(L.BOOKINGS), L.all(L.USERS)]);
        const byId = new Map(users.map((u) => [u.id, u]));
        const r = a.ride;
        await Promise.all(bookings.filter((x) => x.rideId === rideId && x.status === "confirmed").map((x) => {
          const p = byId.get(x.uid);
          return p && L.sendMail(p.email, user.name + " is on the way: track live", [
            "Hi " + p.name + ",",
            user.name + " has started sharing their live location for your ride from " + r.from + " to " + r.to + " at " + r.time + ".",
            "Open Saathi to see where they are and how far away they are.",
          ], { url: L.siteUrl(req) + "/#track=" + rideId, label: "Track " + user.name.split(" ")[0] + " live" });
        }));
      }
      return L.send(res, 200, { ok: true });
    }

    if (req.method === "DELETE") {
      const rideId = L.queryParam(req, "ride").slice(0, 64);
      const a = await access(user, rideId);
      if (!a || a.role !== "driver") return L.fail(res, 403, "not_yours", "Only the driver can stop sharing.");
      const loc = await L.get(L.LOCS, rideId);
      if (loc) { loc.active = false; delete loc.lat; delete loc.lon; await L.put(L.LOCS, rideId, loc); }
      return L.send(res, 200, { ok: true });
    }
    return L.fail(res, 405, "method", "Use GET, POST or DELETE.");
  } catch (e) {
    return L.fail(res, 502, "store_unreachable", "Couldn't reach the server just now. Check your connection and try again.");
  }
};
