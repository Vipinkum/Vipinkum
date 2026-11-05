// POST /api/bookings          book seats on a ride
// DELETE /api/bookings?id=... cancel your own booking
const L = require("./_lib");

module.exports = async (req, res) => {
  const uid = L.guard(req, res);
  if (!uid) return;
  try {
    if (req.method === "POST") {
      const b = await L.readBody(req);
      const rideId = String(b.rideId || "").slice(0, 64);
      const seats = L.int(b.seats);
      const name = L.str(b.name, 40);
      if (!name) return L.fail(res, 400, "invalid", "Add your name so the driver knows who's coming.");
      if (!(seats >= 1 && seats <= 6)) return L.fail(res, 400, "invalid", "Book between 1 and 6 seats.");
      const { rides, bookings } = await L.loadAll();
      const ride = rides.find((r) => r.id === rideId);
      if (!ride) return L.fail(res, 404, "not_found", "That ride no longer exists.");
      if (ride.status !== "open") return L.fail(res, 409, "cancelled", "The driver cancelled this ride.");
      if (ride.date < L.utcDay(-1)) return L.fail(res, 409, "past", "This ride has already left.");
      if (ride.driverUid === uid) return L.fail(res, 409, "own", "You can't book your own ride.");
      const forRide = bookings.filter((x) => x.rideId === rideId);
      if (forRide.some((x) => x.uid === uid)) return L.fail(res, 409, "already", "You've already booked this ride.");
      const left = ride.seats - forRide.reduce((a, x) => a + (x.seats || 0), 0);
      if (seats > left) return L.fail(res, 409, "full", left > 0 ? "Only " + left + (left === 1 ? " seat is" : " seats are") + " left on this ride." : "Every seat on this ride is booked.");
      const doc = { id: L.newId(), rideId, uid, name, seats, createdAt: Date.now() };
      await L.redis([["HSET", L.BOOKINGS, doc.id, JSON.stringify(doc)]]);
      return L.send(res, 201, { booking: doc });
    }
    if (req.method === "DELETE") {
      const id = String((req.query && req.query.id) || new URL(req.url, "http://x").searchParams.get("id") || "");
      const [raw] = await L.redis([["HGET", L.BOOKINGS, id]]);
      if (!raw) return L.send(res, 200, { ok: true });
      if (JSON.parse(raw).uid !== uid) return L.fail(res, 403, "not_yours", "You can only cancel your own booking.");
      await L.redis([["HDEL", L.BOOKINGS, id]]);
      return L.send(res, 200, { ok: true });
    }
    return L.fail(res, 405, "method", "Use POST or DELETE.");
  } catch (e) {
    return L.fail(res, 502, "store_unreachable", "Couldn't save just now. Check your connection and try again.");
  }
};
