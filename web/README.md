# whereplane.xyz web

The whereplane.xyz website: home, coverage map, feeder list, a page per feeder, staff page.
Django + Postgres behind Caddy, plus a collector that reads the live readsb. Its own compose project (`whereplane-web`), deployed separately from the `globe` stack in
the repository root. Same shape as PantsForBirds/adsbee-aero.

| URL | Contents |
|---|---|
| `/` | What whereplane is, live numbers, coverage preview, "feed with your ADSBee" |
| `/coverage/` | Coverage by altitude band, 3D slabs or flat, click a cell → its feeders |
| `/feeders/` | Every feeder: ● online / ○ offline, msgs/s, aircraft now, range, last seen |
| `/feeder/<uuid>/` | Status, uptime, rates, aircraft, range per band, 24h/7d/30d charts, its coverage, globe link |
| `/staff/` | Superusers: allow/deny lists, what readsbee rejected or flagged, rename/hide feeders |
| `/admin/` | Django admin (sign-in for `/staff/` too) |
| `/api/live.json`, `/api/coverage.json`, `/api/cell.json`, `/api/network.json`, `/api/feeder/<uuid>/series.json` | What the pages draw |

## Architecture

```
browser -> birdbox nginx :443 (TLS) -> whereplane.server:8190 -> caddy (web)
             caddy  -> site (Django, gunicorn, whitenoise) -> db (Postgres)
collector (same image) -> http://host.docker.internal:80 (globe: tar1090 nginx -> readsb), read-only
site -> ${WHEREPLANE_FEEDERS_DIR}/allow.txt, deny.txt  (read by readsbee)
```

## Data: how per-feeder numbers are measured

readsb (wiedehopf, built `WITH_UUIDS=yes`) keeps, per aircraft, the receiver UUIDs that sent it a
position in the last minute (for aircraft without an ADS-B position: any message). Its API answers
`/re-api/?all&filter_uuid=<uuid>` with the aircraft that receiver fed in the last 2 × json_interval
(2 s). Nothing else in stock readsb maps aircraft to receivers: aircraft.json has no receiver IDs
unless built with `PRINT_UUIDS`, and `TRACKS_UUID` only keeps the last one.

So the collector (`feeders/collector.py`, `python manage.py collect`), every 10 s:

1. `GET /data/clients.json`: one row per connection; summed per UUID (msgs/s, positions/s,
   kbit/s, connection time). The address column is never stored.
2. `GET /data/stats.json`: network aircraft, messages/s, positions/s.
3. Per connected feeder, `GET /re-api/?all&filter_uuid=<uuid>`: its aircraft. Each aircraft with
   a direct ADS-B position (`adsb_icao`, `adsb_icao_nt`, `adsb_other`; not TIS-B/ADS-R, which
   ground stations rebroadcast, nor MLAT) less than 5 s old adds a hit to its 0.1° cell in its
   altitude band (ground, <1k, 1–3k, 3–10k, 10–20k, 20–30k, 30k+ ft, barometric).

Every minute: feeders' live state and coverage cells (upsert: last seen, hits). Every 5 min:
samples for the charts and distinct aircraft per day. Hourly: pruning (cells 31 d, samples 35 d)
and each feeder's rough location (hit-weighted middle of its low-altitude cells), used only to
measure range per band and never shown.

It is a sample: a feeder's coverage fills in over minutes, which is what the map needs. With 69
feeders a round is 71 requests and about 0.25 s; the load on whereplane.server is in the PR.

**What readsbee could export instead** (cheaper and exact): a per-receiver coverage file, e.g.
`/run/readsb/coverage.json` rewritten every 60 s:

```json
{"now": 1793919125, "cell_deg": 0.1,
 "bands_ft": [null, 1000, 3000, 10000, 20000, 30000],
 "receivers": {"bee0003c-a8bd-5d38-bee0-003ca8bd5d38": {
     "cells": [[lat_i, lon_i, band, positions], ...],
     "aircraft": 34, "positions": 2312, "messages": 12904}}}
```

