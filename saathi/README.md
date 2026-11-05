# Saathi

Share car and bike rides: find a seat going your way, book it, or offer your own free seat.

- `index.html` is the whole site.
- `api/` has three small serverless functions (`state`, `rides`, `bookings`) that store rides in Upstash Redis.
- No build step and no dependencies.

## Deploy to Vercel

**From GitHub:** push this folder to a GitHub repo, open https://vercel.com/new, pick the repo and click **Import**, then **Deploy**. Leave every setting as it is (Framework Preset: Other).

**From your computer:** open a terminal in this folder and run

```
npx vercel --prod
```

Log in when it asks and accept the defaults.

## Turn on shared rides (one time)

Until storage is connected the site still works, but rides are saved on each visitor's device only, and the page says so.

1. In Vercel, open the project, then **Storage**, then **Create Database**, and choose **Upstash for Redis**. The free plan is enough.
2. Connect it to this project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
3. Open **Deployments**, then **Redeploy** the latest one.

`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` work too, if you set the variables yourself.

## How it works

- Each browser gets a random key, saved in that browser. The server stores only a hash of it. That hash is how Saathi knows which rides and bookings are yours, so only you can cancel them.
- Passenger names are shown only to that passenger and to the driver.
- Clearing site data in the browser means losing control of the rides and bookings made from it. There are no accounts yet.
- To hide the sample listings, set `SHOW_SAMPLES = false` near the top of the script in `index.html`.
