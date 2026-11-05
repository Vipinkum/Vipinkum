// POST   /api/bookings                         ask the driver for seats (stays pending)
// PATCH  /api/bookings?id=...&action=accept     driver confirms; passenger is emailed
// PATCH  /api/bookings?id=...&action=decline    driver declines; passenger is emailed
// DELETE /api/bookings?id=...                  passenger cancels their own request or seat
const L = require("./_lib");

const statusOf = (b) => b.status || "pending";
const ACTIVE = ["pending", "confirmed"];
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
const tripLine = (r) => r.from + " to " + r.to + ", " + r.date + " at " + r.time;
const waLink = (phone, text) => "https://wa.me/" + String(phone || "").replace(/\D/g, "") + (text ? "?text=" + encodeURIComponent(text) : "");

function seatsTaken(bookings, rideId, exceptId) {
  return bookings
    .filter((x) => x.rideId === rideId && x.id !== exceptId && statusOf(x) === "confirmed")
    .reduce((a, x) => a + (x.seats || 0), 0);
}

module.exports = async (req, res) => {
  const user = await L.requireUser(req, res).catch(() => { L.fail(res, 502, "store_unreachable", "Couldn't reach the server just now."); return null; });
  if (!user) return;
  const site = L.siteUrl(req);
  try {
    if (req.method === "POST") {
      const b = await L.readBody(req);
      const rideId = String(b.rideId || "").slice(0, 64);
      const seats = L.int(b.seats);
      const message = L.text(b.message, 200);
      if (!(seats >= 1 && seats <= 6)) return L.fail(res, 400, "invalid", "Ask for between 1 and 6 seats.");
      if (!user.phone) return L.fail(res, 400, "no_phone", "Add your mobile number in Profile so the driver can reach you.");
      const [ride, bookings] = await Promise.all([L.get(L.RIDES, rideId), L.all(L.BOOKINGS)]);
      if (!ride) return L.fail(res, 404, "not_found", "That ride no longer exists.");
      if (ride.status !== "open") return L.fail(res, 409, "cancelled", "The driver cancelled this ride.");
      if (ride.date < L.utcDay(-1)) return L.fail(res, 409, "past", "This ride has already left.");
      if (ride.driverUid === user.id) return L.fail(res, 409, "own", "You can't book your own ride.");
      if (ride.womenOnly && user.gender !== "female") {
        return L.fail(res, 403, "women_only", user.gender ? "This ride is for women passengers only." : "This ride is for women passengers. If that's you, set your gender in Profile first.");
      }
      const mine = bookings.filter((x) => x.rideId === rideId && x.uid === user.id);
      if (mine.some((x) => ACTIVE.includes(statusOf(x)))) return L.fail(res, 409, "already", "You've already asked for a seat on this ride.");
      if (mine.some((x) => statusOf(x) === "declined")) return L.fail(res, 409, "declined", "The driver couldn't take your request for this ride.");
      const left = ride.seats - seatsTaken(bookings, rideId);
      if (seats > left) return L.fail(res, 409, "full", left > 0 ? "Only " + plural(left, "seat is", "seats are") + " left on this ride." : "Every seat on this ride is taken.");
      const doc = { id: L.newId(), rideId, uid: user.id, name: user.name, seats, message, status: "pending", createdAt: Date.now() };
      await L.put(L.BOOKINGS, doc.id, doc);
      const driver = await L.get(L.USERS, ride.driverUid);
      const emailed = !!(driver && (await L.sendMail(driver.email, "Seat request: " + user.name + " for " + ride.from + " to " + ride.to, [
        "Hi " + driver.name + ",",
        user.name + " asked for " + plural(seats, "seat", "seats") + " on your ride " + tripLine(ride) + ".",
        message ? "Their note: “" + message + "”" : "",
        "Open Saathi to confirm or decline. They'll get your number once you confirm.",
      ].filter(Boolean), { url: site + "/#trips", label: "Review the request" })));
      return L.send(res, 201, { booking: doc, emailed });
    }

    if (req.method === "PATCH") {
      const id = L.queryId(req);
      const action = L.queryParam(req, "action");
      if (action !== "accept" && action !== "decline") return L.fail(res, 400, "action", "Use action=accept or action=decline.");
      const [booking, bookings] = await Promise.all([L.get(L.BOOKINGS, id), L.all(L.BOOKINGS)]);
      if (!booking) return L.fail(res, 404, "not_found", "That request no longer exists.");
      const ride = await L.get(L.RIDES, booking.rideId);
      if (!ride) return L.fail(res, 404, "not_found", "That ride no longer exists.");
      if (ride.driverUid !== user.id) return L.fail(res, 403, "not_yours", "Only the driver can answer this request.");
      const status = statusOf(booking);
      if (status === "cancelled") return L.fail(res, 409, "cancelled", "The passenger already cancelled this request.");
      if (action === "accept" && status === "confirmed") return L.send(res, 200, { booking, emailed: false });
      if (action === "decline" && status === "declined") return L.send(res, 200, { booking, emailed: false });
      const passenger = await L.get(L.USERS, booking.uid);
      let emailed = false;
      if (action === "accept") {
        if (ride.status !== "open") return L.fail(res, 409, "cancelled", "This ride is cancelled.");
        const left = ride.seats - seatsTaken(bookings, ride.id, booking.id);
        if (booking.seats > left) return L.fail(res, 409, "full", left > 0 ? "Only " + plural(left, "seat is", "seats are") + " left, and this request is for " + booking.seats + "." : "Every seat is already confirmed.");
        booking.status = "confirmed";
        booking.decidedAt = Date.now();
        await L.put(L.BOOKINGS, id, booking);
        if (passenger) {
          const share = "Saathi trip: " + passenger.name + " is riding with " + user.name + " (" + user.phone + ") from " + tripLine(ride) +
            ". Vehicle: " + (ride.vehicleName || (ride.vehicle === "bike" ? "bike" : "car")) + ". Seats: " + booking.seats + ".";
          emailed = await L.sendMail(passenger.email, "Confirmed: your seat from " + ride.from + " to " + ride.to, [
            "Hi " + passenger.name + ",",
            user.name + " confirmed your " + plural(booking.seats, "seat", "seats") + " on " + tripLine(ride) + ".",
            "Pay ₹" + ride.price * booking.seats + " to the driver" + (ride.price === 0 ? " (this ride is free)." : ride.qr ? ", in cash or by UPI with the QR code on the ride in Saathi." : " on the day."),
            "Driver's number: " + user.phone + ". WhatsApp: " + waLink(user.phone),
            passenger.altPhone ? "Send these trip details to " + (passenger.altName || "your alternative number") + " on WhatsApp: " + waLink(passenger.altPhone, share) : "",
            "Agree on the exact pickup point before you leave.",
          ].filter(Boolean), { url: site + "/#trips", label: "See your trip" });
        }
      } else {
        booking.status = "declined";
        booking.decidedAt = Date.now();
        await L.put(L.BOOKINGS, id, booking);
        if (passenger) {
          emailed = await L.sendMail(passenger.email, "Request not accepted: " + ride.from + " to " + ride.to, [
            "Hi " + passenger.name + ",",
            user.name + " couldn't take your request for " + tripLine(ride) + ".",
            "Other drivers may still have seats on this route.",
          ], { url: site + "/#find", label: "Find another ride" });
        }
      }
      return L.send(res, 200, { booking, emailed });
    }

    if (req.method === "DELETE") {
      const id = L.queryId(req);
      const booking = await L.get(L.BOOKINGS, id);
      if (!booking) return L.send(res, 200, { ok: true });
      if (booking.uid !== user.id) return L.fail(res, 403, "not_yours", "You can only cancel your own request.");
      const was = statusOf(booking);
      if (!ACTIVE.includes(was)) return L.send(res, 200, { ok: true });
      booking.status = "cancelled";
      booking.cancelledAt = Date.now();
      await L.put(L.BOOKINGS, id, booking);
      if (was === "confirmed") {
        const ride = await L.get(L.RIDES, booking.rideId);
        const driver = ride && (await L.get(L.USERS, ride.driverUid));
        if (driver) {
          await L.sendMail(driver.email, "Seat cancelled: " + ride.from + " to " + ride.to, [
            "Hi " + driver.name + ",",
            user.name + " cancelled their " + plural(booking.seats, "seat", "seats") + " on " + tripLine(ride) + ". The seats are open again.",
          ], { url: site + "/#trips", label: "See your ride" });
        }
      }
      return L.send(res, 200, { ok: true });
    }
    return L.fail(res, 405, "method", "Use POST, PATCH or DELETE.");
  } catch (e) {
    return L.fail(res, 502, "store_unreachable", "Couldn't save just now. Check your connection and try again.");
  }
};
