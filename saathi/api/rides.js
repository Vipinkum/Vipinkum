// POST /api/rides           publish a ride
// PATCH /api/rides?id=...   cancel your own ride
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
    driverName: L.str(b.driverName, 40),
  };
  // Optional map data from the free OpenStreetMap lookups in the page.
  const coord = (v, max) => { const n = Number(v); return v !== null && v !== "" && Number.isFinite(n) && Math.abs(n) <= max ? Math.round(n * 1e5) / 1e5 : null; };
  const fLat = coord(b.fromLat, 90), fLon = coord(b.fromLon, 180), tLat = coord(b.toLat, 90), tLon = coord(b.toLon, 180);
  if (fLat !== null && fLon !== null) { ride.fromLat = fLat; ride.fromLon = fLon; }
  if (tLat !== null && tLon !== null) { ride.toLat = tLat; ride.toLon = tLon; }
  const rk = L.int(b.roadKm), rm = L.int(b.roadMin);
  if (rk >= 1 && rk <= 5000) ride.roadKm = rk;
  if (rm >= 1 && rm <= 6000) ride.roadMin = rm;
  if (!ride.driverName) return [null, "Add your name so passengers know who's driving."];
  if (!ride.from || !ride.to) return [null, "Add where you're leaving from and where you're going."];
  if (ride.from.toLowerCase() === ride.to.toLowerCase()) return [null, "Leaving from and going to need to be different places."];
  if (!ride.date || ride.date < L.utcDay(-1)) return [null, "Pick today or a later date."];
  if (!ride.time) return [null, "Add the time you're leaving."];
  if (!(ride.seats >= 1 && ride.seats <= 6)) return [null, "Offer between 1 and 6 seats."];
  if (!(ride.price >= 0 && ride.price <= 10000)) return [null, "Price needs to be a whole number of rupees between 0 and 10,000."];
  return [ride, null];
}

module.exports = async (req, res) => {
  const uid = L.guard(req, res);
  if (!uid) return;
  try {
    if (req.method === "POST") {
      const [ride, err] = validate(await L.readBody(req));
      if (err) return L.fail(res, 400, "invalid", err);
      if ((await L.count(L.RIDES)) >= L.MAX_RIDES) return L.fail(res, 507, "full", "The ride board is full. Old rides need to be cleared before new ones can be added.");
      const doc = Object.assign({ id: L.newId(), driverUid: uid, status: "open", createdAt: Date.now() }, ride);
      await L.put(L.RIDES, doc.id, doc);
      return L.send(res, 201, { ride: doc });
    }
    if (req.method === "PATCH") {
      const id = L.queryId(req);
      const ride = await L.get(L.RIDES, id);
      if (!ride) return L.fail(res, 404, "not_found", "That ride no longer exists.");
      if (ride.driverUid !== uid) return L.fail(res, 403, "not_yours", "Only the driver can cancel this ride.");
      ride.status = "cancelled";
      await L.put(L.RIDES, id, ride);
      return L.send(res, 200, { ride });
    }
    return L.fail(res, 405, "method", "Use POST or PATCH.");
  } catch (e) {
    return L.fail(res, 502, "store_unreachable", "Couldn't save just now. Check your connection and try again.");
  }
};
