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
- **Alternative number:** in their profile, passengers can add a family member's or friend's number, with a checkbox **Send my live location and driver details to this number on WhatsApp** (on by default). When a seat is confirmed, that number gets the driver's name, number and vehicle, the route and time, and a **live trip link**:
  - automatically on WhatsApp, if WhatsApp is set up (see below);
  - otherwise automatically by SMS, if SMS is set up;
  - and always with one tap: the ride shows **WhatsApp** and **SMS** buttons that open with the message ready. The confirmation email has the same WhatsApp link.

  Unticking the checkbox stops all of this.
- **Live trip link** (`/#live=…`): opens without an account and shows that passenger's trip on a map: the driver's live location and photo, name, number (with Call and WhatsApp), vehicle, route and arrival time, plus the passenger's own live location while they share it. The link is signed, so it can't be guessed, and it shows nothing once the seat or ride is cancelled or the trip is over.

## When a driver cancels

Everyone who asked for a seat sees the ride as cancelled. At the top of **My trips** and on the ride itself, Saathi suggests up to 3 other rides on the same route that still have enough free seats. A ride counts as the same route when its pickup and drop are within 25 km of the cancelled ride's, on the same day or a day either side. Women-only rides are suggested only to women. If email is set up, the same suggestions arrive by email, each with a link that opens that ride.

## Live location

- **Only while the ride is confirmed.** The driver sees **Share live location** once at least one rider's seat is confirmed; a rider sees it while their own seat is confirmed. It's offered from 6 hours before departure until 3 hours after the expected arrival. Sharing stops by itself if the ride is cancelled, the rider cancels their seat, the last confirmed rider cancels, or the trip is over.
- **Riders** follow the driver on a map, like a ride app: the vehicle moves along the road route to them, with an arrow for the direction it's heading, "Ravi is 2.4 km away", the minutes until pickup and a progress bar. After pickup it shows the distance and arrival time at the destination. A rider can tap **Share my location** so the driver can find them, and so their family contact's link shows where they are.
- **The driver** sees every confirmed rider on the same map, each with their photo or initials, how far away they are, and Call and WhatsApp buttons. The route goes to the nearest rider still waiting, then to the destination. Riders who don't share show as "Not sharing location".
- Riders get an email when the driver starts sharing, if email is set up.
- Only the latest position of each person is stored, never a route history. The driver's is visible to confirmed riders and their family links; a rider's is visible only to the driver and that rider's family link. Positions are deleted when the person taps **Stop**, cancels, or the ride is cancelled.
- Browsers pause location in background tabs, so keep Saathi open on screen while sharing. The app keeps the screen awake, picks sharing up again by itself when Saathi is reopened (if location is already allowed), and otherwise shows a **Resume** button.
- The map uses Leaflet with OpenStreetMap tiles, and the road routes and times come from OSRM. Both are free community services for light use. If Saathi gets busy, switch to a hosted tile and routing plan.

## Messages

- A passenger can message the driver of any ride, before or after asking for a seat. A driver can message anyone who asked for a seat on their ride. Each ride plus passenger is its own chat.
- Text and voice messages, and photos and PDFs (paperclip button, up to 2 MB). Tap the mic, speak (up to a minute), then tap send. Voice is recorded in the browser at about 32 kbps, so a minute is about 240 KB.
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

## SMS (free, sent from your own Android phone)

No SMS or WhatsApp company sends to Indian numbers for free. The free option is **SMS Gateway for Android** (open source, https://sms-gate.app). It sends texts from an Android phone's own SIM, and most Indian plans include 100 free SMS a day.

When SMS is set up, Saathi texts:
- the driver, when someone asks for a seat;
- the passenger, when the driver confirms, with the driver's number;
- the passenger's **alternative number**, when the seat is confirmed, with the route, time, the driver's name, number and vehicle, and the live trip link (only if WhatsApp isn't set up or didn't go through, and only if the passenger left the checkbox on);
- the passenger, if the driver cancels, with a link to another ride on the same route.

Setup:
1. On an Android phone with a SIM that has SMS, install **SMS Gateway for Android** from the Play Store (or from https://github.com/capcom6/android-sms-gateway).
2. Open it, choose **Cloud server**, and turn it on. The **Home** tab shows a **username** and **password**.
3. In Vercel, open **Settings → Environment Variables** and add `SMSGATE_USER` and `SMSGATE_PASS` with those values. Then redeploy.
4. Keep that phone on, charged and online. Messages are sent from its number.

If you run your own SMS Gateway server, also set `SMSGATE_URL` (the default is `https://api.sms-gate.app/3rdparty/v1`).

## WhatsApp (optional, sends the live trip link with no tap)

Without this, passengers send their family contact the trip on WhatsApp with one tap, which is free. To send it automatically, Saathi uses Meta's **WhatsApp Cloud API**. WhatsApp only lets a business start a chat with a message template that Meta has approved, and Meta charges a small fee per message to Indian numbers (check Meta's current WhatsApp pricing). The test number Meta gives you is free and can send to up to 5 numbers you add.

1. At https://developers.facebook.com create an app of type **Business** and add the **WhatsApp** product.
2. Under **WhatsApp → API Setup**, note the **Phone number ID**. For testing, add your own number as a recipient there.
3. Create a permanent access token: in Meta **Business Settings → System users**, add a system user, give it the app, and generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`.
4. In **WhatsApp Manager → Message templates**, create a template named `saathi_trip`, category **Utility**, language **English**, with this body (six variables, in this order):

   ```
   Saathi trip update.
   {{1}} is travelling with Saathi.
   Driver: {{2}}, phone {{3}}
   Vehicle: {{4}}
   Trip: {{5}}
   Follow the live location here: {{6}}
   You get this because they added your number as their trusted contact on Saathi.
   ```
   Wait for Meta to approve it.
5. In Vercel, add `WHATSAPP_TOKEN` (the token) and `WHATSAPP_PHONE_ID` (the phone number ID), then redeploy. If your template has another name or language code, also set `WHATSAPP_TEMPLATE` and `WHATSAPP_LANG` (default `en`). `WHATSAPP_API_VERSION` defaults to `v23.0`.

If a WhatsApp message fails, Saathi sends the same details by SMS when SMS is set up.

## Checking email, SMS and WhatsApp

The site owner's profile shows a **Notifications** card with a **Send test** button for email, SMS and WhatsApp. The WhatsApp test sends the `saathi_trip` template to the owner's own number. If a test fails, the card shows the error the mail, SMS or WhatsApp server gave. The owner is the account whose email matches `ADMIN_EMAIL`, or `MAIL_FROM` if `ADMIN_EMAIL` isn't set.

## UPI payments

- When a driver uploads their UPI QR on **Offer a ride**, Saathi reads the UPI ID from it, in the browser, and fills in the **UPI ID** field. Drivers can also type the ID.
- Once a seat is confirmed, the passenger sees **Pay ₹… by UPI** with GPay, PhonePe, Paytm, BHIM and Other buttons. Each opens that app with the driver's UPI ID and the amount already filled in. On Android, tapping the QR opens the phone's list of all UPI apps.
- Some UPI apps limit payments to personal UPI IDs that start from a link. If that happens, the passenger can scan the QR or pay to the UPI ID shown.

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
