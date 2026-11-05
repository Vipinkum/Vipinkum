// GET /api/state: every ride and booking. Passenger names are only sent
// to that passenger and to the ride's driver.
const L = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "GET") return L.fail(res, 405, "method", "Use GET.");
  if (!L.hasStore()) return L.fail(res, 503, "no_store", "Shared storage isn't connected yet.");
  const me = L.uidFrom(req);
  try {
    const { rides, bookings } = await L.loadAll();
    const driverOf = new Map(rides.map((r) => [r.id, r.driverUid]));
    const safeBookings = bookings.map((b) => {
      const canSeeName = me && (b.uid === me || driverOf.get(b.rideId) === me);
      return { id: b.id, rideId: b.rideId, uid: b.uid, seats: b.seats, createdAt: b.createdAt, name: canSeeName ? b.name : "" };
    });
    L.send(res, 200, { rides, bookings: safeBookings });
  } catch (e) {
    L.fail(res, 502, "store_unreachable", "The ride board can't be reached right now.");
  }
};
