// GET  /api/messages?conv=...&since=...     messages in a chat you're part of; marks them read
// POST /api/messages {conv, text}            send a text message
// POST /api/messages {conv, voice:{data,dur}} send a voice message (up to 2 minutes)
// A chat is one ride plus one passenger: conv = "<rideId>.<passengerId>". A passenger can message the
// driver of any ride; a driver can message anyone who asked for a seat on their ride.
const L = require("./_lib");

const MAX_MESSAGES = 500;
const VOICE_BYTES = 600000;

function parseConv(id) {
  const m = /^([a-f0-9]{6,64})\.([a-f0-9]{6,64})$/.exec(String(id || ""));
  return m ? { id: m[0], rideId: m[1], passenger: m[2] } : null;
}
// Who is this user in the chat, and who is the other person?
async function access(user, convId) {
  const p = parseConv(convId);
  if (!p) return null;
  const ride = await L.get(L.RIDES, p.rideId);
  if (!ride) return null;
  if (user.id === p.passenger && ride.driverUid !== user.id) return { p, ride, role: "passenger", other: ride.driverUid };
  if (user.id === ride.driverUid && p.passenger !== user.id) return { p, ride, role: "driver", other: p.passenger };
  return null;
}
const out = (m, me) => ({ id: m.id, mine: m.from === me, text: m.text || "", voice: m.voice ? { url: L.mediaUrl(m.voice.id), dur: m.voice.dur } : null, at: m.at });
const tripLine = (r) => r.from + " to " + r.to + ", " + r.date + " at " + r.time;
const fmtDur = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");

module.exports = async (req, res) => {
  const user = await L.requireUser(req, res).catch(() => { L.fail(res, 502, "store_unreachable", "Couldn't reach the server just now."); return null; });
  if (!user) return;
  try {
    if (req.method === "GET") {
      const id = L.queryParam(req, "conv").slice(0, 140);
      const a = await access(user, id);
      if (!a) return L.fail(res, 404, "not_found", "That chat isn't available.");
      const since = Number(L.queryParam(req, "since")) || 0;
      const [conv, all] = await Promise.all([L.get(L.CONVS, id), L.all(L.msgKind(id))]);
      const messages = all.filter((m) => m.at > since).sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1));
      if (conv) {
        // Remember when each person last looked, so nobody gets emailed about a chat they have open.
        conv.unread = conv.unread || {}; conv.readAt = conv.readAt || {};
        const stale = Date.now() - (conv.readAt[user.id] || 0) > 30000;
        if (conv.unread[user.id] || stale) { conv.unread[user.id] = 0; conv.readAt[user.id] = Date.now(); await L.put(L.CONVS, id, conv); }
      }
      return L.send(res, 200, { exists: !!conv, messages: messages.map((m) => out(m, user.id)) });
    }

    if (req.method === "POST") {
      const b = await L.readBody(req, 1000000);
      if (b._tooLarge) return L.fail(res, 413, "too_large", "That voice message is too long. Keep it under a minute.");
      const id = String(b.conv || "").slice(0, 140);
      const a = await access(user, id);
      if (!a) return L.fail(res, 404, "not_found", "That chat isn't available.");
      const text = L.text(b.text, 1000);
      let voice = null;
      if (b.voice) {
        const [file, why] = L.parseDataUrl(b.voice.data, "audio/", VOICE_BYTES);
        if (!file) return L.fail(res, why === "size" ? 413 : 400, "invalid", why === "size" ? "That voice message is too long. Keep it under a minute." : "That recording couldn't be read. Try again.");
        const dur = Math.round(Number(b.voice.dur));
        voice = { file, dur: dur >= 1 && dur <= 120 ? dur : 1 };
      }
      if (!text && !voice) return L.fail(res, 400, "invalid", "Type a message or record a voice message.");

      let conv = await L.get(L.CONVS, id);
      if (!conv) {
        if (a.role === "driver") {
          const asked = (await L.all(L.BOOKINGS)).some((x) => x.rideId === a.ride.id && x.uid === a.p.passenger);
          if (!asked) return L.fail(res, 404, "not_found", "That chat isn't available.");
        }
        conv = { id, rideId: a.ride.id, passenger: a.p.passenger, driver: a.ride.driverUid, createdAt: Date.now(), unread: {} };
      }
      if ((await L.count(L.msgKind(id))) >= MAX_MESSAGES) return L.fail(res, 409, "full", "This chat is full. Call or WhatsApp each other instead.");

      const msg = { id: L.newId(), conv: id, from: user.id, text, at: Date.now() };
      if (voice) {
        const media = { id: L.newId(), type: "voice", owner: user.id, conv: id, mime: voice.file.mime, data: voice.file.b64, size: voice.file.size, createdAt: msg.at };
        await L.put(L.MEDIA, media.id, media);
        msg.voice = { id: media.id, dur: voice.dur };
      }
      await L.put(L.msgKind(id), msg.id, msg);

      conv.unread = conv.unread || {};
      const before = conv.unread[a.other] || 0;
      conv.unread[a.other] = before + 1;
      conv.unread[user.id] = 0;
      conv.lastAt = msg.at;
      conv.lastFrom = user.id;
      conv.lastText = text ? text.slice(0, 140) : "Voice message (" + fmtDur(msg.voice.dur) + ")";
      await L.put(L.CONVS, id, conv);

      // One email per batch of unread messages, so a busy chat doesn't flood anyone's inbox.
      let emailed = false;
      const watching = conv.readAt && conv.readAt[a.other] > Date.now() - 120000;
      if (before === 0 && !watching && L.mailOn()) {
        const other = await L.get(L.USERS, a.other);
        if (other) {
          emailed = await L.sendMail(other.email, "New message from " + user.name + " on Saathi", [
            "Hi " + other.name + ",",
            user.name + " sent you a message about the ride " + tripLine(a.ride) + ":",
            text ? "“" + text.slice(0, 300) + "”" : "A voice message (" + fmtDur(msg.voice.dur) + ").",
          ], { url: L.siteUrl(req) + "/#chat=" + id, label: "Reply in Saathi" });
        }
      }
      return L.send(res, 201, { message: out(msg, user.id), emailed });
    }
    return L.fail(res, 405, "method", "Use GET or POST.");
  } catch (e) {
    return L.fail(res, 502, "store_unreachable", "Couldn't send just now. Check your connection and try again.");
  }
};
