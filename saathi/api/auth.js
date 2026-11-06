// GET  /api/auth                       who is signed in
// POST /api/auth {action:"signup"}     create an account and sign in
// POST /api/auth {action:"login"}      sign in
// POST /api/auth {action:"logout"}     sign out
// POST /api/auth {action:"profile"}    update name, phone, gender, about
// POST /api/auth {action:"password"}   change password (signs out other devices)
// POST /api/auth {action:"forgot"}     email a reset link (needs email set up)
// POST /api/auth {action:"reset"}      set a new password from that link
const crypto = require("crypto");
const L = require("./_lib");

const GENDERS = ["female", "male", "other"];
const LOCK_AFTER = 8;
const LOCK_MIN = 15;
const RESET_MIN = 30;

const features = (u) => ({ email: L.mailOn(), sms: L.smsOn(), wa: L.waOn(), admin: L.isAdmin(u) });
const okPassword = (p) => typeof p === "string" && p.length >= 8 && p.length <= 100;

function readProfile(b, base) {
  const out = {};
  if (b.name !== undefined || !base) {
    const name = L.str(b.name, 40);
    if (name.length < 2) return [null, "Add your name (at least 2 letters)."];
    out.name = name;
  }
  if (b.phone !== undefined || !base) {
    const phone = L.normPhone(b.phone);
    if (!phone) return [null, "Add a 10-digit Indian mobile number. Riders use it to reach you on WhatsApp once a seat is confirmed."];
    out.phone = phone;
  }
  if (b.gender !== undefined) out.gender = GENDERS.includes(b.gender) ? b.gender : "";
  if (b.bio !== undefined) out.bio = L.text(b.bio, 200);
  // A family member or friend who can be sent the trip details once a seat is confirmed.
  if (b.altPhone !== undefined) {
    const raw = String(b.altPhone || "").trim();
    if (!raw) out.altPhone = "";
    else {
      const alt = L.normPhone(raw);
      if (!alt) return [null, "The alternative number needs to be a 10-digit Indian mobile number."];
      if (alt === (out.phone || (base && base.phone))) return [null, "Use someone else's number as the alternative number, not your own."];
      out.altPhone = alt;
    }
  }
  if (b.altName !== undefined) out.altName = L.str(b.altName, 30);
  // Send that contact the driver's details and a live trip link when a seat is confirmed (on unless turned off).
  if (b.altShare !== undefined) out.altShare = b.altShare !== false;
  return [out, null];
}

async function userByEmail(email) {
  const link = email && (await L.get(L.EMAILS, email));
  return link ? L.get(L.USERS, link.userId) : null;
}

