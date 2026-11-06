# whereplane-xyz
Infrastructure for whereplane.xyz, an online ADS-B aggregator intended to support the ADSBee project.

## globe: readsbee

`globe` runs [readsbee](https://github.com/PantsForBirds/readsbee): ultrafeeder with a readsb fork
that filters Beast feeds by feeder UUID. Loopback (mlathub) is exempt.

- Policy: `${FEEDER_POLICY_DIR:-/home/bird/feeder-policy}` (`policy.so`, `readsbee.conf`), built from
  the private PantsForBirds/internal repo. globe won't start without it.
- `feeders/allow.txt`: extra UUIDs allowed. `feeders/deny.txt`: UUIDs blocked.
  One per line, `#` comments, picked up within 2 s.
- Status for staff: `docker exec globe cat /run/readsbee/readsbee.json` (no IPs, not on the web).
- `/data/clients.json` (feeder IPs) returns 404 (`nginx/08-private-data`).

### Rollback

Back to stock ultrafeeder + readsb WITH_UUIDS (the `Dockerfile` in this repo):

```
# compose.yml, service globe: replace the `image:` line with `build: .`
# and drop the five --net-uuid-* lines from READSB_EXTRA_ARGS
docker compose build --pull globe && docker compose up -d globe
```

State in `/opt/ultrafeeder` is the same format either way.
