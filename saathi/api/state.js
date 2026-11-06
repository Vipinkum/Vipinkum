// GET /api/state: the signed-in user, every ride, the bookings and chats that user may see.
// Everyone sees how many seats are confirmed on a ride. Names are only shared between a
// passenger and that ride's driver; phone numbers and the payment QR only once the driver confirms.
const L = require("./_lib");

const ACTIVE = ["pending", "confirmed"];
const statusOf = (b) => b.status || "pending";

module.exports = async (req, res) => {
  if (req.method !== "GET") return L.fail(res, 405, "method", "Use GET.");
  if (!L.hasStore()) return L.fail(res, 503, "no_store", "Saathi isn't connected to its database yet.");
  try {
    const [{ rides, bookings, users }, sessionUser] = await Promise.all([L.loadAll(), L.currentUser(req)]);
    const me = sessionUser ? sessionUser.id : null;
    const [convs, locs] = me ? await Promise.all([
      L.all(L.CONVS).then((all) => all.filter((c) => c.passenger === me || c.driver === me)),
      L.all(L.LOCS),
    ]) : [[], []];
    const now = Date.now();
    const liveRides = new Set(locs.filter((l) => l.active && now - l.at < 3 * 60000).map((l) => l.rideId));
    const myConfirmed = new Set(bookings.filter((b) => b.uid === me && b.status === "confirmed").map((b) => b.rideId));
    const userById = new Map(users.map((u) => [u.id, u]));
    const since = L.utcDay(-45);

    const rideById = new Map(rides.map((r) => [r.id, r]));
    const ridesOffered = new Map();
    for (const r of rides) if (r.status === "open") ridesOffered.set(r.driverUid, (ridesOffered.get(r.driverUid) || 0) + 1);

    const seatsBy = new Map(); // rideId -> {taken, requested}
    for (const b of bookings) {
      const s = statusOf(b);
      if (!ACTIVE.includes(s)) continue;
      const c = seatsBy.get(b.rideId) || { taken: 0, requested: 0 };
      if (s === "confirmed") c.taken += b.seats || 0; else c.requested += b.seats || 0;
      seatsBy.set(b.rideId, c);
    }

    const outRides = rides.filter((r) => r.date >= since).map((r) => {
      const d = userById.get(r.driverUid);
      const c = seatsBy.get(r.id) || { taken: 0, requested: 0 };
      const out = Object.assign({}, r, {
        driverName: d ? d.name : r.driverName || "Driver",
        driverBio: d ? d.bio || "" : "",
        driverPhoto: d ? L.mediaUrl(d.photo) : "",
        driverSince: d ? d.createdAt : null,
        driverRides: ridesOffered.get(r.driverUid) || 0,
        taken: c.taken,
        hasQr: !!r.qr,
        mine: !!me && r.driverUid === me,
      });
      if (out.mine) { out.requested = c.requested; out.qr = L.mediaUrl(r.qr); } else { delete out.qr; delete out.upi; }
      out.hasUpi = !!r.upi;
      // Whether the driver is sharing live location right now, only for the driver and confirmed riders.
      if (out.mine || myConfirmed.has(r.id)) out.live = liveRides.has(r.id);
      delete out.driverUid;
      return out;
    });

    const outBookings = [];
    if (me) {
      for (const b of bookings) {
        const ride = rideById.get(b.rideId);
        if (!ride) continue;
        const asPassenger = b.uid === me;
        const asDriver = ride.driverUid === me;
        if (!asPassenger && !asDriver) continue;
        const status = statusOf(b);
        const passenger = userById.get(b.uid);
        const o = {
          id: b.id, rideId: b.rideId, seats: b.seats, status, createdAt: b.createdAt, decidedAt: b.decidedAt || null,
          message: b.message || "", mine: asPassenger, conv: b.rideId + "." + b.uid,
          name: passenger ? passenger.name : b.name || "Passenger",
          photo: passenger ? L.mediaUrl(passenger.photo) : "",
        };
        if (asDriver && passenger) {
          o.gender = passenger.gender || "";
          if (status === "confirmed") o.phone = passenger.phone || "";
        }
        if (asPassenger && status === "confirmed") {
          const d = userById.get(ride.driverUid);
          o.driverPhone = d ? d.phone || "" : "";
          o.qr = L.mediaUrl(ride.qr);
          o.upi = ride.upi || "";
          // The live trip link for the passenger's family contact, and whether Saathi already sent it.
          o.token = L.shareToken(b.id);
          o.altSent = b.altSent ? { wa: !!b.altSent.wa, sms: !!b.altSent.sms } : null;
        }
        outBookings.push(o);
      }
    }

    const outConvs = convs.map((c) => {
      const role = c.driver === me ? "driver" : "passenger";
      const other = userById.get(role === "driver" ? c.passenger : c.driver);
      const r = rideById.get(c.rideId);
      return {
        id: c.id, rideId: c.rideId, role,
        other: { name: other ? other.name : "Saathi member", photo: other ? L.mediaUrl(other.photo) : "" },
        ride: r ? { from: r.from, to: r.to, date: r.date, time: r.time, status: r.status } : null,
        lastText: c.lastText || "", lastAt: c.lastAt || c.createdAt || 0, lastMine: c.lastFrom === me,
        unread: (c.unread && c.unread[me]) || 0,
      };
    }).sort((a, b) => b.lastAt - a.lastAt);

    L.send(res, 200, { me: L.publicUser(sessionUser), features: { email: L.mailOn(), sms: L.smsOn(), wa: L.waOn(), admin: L.isAdmin(sessionUser) }, rides: outRides, bookings: outBookings, convs: outConvs });
  } catch (e) {
    L.fail(res, 502, "store_unreachable", "The ride board can't be reached right now.");
  }
};
