# Saathi

Share car and bike rides: find a seat going your way, book it, or offer your own free seat. Installable as an app (PWA) and opens offline.

- `index.html` is the whole site.
- `api/` has three small serverless functions (`state`, `rides`, `bookings`) that store rides in Postgres (Supabase, Neon) or Upstash Redis.
- `manifest.webmanifest`, `sw.js` and `icons/` make it installable and let it open offline.
- No build step. The only dependency is `pg`, for Postgres.

## Deploy to Vercel

Import the repo at https://vercel.com/new, set **Root Directory** to the folder that holds this file, keep the preset on **Other**, and deploy. Every push to `main` redeploys.

## Shared rides

Connect a database under the project's **Storage** tab, then redeploy:

- **Supabase or Neon (Postgres):** uses `POSTGRES_URL`. On first use the API creates a table `saathi.items` in its own `saathi` schema, with row-level security on, so it stays out of Supabase's public REST API.
- **Upstash for Redis:** uses `KV_REST_API_URL` and `KV_REST_API_TOKEN`. If both are set, Redis is used.

Without a database the site still works, but rides are saved on each visitor's device only. A free Supabase project pauses after a week without activity; open its dashboard to wake it.

## Location features (free, no keys)

- **Place search** for anywhere in India uses Photon (https://photon.komoot.io), built on OpenStreetMap.
- **Use my location** asks the browser for your position and turns it into a place name with Photon. It only runs when you tap the location button.
- **Road distance and time** for new rides come from the public OSRM server (https://router.project-osrm.org).
- **Nearest to me** sorts rides by how far their pickup is from you.

These are free community services meant for light use. If Saathi gets busy, move to a hosted plan or your own Photon/OSRM server by changing `GEO` near the top of the script in `index.html`. Map data © OpenStreetMap contributors.

## Install as an app

- **Android / Chrome / Edge:** tap **Install app** in the header, or use the browser menu.
- **iPhone / iPad:** in Safari, tap Share, then **Add to Home Screen**.

## How it works

- Each browser gets a random key, saved in that browser. The server stores only a hash of it. That hash is how Saathi knows which rides and bookings are yours, so only you can cancel them.
- Passenger names are shown only to that passenger and to the driver.
- Offline, the app shows the rides from your last visit. Booking and posting need a connection.
- To hide the sample listings, set `SHOW_SAMPLES = false` near the top of the script in `index.html`.
