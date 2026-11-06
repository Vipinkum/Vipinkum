// GET    /api/track?ride=...    live locations for one ride. The driver gets every confirmed rider (and where
//                               the ones who share are); a confirmed rider gets the driver and their own sharing.
// GET    /api/track?share=...   a rider's trip link for their family contact: no login. Driver's details, and the
//                               driver's and the rider's live location while the ride is on.
// POST   /api/track {rideId, lat, lon, acc, heading, speed}   the driver or a confirmed rider shares their location
// DELETE /api/track?ride=...    stop sharing
// Live location only works while the ride is confirmed: the driver needs at least one confirmed rider, a rider
// needs a confirmed seat, and nothing is shown once the ride or seat is cancelled.
// Only the latest point is kept, never a history.
const L = require("./_lib");

const LIVE_MS = 10 * 60000; // a point older than this counts as "not sharing"
const NOTIFY_GAP_MS = 6 * 3600000; // one "on the way" email per trip

const pkey = (rideId, uid) => rideId + "." + uid;
const fresh = (loc, now) => !!loc && loc.active && loc.lat != null && now - loc.at < LIVE_MS;
const point = (loc, now) => ({ lat: loc.lat, lon: loc.lon, acc: loc.acc, heading: loc.heading, speed: loc.speed, age: now - loc.at });
const num = (v, min, max) => { const n = Number(v); return v !== null && v !== "" && Number.isFinite(n) && n >= min && n <= max ? n : null; };
// Rides are in India: the date and time are IST.
const startMs = (r) => Date.parse(r.date + "T" + r.time + ":00+05:30");
const tripOver = (r, now) => now > startMs(r) + (Math.max(r.roadMin || 0, 240) + 360) * 60000;

async function access(user, rideId) {
  const ride = await L.get(L.RIDES, rideId);
  if (!ride) return null;
  const confirmed = (await L.all(L.BOOKINGS)).filter((b) => b.rideId === rideId && b.status === "confirmed");
  if (ride.driverUid === user.id) return { ride, role: "driver", confirmed };
  const booking = confirmed.find((b) => b.uid === user.id);
  return booking ? { ride, role: "passenger", confirmed, booking } : null;
}

// The family contact's view of one rider's trip.
async function shared(req, res) {
  if (!L.hasStore()) return L.fail(res, 503, "no_store", "Saathi isn't connected to its database yet.");
  try {
    const bid = L.readShareToken(L.queryParam(req, "share").slice(0, 120));
    const booking = bid ? await L.get(L.BOOKINGS, bid) : null;
    const ride = booking ? await L.get(L.RIDES, booking.rideId) : null;
    if (!ride) return L.fail(res, 404, "not_found", "This trip link isn't valid.");
    const now = Date.now();
    const [p, d] = await Promise.all([L.get(L.USERS, booking.uid), L.get(L.USERS, ride.driverUid)]);
    const status = ride.status !== "open" || booking.status !== "confirmed" ? "cancelled" : tripOver(ride, now) ? "ended" : "open";
    const on = status === "open";
    const [dl, pl] = on ? await Promise.all([L.get(L.LOCS, ride.id), L.get(L.PLOCS, pkey(ride.id, booking.uid))]) : [null, null];
    const ds = on && fresh(dl, now), ps = on && fresh(pl, now);
    const pick = (o, keys) => keys.reduce((a, k) => { if (o[k] !== undefined) a[k] = o[k]; return a; }, {});
    return L.send(res, 200, {
      status,
      ride: Object.assign(pick(ride, ["from", "to", "date", "time", "vehicle", "vehicleName", "fromLat", "fromLon", "toLat", "toLon", "roadKm", "roadMin"]), { seats: booking.seats }),
      passenger: { name: p ? p.name : booking.name || "Passenger", sharing: ps, loc: ps ? point(pl, now) : null },
      // The driver's number only while the trip is on.
      driver: { name: d ? d.name : ride.driverName || "Driver", photo: d ? L.mediaUrl(d.photo) : "", phone: on && d ? d.phone || "" : "", sharing: ds, loc: ds ? point(dl, now) : null },
    });
  } catch (e) {
    return L.fail(res, 502, "store_unreachable", "Couldn't reach the server just now. Try again in a moment.");
  }
}

