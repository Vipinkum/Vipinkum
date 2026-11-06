// GET    /api/media?id=...          a profile photo (anyone), payment QR (its owner and riders with a confirmed
//                                   seat on one of the owner's rides) or voice message (the two people in that chat)
// POST   /api/media {type, data}    upload your profile photo or payment QR (type "photo" or "qr")
// DELETE /api/media?type=photo|qr   remove your profile photo or saved payment QR
const L = require("./_lib");

const LIMITS = { photo: 400000, qr: 700000 };

async function canSee(doc, req) {
  if (doc.type === "photo") return true;
  const me = await L.currentUser(req);
  if (!me) return false;
  if (doc.owner === me.id) return true;
  if (doc.type === "qr") {
    // Riders with a confirmed seat on any of the owner's rides (the QR can be on the ride or in the driver's profile).
    const [rides, bookings] = await Promise.all([L.all(L.RIDES), L.all(L.BOOKINGS)]);
    const rideIds = new Set(rides.filter((r) => r.driverUid === doc.owner).map((r) => r.id));
    return bookings.some((b) => rideIds.has(b.rideId) && b.uid === me.id && b.status === "confirmed");
  }
  if (doc.type === "voice" || doc.type === "file") {
    const c = await L.get(L.CONVS, doc.conv);
    return !!c && (c.passenger === me.id || c.driver === me.id);
  }
  return false;
}

function serve(req, res, doc) {
  const buf = Buffer.from(doc.data, "base64");
  res.setHeader("Content-Type", doc.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", doc.type === "photo" ? "public, max-age=31536000, s-maxage=31536000, immutable" : "private, max-age=31536000, immutable");
  if (doc.type === "qr") res.setHeader("Content-Disposition", 'inline; filename="saathi-upi-qr.' + (doc.mime === "image/png" ? "png" : "jpg") + '"');
  if (doc.type === "file") res.setHeader("Content-Disposition", (doc.mime === "application/pdf" ? "attachment" : "inline") + '; filename="' + String(doc.name || "file").replace(/[^\w .()\-]/g, "_") + '"');
  // Safari asks for audio in byte ranges.
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, buf.length - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
    if (start >= buf.length || start > end) {
      res.statusCode = 416; res.setHeader("Content-Range", "bytes */" + buf.length); return res.end();
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + buf.length);
    res.setHeader("Content-Length", end - start + 1);
    return res.end(buf.subarray(start, end + 1));
  }
  res.statusCode = 200;
  res.setHeader("Content-Length", buf.length);
  res.end(buf);
}

module.exports = async (req, res) => {
  if (!L.hasStore()) return L.fail(res, 503, "no_store", "Saathi isn't connected to its database yet.");
  try {
    if (req.method === "GET") {
      const doc = await L.get(L.MEDIA, L.queryId(req));
      if (!doc || !(await canSee(doc, req))) return L.fail(res, 404, "not_found", "That file isn't available.");
      return serve(req, res, doc);
    }
    const user = await L.requireUser(req, res);
    if (!user) return;
    if (req.method === "POST") {
      const b = await L.readBody(req, 1000000);
      if (b._tooLarge) return L.fail(res, 413, "too_large", "That image is too large. Try a smaller one.");
      const type = b.type === "qr" ? "qr" : b.type === "photo" ? "photo" : "";
      if (!type) return L.fail(res, 400, "invalid", "Say whether this is a photo or a QR code.");
      const [file, why] = L.parseDataUrl(b.data, "image/", LIMITS[type]);
      if (!file) return L.fail(res, why === "size" ? 413 : 400, "invalid", why === "size" ? "That image is too large. Try a smaller one." : "Upload a JPG, PNG or WebP image.");
      const doc = { id: L.newId(), type, owner: user.id, mime: file.mime, data: file.b64, size: file.size, createdAt: Date.now() };
      await L.put(L.MEDIA, doc.id, doc);
      const old = user[type];
      user[type] = doc.id;
      await L.put(L.USERS, user.id, user);
      if (old) {
        // A QR still attached to a ride stays, so riders on that ride can keep paying with it.
        const inUse = type === "qr" && (await L.all(L.RIDES)).some((r) => r.qr === old);
        if (!inUse) await L.del(L.MEDIA, old);
      }
      return L.send(res, 201, { id: doc.id, user: L.publicUser(user) });
    }
    if (req.method === "DELETE") {
      const type = L.queryParam(req, "type") === "qr" ? "qr" : "photo";
      const old = user[type];
      user[type] = "";
      await L.put(L.USERS, user.id, user);
      if (old) {
        const inUse = type === "qr" && (await L.all(L.RIDES)).some((r) => r.qr === old);
        if (!inUse) await L.del(L.MEDIA, old);
      }
      return L.send(res, 200, { user: L.publicUser(user) });
    }
    return L.fail(res, 405, "method", "Use GET, POST or DELETE.");
  } catch (e) {
    return L.fail(res, 502, "store_unreachable", "Couldn't reach the server just now. Check your connection and try again.");
  }
};
