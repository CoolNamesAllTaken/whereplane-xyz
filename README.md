# whereplane-xyz
Infrastructure for whereplane.xyz, an online ADS-B aggregator intended to support the ADSBee project.

## globe: readsbee

`globe` runs [readsbee](https://github.com/PantsForBirds/readsbee): ultrafeeder with a readsb fork
that filters Beast feeds by feeder UUID. Loopback (mlathub) is exempt.

- Policy: `${FEEDER_POLICY_DIR:-/home/bird/feeder-policy}` (`policy.so`, `readsbee.conf`), built from
  the private PantsForBirds/internal repo. globe won't start without it.
- `feeders/allow.txt`: extra UUIDs allowed. `feeders/deny.txt`: UUIDs blocked.
  One per line, `#` comments, picked up within 2 s. Not in git: the website's staff page (`web/`) writes
  them. Create them once from the examples (a missing list counts as empty):
  `for f in allow deny; do cp -n feeders/$f.txt.example feeders/$f.txt; done`
- Status for staff: `readsbee.json` in `${READSBEE_STATUS_DIR:-/opt/readsbee-status}` on the host (no IPs,
  not served by globe). The website (`web/`) mounts it read-only: its feeder list and its staff page.
- Website: `web/` (its own compose project, see `web/README.md`).
- `/data/clients.json` (feeder IPs) returns 404 (`nginx/08-private-data`).
- ADS-L aircraft and Remote ID drones from `READSBEE` feeds show on the globe. `--readsbee-rid-globe`: drones as
  aircraft; `--readsbee-rid-operator`: operator ID and location in public outputs (`/data/remoteid.json`).
  Drone icon, Remote ID panel and operator marker: `drone/` (see `drone/README.md`).

### Rollback

Back to stock ultrafeeder + readsb WITH_UUIDS (the `Dockerfile` in this repo):

```
# compose.yml, service globe: replace the `image:` line with `build: .`
# and drop the five --net-uuid-* lines from READSB_EXTRA_ARGS
docker compose build --pull globe && docker compose up -d globe
```

State in `/opt/ultrafeeder` is the same format either way.

Back to readsbee phase 1 (no ADS-L / Remote ID): `image: ghcr.io/pantsforbirds/readsbee:sha-2cd8e7c@sha256:116b024f749cc72973a762d96d1a1685ef600ddfe95b38918972859c6f979ad2`
and drop `--readsbee-rid-globe --readsbee-rid-operator`. The `drone/` mounts can stay (nothing to show).