counting every accepted direct ADS-B position (after CPR/speed checks) per receiver since the last
write, `lat_i = floor((lat + 90) / cell_deg)`, `lon_i = floor((lon + 180) / cell_deg)`, band 0 =
on the ground. The collector would then read one file per minute instead of 70 API calls per 10 s.
Later: ADS-L, Remote ID and UAT counts per receiver in the same file (the feeder page has slots).

## Allow / deny lists

`/staff/` and the admin write `allow.txt` and `deny.txt` in `WHEREPLANE_FEEDERS_DIR` (compose
default `../feeders`, the repository root's `feeders/`): a comment header, then one UUID per line
with an optional `# note`. Each change rewrites both files by temp file + rename, so readsbee never
reads half a file; mount the folder into `globe`, not the single files. The database is the source:
hand edits to the files are overwritten. Keep the two files out of git (generated).

Which feeders are accepted is readsbee's decision; this site doesn't judge IDs. readsbee writes `readsbee.json`
to its `--net-uuid-status-dir` every 10 s (rejected UUIDs with reason and connections, per-receiver state and reuse
flags; no addresses). Bind that folder into the web stack read-only (`WHEREPLANE_READSBEE_STATUS_DIR`, default
`/opt/readsbee-status`, mounted at `/readsbee-status`). `/staff/` shows rejected and flagged feeders from it, with allow /
deny buttons; public pages never show it. A missing file shows as "no readsbee status".

## Run it

```sh
cp .env.whereplane.sample .env.whereplane     # fill in the secret key and DB password
ln -s .env.whereplane .env                    # compose reads .env for the ${...} in compose.yml
docker compose up -d --build
docker compose exec site python manage.py createsuperuser
docker compose --profile test run --rm --build site-test     # tests, against Postgres
```

Tests without docker: `cd python/whereplane_web && pip install -r ../requirements.txt -r ../requirements-dev.txt && pytest` (SQLite).

Settings (`.env.whereplane`): `DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS`,
`DJANGO_CSRF_TRUSTED_ORIGINS`, `WHEREPLANE_HTTPS_ONLY` (0 for a plain-http preview),
`POSTGRES_*`, `WHEREPLANE_HTTP_BIND` / `WHEREPLANE_HTTP_PORT` (default 127.0.0.1:8190), `WHEREPLANE_TRUSTED_PROXIES`
(whose X-Forwarded-For Caddy believes),
`WHEREPLANE_READSB_URL`, `WHEREPLANE_POLL_SECONDS`, `WHEREPLANE_FEEDERS_DIR`,
`WHEREPLANE_READSBEE_STATUS_DIR` (host folder mounted read-only at /readsbee-status).

## Going live (needs the admin's OK)

1. Deploy this stack on whereplane.server with `WHEREPLANE_HTTP_BIND` set to its LAN address and
   `WHEREPLANE_TRUSTED_PROXIES` to birdbox's (nginx there already proxies globe.whereplane.xyz to
   whereplane.server:80), `WHEREPLANE_HTTPS_ONLY=1`.
2. Point `birdbox-docker/nginx/whereplane.xyz.conf` for whereplane.xyz / www at it instead of
   WordPress.
3. When readsbee replaces `globe`, mount the same `feeders/` folder into it.

## Look

pantsforbirds.com's (PantsForBirds/wordPRess, `pfb-storefront`): its tokens, forest header and footer with the green
band, yellow links, the dark hero with the yellow stats bar, Source Sans. Behind the header, the home hero and the
footer runs the theme's live traffic map, `static/feeders/js/site-traffic.js`, ported from the theme's
`assets/js/site-traffic.js` (aircraft from globe.whereplane.xyz's `/re-api/` over the faint pfb-tiles v2 map; still frame
for reduced motion, pauses offscreen). The coverage map draws the same pfb-tiles v2 vector tiles (z0-z9; z10 near the
stations is not used, so every zoom overzooms z9).

Vendored, no CDN: MapLibre GL 6.14 (BSD-3), uPlot 1.6.32 (MIT) copied from adsbee-aero, Source Sans 3 (OFL,
@fontsource-variable/source-sans-3 5.2.8). Coverage colors: tar1090's altitude colors at each band's middle (`--band-*` in site.css), as on the globe and adsbee.aero's range maps.