module.exports = async (req, res) => {
  if (!L.hasStore()) return L.fail(res, 503, "no_store", "Saathi isn't connected to its database yet.");
  try {
    if (req.method === "GET") {
      const u = await L.currentUser(req);
      return L.send(res, 200, { user: L.publicUser(u), features: features(u) });
    }
    if (req.method !== "POST") return L.fail(res, 405, "method", "Use GET or POST.");
    if (!L.jsonOnly(req, res)) return;
    const b = await L.readBody(req);
    const action = String(b.action || "");

    if (action === "signup") {
      const email = L.normEmail(b.email);
      if (!email) return L.fail(res, 400, "invalid", "Add a valid email address.");
      const [prof, err] = readProfile(b, null);
      if (err) return L.fail(res, 400, "invalid", err);
      if (!okPassword(b.password)) return L.fail(res, 400, "invalid", "Use a password of at least 8 characters.");
      const id = L.newId();
      if (!(await L.putNew(L.EMAILS, email, { userId: id }))) {
        return L.fail(res, 409, "taken", "An account with this email already exists. Log in instead.");
      }
      const { salt, hash } = L.hashPassword(b.password);
      const user = Object.assign({ id, email, gender: "", bio: "", salt, hash, ver: 1, createdAt: Date.now() }, prof);
      try { await L.put(L.USERS, id, user); } catch (e) { await L.del(L.EMAILS, email).catch(() => {}); throw e; }
      L.setSession(res, user);
      return L.send(res, 201, { user: L.publicUser(user), features: features(user) });
    }

    if (action === "login") {
      const email = L.normEmail(b.email);
      const user = await userByEmail(email);
      const wrong = () => L.fail(res, 401, "wrong", "That email and password don't match.");
      if (!user || typeof b.password !== "string") return wrong();
      if (user.lockUntil && user.lockUntil > Date.now()) {
        const mins = Math.ceil((user.lockUntil - Date.now()) / 60000);
        return L.fail(res, 429, "locked", "Too many tries. Try again in " + mins + (mins === 1 ? " minute." : " minutes."));
      }
      if (!L.checkPassword(b.password, user)) {
        user.failCount = (user.failCount || 0) + 1;
        if (user.failCount >= LOCK_AFTER) { user.lockUntil = Date.now() + LOCK_MIN * 60000; user.failCount = 0; }
        await L.put(L.USERS, user.id, user);
        return wrong();
      }
      if (user.failCount || user.lockUntil) { user.failCount = 0; user.lockUntil = 0; await L.put(L.USERS, user.id, user); }
      L.setSession(res, user);
      return L.send(res, 200, { user: L.publicUser(user), features: features(user) });
    }

    if (action === "logout") {
      L.clearSession(res);
      return L.send(res, 200, { user: null, features: features(null) });
    }

    if (action === "forgot") {
      if (!L.mailOn()) return L.fail(res, 501, "no_email", "Password reset by email isn't set up on this site yet.");
      const user = await userByEmail(L.normEmail(b.email));
      // Same answer whether or not the account exists.
      if (user) {
        const token = crypto.randomBytes(24).toString("base64url");
        user.resetHash = crypto.createHash("sha256").update(token).digest("hex");
        user.resetUntil = Date.now() + RESET_MIN * 60000;
        await L.put(L.USERS, user.id, user);
        await L.sendMail(user.email, "Reset your Saathi password", [
          "Hi " + user.name + ",",
          "Someone asked to reset the password for your Saathi account. The link below works for " + RESET_MIN + " minutes.",
          "If it wasn't you, ignore this email and your password stays the same.",
        ], { url: L.siteUrl(req) + "/#reset=" + user.id + "." + token, label: "Set a new password" });
      }
      return L.send(res, 200, { ok: true });
    }

    if (action === "reset") {
      const [uid, token] = String(b.token || "").split(".");
      const user = uid && token ? await L.get(L.USERS, uid) : null;
      const valid = user && user.resetHash && user.resetUntil > Date.now() &&
        crypto.createHash("sha256").update(token).digest("hex") === user.resetHash;
      if (!valid) return L.fail(res, 400, "expired", "This reset link has expired or was already used. Ask for a new one.");
      if (!okPassword(b.password)) return L.fail(res, 400, "invalid", "Use a password of at least 8 characters.");
      Object.assign(user, L.hashPassword(b.password), { ver: (user.ver || 1) + 1, resetHash: "", resetUntil: 0, failCount: 0, lockUntil: 0 });
      await L.put(L.USERS, user.id, user);
      L.setSession(res, user);
      return L.send(res, 200, { user: L.publicUser(user), features: features(user) });
    }

    // The rest need a signed-in user.
    const user = await L.currentUser(req);
    if (!user) return L.fail(res, 401, "signed_out", "Log in to do this.");

    if (action === "profile") {
      const [prof, err] = readProfile(b, user);
      if (err) return L.fail(res, 400, "invalid", err);
      Object.assign(user, prof);
      await L.put(L.USERS, user.id, user);
      return L.send(res, 200, { user: L.publicUser(user), features: features(user) });
    }

    if (action === "password") {
      if (typeof b.current !== "string" || !L.checkPassword(b.current, user)) return L.fail(res, 400, "wrong", "Your current password isn't right.");
      if (!okPassword(b.password)) return L.fail(res, 400, "invalid", "Use a new password of at least 8 characters.");
      Object.assign(user, L.hashPassword(b.password), { ver: (user.ver || 1) + 1 });
      await L.put(L.USERS, user.id, user);
      L.setSession(res, user);
      return L.send(res, 200, { user: L.publicUser(user), features: features(user) });
    }

    // Setup checks for the site owner: send a test email, SMS or WhatsApp to themselves and report the real error.
    if (action === "testmail" || action === "testsms" || action === "testwa") {
      if (!L.isAdmin(user)) return L.fail(res, 403, "not_admin", "Only the site owner can run this check.");
      if (action === "testwa") {
        if (!L.waOn()) return L.fail(res, 501, "no_wa", "WhatsApp isn't set up. Add WHATSAPP_TOKEN and WHATSAPP_PHONE_ID in Vercel, then redeploy.");
        if (!user.phone) return L.fail(res, 400, "no_phone", "Add your mobile number to your profile first.");
        const ok = await L.sendWhatsApp(user.phone, [user.name, "Test Driver", user.phone, "White Swift Dzire", "Noida to Agra, test trip", L.siteUrl(req) + "/#find"]);
        return ok ? L.send(res, 200, { ok: true, message: "Test WhatsApp sent to " + user.phone + ". It should arrive in a few seconds." })
          : L.fail(res, 502, "wa_failed", "The WhatsApp message didn't go out. " + (L.waError() || "No reason was given."));
      }
      if (action === "testmail") {
        if (!L.mailOn()) return L.fail(res, 501, "no_email", "Email isn't set up. Add SMTP_USER, SMTP_PASS and MAIL_FROM in Vercel, then redeploy.");
        const ok = await L.sendMail(user.email, "Saathi test email", ["Hi " + user.name + ",", "Email from Saathi is working. Riders and drivers will get booking emails like this one."]);
        return ok ? L.send(res, 200, { ok: true, message: "Test email sent to " + user.email + ". Check your inbox and the spam folder." })
          : L.fail(res, 502, "mail_failed", "The email didn't go out. " + (L.mailError() || "No reason was given."));
      }
      if (!L.smsOn()) return L.fail(res, 501, "no_sms", "SMS isn't set up. Add SMSGATE_USER and SMSGATE_PASS in Vercel, then redeploy.");
      if (!user.phone) return L.fail(res, 400, "no_phone", "Add your mobile number to your profile first.");
      const ok = await L.sendSms(user.phone, "Saathi test SMS: automatic messages are working.");
      return ok ? L.send(res, 200, { ok: true, message: "Test SMS queued for " + user.phone + ". It's sent from the phone running SMS Gateway." })
        : L.fail(res, 502, "sms_failed", "The SMS didn't go out. " + (L.smsError() || "No reason was given."));
    }

    return L.fail(res, 400, "action", "Unknown action.");
  } catch (e) {
    return L.fail(res, 502, "store_unreachable", "Couldn't reach the server just now. Check your connection and try again.");
  }
};