module.exports = async (req, res) => {
  if (req.method === "GET" && L.queryParam(req, "share")) return shared(req, res);
  const user = await L.requireUser(req, res).catch(() => { L.fail(res, 502, "store_unreachable", "Couldn't reach the server just now."); return null; });
  if (!user) return;
  try {
    if (req.method === "GET") {
      const rideId = L.queryParam(req, "ride").slice(0, 64);
      const a = await access(user, rideId);
      if (!a) return L.fail(res, 404, "not_found", "Live tracking is for the driver and riders with a confirmed seat.");
      const now = Date.now();
      const open = a.ride.status === "open";
      const loc = open ? await L.get(L.LOCS, rideId) : null;
      const sharing = open && fresh(loc, now);
      const out = { role: a.role, status: a.ride.status, sharing, loc: sharing ? point(loc, now) : null };
      if (a.role === "driver") {
        // Every confirmed rider, and where the ones sharing their location are.
        out.passengers = await Promise.all(a.confirmed.map(async (b) => {
          const [u, l] = await Promise.all([L.get(L.USERS, b.uid), open ? L.get(L.PLOCS, pkey(rideId, b.uid)) : null]);
          const on = open && fresh(l, now);
          return { id: b.id, name: u ? u.name : b.name || "Passenger", photo: u ? L.mediaUrl(u.photo) : "", phone: u ? u.phone || "" : "", seats: b.seats, sharing: on, loc: on ? point(l, now) : null };
        }));
      } else {
        const l = open ? await L.get(L.PLOCS, pkey(rideId, user.id)) : null;
        const on = open && fresh(l, now);
        out.me = { sharing: on, loc: on ? point(l, now) : null };
      }
      return L.send(res, 200, out);
    }

    if (req.method === "POST") {
      const b = await L.readBody(req);
      const rideId = String(b.rideId || "").slice(0, 64);
      const a = await access(user, rideId);
      if (!a) return L.fail(res, 403, "not_yours", "Only the driver and riders with a confirmed seat can share their location for this ride.");
      if (a.ride.status !== "open") return L.fail(res, 409, "cancelled", "This ride is cancelled.");
      if (a.ride.date < L.utcDay(-1) || a.ride.date > L.utcDay(1)) return L.fail(res, 409, "not_today", "You can share your live location on the day of the ride.");
      if (a.role === "driver" && !a.confirmed.length) return L.fail(res, 409, "no_riders", "Live location is shared only while a rider's seat is confirmed.");
      const lat = num(b.lat, -90, 90), lon = num(b.lon, -180, 180);
      if (lat === null || lon === null) return L.fail(res, 400, "invalid", "That location couldn't be read.");
      const now = Date.now();
      const doc = {
        rideId, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6,
        acc: num(b.acc, 0, 100000), heading: num(b.heading, 0, 360), speed: num(b.speed, 0, 100), at: now, active: true,
      };
      if (a.role === "passenger") {
        await L.put(L.PLOCS, pkey(rideId, user.id), Object.assign(doc, { uid: user.id }));
        return L.send(res, 200, { ok: true });
      }
      const prev = await L.get(L.LOCS, rideId);
      doc.notifiedAt = prev ? prev.notifiedAt || 0 : 0;
      const notify = now - doc.notifiedAt > NOTIFY_GAP_MS;
      if (notify) doc.notifiedAt = now;
      await L.put(L.LOCS, rideId, doc);
      if (notify && L.mailOn()) {
        const r = a.ride;
        await Promise.all(a.confirmed.map(async (x) => {
          const p = await L.get(L.USERS, x.uid);
          return p && L.sendMail(p.email, user.name + " is on the way: track live", [
            "Hi " + p.name + ",",
            user.name + " has started sharing their live location for your ride from " + r.from + " to " + r.to + " at " + r.time + ".",
            "Open Saathi to see where they are and how far away they are. Share your own location there too, so " + user.name.split(" ")[0] + " can find you at pickup.",
          ], { url: L.siteUrl(req) + "/#track=" + rideId, label: "Track " + user.name.split(" ")[0] + " live" });
        }));
      }
      return L.send(res, 200, { ok: true });
    }

    if (req.method === "DELETE") {
      const rideId = L.queryParam(req, "ride").slice(0, 64);
      const ride = await L.get(L.RIDES, rideId);
      if (ride && ride.driverUid === user.id) {
        const loc = await L.get(L.LOCS, rideId);
        if (loc) { loc.active = false; delete loc.lat; delete loc.lon; await L.put(L.LOCS, rideId, loc); }
      } else {
        // A rider can always stop sharing, even after their seat is cancelled.
        await L.del(L.PLOCS, pkey(rideId, user.id));
      }
      return L.send(res, 200, { ok: true });
    }
    return L.fail(res, 405, "method", "Use GET, POST or DELETE.");
  } catch (e) {
    return L.fail(res, 502, "store_unreachable", "Couldn't reach the server just now. Check your connection and try again.");
  }
};
