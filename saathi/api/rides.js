// POST /api/rides           publish a ride (signed in)
// PATCH /api/rides?id=...   cancel your own ride; passengers are emailed
const L = require("./_lib");

function validate(b) {
  const vehicle = b.vehicle === "bike" ? "bike" : "car";
  const ride = {
    from: L.str(b.from, 60),
    to: L.str(b.to, 60),
    date: typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : "",
    time: typeof b.time === "string" && /^\d{2}:\d{2}$/.test(b.time) ? b.time : "",
    vehicle,
    vehicleName: L.str(b.vehicleName, 40),
    seats: vehicle === "bike" ? 1 : L.int(b.seats),
    price: L.int(b.price),
    womenOnly: b.womenOnly === true,
    helmet: vehicle === "bike" && b.helmet === true,
    note: L.text(b.note, 200),
  };
  // Optional map data from the free OpenStreetMap lookups in the page.
  const coord = (v, max) => { const n = Number(v); return v !== null && v !== "" && Number.isFinite(n) && Math.abs(n) <= max ? Math.round(n * 1e5) / 1e5 : null; };
  const fLat = coord(b.fromLat, 90), fLon = coord(b.fromLon, 180), tLat = coord(b.toLat, 90), tLon = coord(b.toLon, 180);
  if (fLat !== null && fLon !== null) { ride.fromLat = fLat; ride.fromLon = fLon; }
  if (tLat !== null && tLon !== null) { ride.toLat = tLat; ride.toLon = tLon; }
  const rk = L.int(b.roadKm), rm = L.int(b.roadMin);
  if (rk >= 1 && rk <= 5000) ride.roadKm = rk;
  if (rm >= 1 && rm <= 6000) ride.roadMin = rm;
  if (!ride.from || !ride.to) return [null, "Add where you're leaving from and where you're going."];
  if (ride.from.toLowerCase() === ride.to.toLowerCase()) return [null, "Leaving from and going to need to be different places."];
  if (!ride.date || ride.date < L.utcDay(-1)) return [null, "Pick today or a later date."];
  if (!ride.time) return [null, "Add the time you're leaving."];
  if (!(ride.seats >= 1 && ride.seats <= 6)) return [null, "Offer between 1 and 6 seats."];
  if (!(ride.price >= 0 && ride.price <= 10000)) return [null, "Price needs to be a whole number of rupees between 0 and 10,000."];
  return [ride, null];
}

const tripLine = (r) => r.from + " to " + r.to + ", " + r.date + " at " + r.time;

module.exports = async (req, res) => {
  const user = await L.requireUser(req, res).catch(() => { L.fail(res, 502, "store_unreachable", "Couldn't reach the server just now."); return null; });
  if (!user) return;
  try {
    if (req.method === "POST") {
      const body = await L.readBody(req);
      const [ride, err] = validate(body);
      if (err) return L.fail(res, 400, "invalid", err);
      if (ride.womenOnly && user.gender !== "female") {
        return L.fail(res, 403, "women_only", "Women-only rides can be offered by women drivers. If that's you, set your gender in Profile.");
      }
      if (!user.phone) return L.fail(res, 400, "no_phone", "Add your mobile number in Profile so confirmed riders can reach you.");
      if ((await L.count(L.RIDES)) >= L.MAX_RIDES) return L.fail(res, 507, "full", "The ride board is full. Old rides need to be cleared before new ones can be added.");
      const qrId = typeof body.qr === "string" ? body.qr.slice(0, 64) : "";
      if (qrId) {
        const qr = await L.get(L.MEDIA, qrId);
        if (!qr || qr.type !== "qr" || qr.owner !== user.id) return L.fail(res, 400, "invalid", "That payment QR couldn't be found. Upload it again.");
        ride.qr = qrId;
      }
      const doc = Object.assign({ id: L.newId(), driverUid: user.id, driverName: user.name, status: "open", createdAt: Date.now() }, ride);
      await L.put(L.RIDES, doc.id, doc);
      return L.send(res, 201, { ride: doc });
    }
    if (req.method === "PATCH") {
      const id = L.queryId(req);
      const ride = await L.get(L.RIDES, id);
      if (!ride) return L.fail(res, 404, "not_found", "That ride no longer exists.");
      if (ride.driverUid !== user.id) return L.fail(res, 403, "not_yours", "Only the driver can cancel this ride.");
      if (ride.status === "cancelled") return L.send(res, 200, { ride });
      ride.status = "cancelled";
      ride.cancelledAt = Date.now();
      await L.put(L.RIDES, id, ride);
      // Let everyone who asked for a seat know.
      if (L.mailOn()) {
        const [bookings, users] = await Promise.all([L.all(L.BOOKINGS), L.all(L.USERS)]);
        const byId = new Map(users.map((u) => [u.id, u]));
        const notify = bookings.filter((b) => b.rideId === id && ["pending", "confirmed"].includes(b.status || "pending"));
        await Promise.all(notify.map((b) => {
          const p = byId.get(b.uid);
          return p && L.sendMail(p.email, "Ride cancelled: " + ride.from + " to " + ride.to, [
            "Hi " + p.name + ",",
            user.name + " cancelled the ride " + tripLine(ride) + ". Your seat request is closed and nothing is owed.",
            "Other rides on this route may still have seats.",
          ], { url: L.siteUrl(req) + "/#find", label: "Find another ride" });
        }));
      }
      return L.send(res, 200, { ride });
    }
    return L.fail(res, 405, "method", "Use POST or PATCH.");
  } catch (e) {
    return L.fail(res, 502, "store_unreachable", "Couldn't save just now. Check your connection and try again.");
  }
};
