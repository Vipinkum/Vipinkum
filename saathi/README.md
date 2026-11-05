# Saathi

Share car and bike rides. Find a seat going your way and ask the driver for it, or offer your own free seat. Installable as an app (PWA), and it opens offline.

- `index.html` is the whole site.
- `api/` has seven small serverless functions: `auth` (accounts), `state`, `rides`, `bookings`, `messages` (chat), `media` (photos, payment QR codes, voice messages) and `track` (live location). Data is stored in Postgres (Supabase, Neon) or Upstash Redis.
- `manifest.webmanifest`, `sw.js` and `icons/` make it installable and let it open offline.
- No build step. The dependencies are `pg` (Postgres) and `nodemailer` (email over SMTP).

## Deploy to Vercel

Import the repo at https://vercel.com/new, set **Root Directory** to the folder that holds this file, keep the preset on **Other**, and deploy. Every push to `main` redeploys.

## Database

Connect a database under the project's **Storage** tab, then redeploy:

- **Supabase or Neon (Postgres):** uses `POSTGRES_URL`. On first use the API creates a table `saathi.items` in its own `saathi` schema, with row-level security on, so it stays out of Supabase's public REST API.
- **Upstash for Redis:** uses `KV_REST_API_URL` and `KV_REST_API_TOKEN`. If both are set, Redis is used.

A free Supabase project pauses after a week without activity. Open its dashboard to wake it.

## Accounts and booking

- People create an account with name, email, mobile number and password. Gender is optional and only used for women-only rides.
- Passwords are stored as scrypt hashes. The login is a signed, HttpOnly cookie that lasts 30 days. Changing or resetting a password logs out other devices. After 8 wrong passwords an account is locked for 15 minutes.
- **A seat is only booked once the driver confirms it.** A request stays *waiting* until the driver taps Confirm or Decline in **My trips** or on the ride.
- Mobile numbers stay hidden until a seat is confirmed. Then the driver and passenger each see the other's number, with one-tap **WhatsApp** and **Call** buttons. WhatsApp opens with a message ready to send, at no cost.
- Women-only rides can be posted by women drivers and requested by women passengers.
- **Profile photo:** upload one from the profile page. It's cropped square and shrunk in the browser (about 30 KB), and it shows on ride cards, requests and chats.
- **Payment QR:** drivers can add their UPI QR code (from GPay, PhonePe or Paytm) when they offer a ride. It's remembered for next time. Only passengers whose seat is confirmed can see it, and they can save it to pay from their UPI app.
- **Alternative number:** in their profile, passengers can add a family member's or friend's number. Once a seat is confirmed, one tap sends that number the route, time, driver's name and number, and the vehicle, by WhatsApp or SMS from the passenger's phone. The confirmation email includes the same WhatsApp link. Sending it with no tap at all would need a paid SMS or WhatsApp Business service.

## When a driver cancels

Everyone who asked for a seat sees the ride as cancelled. At the top of **My trips** and on the ride itself, Saathi suggests up to 3 other rides on the same route that still have enough free seats. A ride counts as the same route when its pickup and drop are within 25 km of the cancelled ride's, on the same day or a day either side. Women-only rides are suggested only to women. If email is set up, the same suggestions arrive by email, each with a link that opens that ride.

## Live location

- On the day of the ride (from 6 hours before departure), the driver taps **Share live location** on their ride. Riders with a confirmed seat can then open **Live location** and follow the driver on a map, like a delivery app. They see how far away the driver is and about how long until pickup, then "at the pickup point", then the time left to the destination.
- Riders get an email when the driver starts sharing, if email is set up.
- Only the latest position is stored, never a route history. It's visible only to the driver and confirmed riders, and it disappears when the driver taps **Stop** or cancels the ride.
- Browsers pause location in background tabs, so the driver needs to keep Saathi open on screen while driving. The app keeps the screen awake while sharing, and shows a **Resume** button if Saathi was closed.
- The map uses Leaflet with OpenStreetMap tiles, and the travel times come from OSRM. Both are free community services for light use. If Saathi gets busy, switch to a hosted tile and routing plan.

## Messages

- A passenger can message the driver of any ride, before or after asking for a seat. A driver can message anyone who asked for a seat on their ride. Each ride plus passenger is its own chat.
- Text and voice messages. Tap the mic, speak (up to a minute), then tap send. Voice is recorded in the browser at about 32 kbps, so a minute is about 240 KB.
- New messages show up within a few seconds while a chat is open, and the **Messages** tab shows an unread count. If email is set up, the other person gets one email for a new message, unless they have the chat open.
- Only the two people in a chat can read it or play its voice messages.

Photos, QR codes and voice messages are stored in the same database. A free Supabase project has 500 MB, which is plenty for a small community. Each chat keeps up to 500 messages.

Optional: set `SESSION_SECRET` to a long random string to sign logins with a key of your own. Otherwise Supabase's `SUPABASE_JWT_SECRET` is used, or a key derived from the database URL.

## Email (free)

When email is set up, Saathi sends these messages:

- The driver gets an email for each new seat request.
- The passenger gets an email when the driver confirms (with the driver's number and WhatsApp link) or declines.
- Passengers get an email if the driver cancels the ride.
- The driver gets an email if a confirmed passenger cancels.
- Anyone who forgets their password gets a reset link by email.

Brevo's free plan sends 300 emails a day:

1. Create a free account at https://www.brevo.com and verify the email address you'll send from, under **Senders, Domains & IPs → Senders**.
2. Under **SMTP & API**, generate an **SMTP key** (or an API key).
3. In Vercel, open **Settings → Environment Variables** and add:
   - `SMTP_USER`: the SMTP login Brevo shows, which looks like `xxxx@smtp-brevo.com`
   - `SMTP_PASS`: the SMTP key
   - `MAIL_FROM`: the verified sender address
   - `MAIL_FROM_NAME`: `Saathi` (optional)

   Using an API key instead? Set `BREVO_API_KEY` in place of `SMTP_USER` and `SMTP_PASS`. Any other SMTP service also works if you set `SMTP_HOST` and `SMTP_PORT`, which default to Brevo's `smtp-relay.brevo.com` and `587`.
4. Redeploy.

Without email, everything still works. People see confirmations in **My trips** and use the WhatsApp buttons, and "Forgot password" is hidden.

## Location features (free, no keys)

- **Place search** for anywhere in India uses Photon (https://photon.komoot.io), built on OpenStreetMap.
- **Use my location** asks the browser for your position and turns it into a place name with Photon. It only runs when you tap the location button.
- **Road distance and time** for new rides come from the public OSRM server (https://router.project-osrm.org).
- **Nearest to me** sorts rides by how far their pickup is from you.

These are free community services meant for light use. If Saathi gets busy, move to a hosted plan or your own Photon/OSRM server by changing `GEO` near the top of the script in `index.html`. Map data © OpenStreetMap contributors.

## Install as an app

- **Android / Chrome / Edge:** tap **Install app** in the header, or use the browser menu.
- **iPhone / iPad:** in Safari, tap Share, then **Add to Home Screen**.

Offline, the app shows the rides from your last visit. Requests and posting need a connection.
