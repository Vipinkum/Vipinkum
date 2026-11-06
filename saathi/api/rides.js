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
const niceDate = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dayNum = (d) => Math.round(Date.parse(d + "T00:00:00Z") / 86400000);
const minutes = (r) => dayNum(r.date) * 1440 + Number(r.time.slice(0, 2)) * 60 + Number(r.time.slice(3, 5));

// Up to 3 open rides on the same route, the same day or a day either side, with enough free seats.
function alternatives(ride, rides, bookings, seats, passenger) {
  const taken = new Map(), mine = new Set();
  for (const b of bookings) {
    const s = b.status || "pending";
    if (s === "confirmed") taken.set(b.rideId, (taken.get(b.rideId) || 0) + (b.seats || 0));
    if (b.uid === passenger.id && (s === "pending" || s === "confirmed")) mine.add(b.rideId);
  }
  const today = L.utcDay(-1);
  return rides
    .filter((x) => x.id !== ride.id && x.status === "open" && x.date >= today && Math.abs(dayNum(x.date) - dayNum(ride.date)) <= 1)
    .filter((x) => x.driverUid !== ride.driverUid && x.driverUid !== passenger.id && !mine.has(x.id))
    .filter((x) => !x.womenOnly || passenger.gender === "female")
    .map((x) => Object.assign({}, x, { left: x.seats - (taken.get(x.id) || 0) }))
    .filter((x) => x.left >= seats && L.samePlace(x, ride, "from") && L.samePlace(x, ride, "to"))
    .sort((a, b) => Math.abs(minutes(a) - minutes(ride)) - Math.abs(minutes(b) - minutes(ride)))
    .slice(0, 3);
}

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
      if (body.upi) {
        const upi = L.normUpi(body.upi);
        if (!upi) return L.fail(res, 400, "invalid", "That UPI ID doesn't look right. It looks like name@bank, for example asha@okaxis.");
        ride.upi = upi;
      }
      if (ride.upi && ride.upi !== user.upi) { user.upi = ride.upi; await L.put(L.USERS, user.id, user); }
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
      // Live location ends with the ride, the driver's and every rider's.
      const bookings = await L.all(L.BOOKINGS);
      await Promise.all([L.del(L.LOCS, id), ...bookings.filter((b) => b.rideId === id).map((b) => L.del(L.PLOCS, id + "." + b.uid))].map((p) => p.catch(() => {})));
      // Tell everyone who asked for a seat, with other rides on the same route that still have room.
      if (L.mailOn() || L.smsOn()) {
        const [rides, users] = await Promise.all([L.all(L.RIDES), L.all(L.USERS)]);
        const byId = new Map(users.map((u) => [u.id, u]));
        const site = L.siteUrl(req);
        const notify = bookings.filter((b) => b.rideId === id && ["pending", "confirmed"].includes(b.status || "pending"));
        await Promise.all(notify.map((b) => {
          const p = byId.get(b.uid);
          if (!p) return null;
          const alts = alternatives(ride, rides, bookings, b.seats || 1, p);
          const lines = [
            "Hi " + p.name + ",",
            user.name + " cancelled the ride " + tripLine(ride) + ". Your seat request is closed and nothing is owed.",
          ];
          if (alts.length) {
            lines.push(alts.length === 1 ? "This ride on the same route still has room:" : "These rides on the same route still have room:");
            alts.forEach((a) => {
              const d = byId.get(a.driverUid);
              lines.push({ text: a.time + " on " + niceDate(a.date) + ", " + a.from + " to " + a.to + " with " + (d ? d.name : "a driver") + ", ₹" + a.price + (a.vehicle === "bike" ? "" : " per seat") + ", " + a.left + (a.left === 1 ? " seat" : " seats") + " left", url: site + "/#ride=" + a.id });
            });
          } else {
            lines.push("No other ride on this route has free seats right now. New rides are posted all the time, so check Saathi again soon.");
          }
          return Promise.all([
            L.sendMail(p.email, "Ride cancelled: " + ride.from + " to " + ride.to + (alts.length ? " (other rides found)" : ""), lines,
              { url: site + "/#find", label: "Find another ride" }),
            L.sendSms(p.phone, "Saathi: " + user.name + " cancelled your ride " + ride.from + " to " + ride.to + ", " + niceDate(ride.date) + " " + ride.time + ". " +
              (alts.length ? alts.length + (alts.length === 1 ? " other ride has" : " other rides have") + " seats on this route: " + site + "/#ride=" + alts[0].id : "Find another ride: " + site + "/#find")),
          ]);
        }));
      }
      return L.send(res, 200, { ride });
    }
    return L.fail(res, 405, "method", "Use POST or PATCH.");
  } catch (e) {
    return L.fail(res, 502, "store_unreachable", "Couldn't save just now. Check your connection and try again.");
  }
};
