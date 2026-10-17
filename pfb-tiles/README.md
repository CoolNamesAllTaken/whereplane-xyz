# pfb-tiles

Static vector basemap tiles for the faint map behind the live air traffic on pantsforbirds.com.

    https://globe.whereplane.xyz/pfb-tiles/v2/{z}/{x}/{y}.pbf      tiles (gzip-compressed MVT)
    https://globe.whereplane.xyz/pfb-tiles/v2/tiles.json           TileJSON, attribution

v1 (z4–z10, contiguous US) stays published, unchanged. v2 is the whole world at z0–z9, plus z10 where
whereplane's stations are (`z10-v2.poly`: the contiguous US, central Europe, the Balkans, Britain and
Ireland, Anchorage, Hawaii).

- OpenMapTiles schema, trimmed: `water` (class), `waterway` (class river/canal), `transportation`
  (class motorway/trunk/primary, no ramps), `boundary` (admin_level <= 4, maritime). No labels, no POIs.
- v1: z4–z10, contiguous US plus a margin. v2: z0–z9 worldwide, z10 inside `z10-v2.poly`. A tile with
  nothing in it, or outside the coverage, is 204.
- Attribution: **© OpenStreetMap contributors, OpenMapTiles**.

## How it is served

- `pfb-tiles` (compose.yml) is a read-only `nginx:alpine` serving `${PFB_TILES_DIR}`
  (default `/home/bird/pfb-tiles-t0530/tiles`, holding `v1/…`) with `pfb-tiles/nginx.conf`:
  `Content-Encoding: gzip`, `Access-Control-Allow-Origin: *`, a year's immutable cache on tiles.
  It publishes no port.
- globe's nginx proxies `/pfb-tiles/` to it (`globe-proxy.conf`). `07-pfb-tiles` runs at globe's
  startup, after `07-nginx-configure`, and adds the include to tar1090's nginx site. It never fails,
  and the upstream is resolved per request: if pfb-tiles is down, only `/pfb-tiles/` answers 502.

## Rebuild or update

`build.sh v2` (on a build machine, not here) downloads the Geofabrik US extract, runs planetiler's
OpenMapTiles profile (z4–z10, the US bounds) and `trim.py`, which keeps the layers, classes and
fields above at the protobuf level and writes gzip `z/x/y.pbf` plus `tiles.json`. `build-v2.sh` builds v2 from
the whole planet without ever holding it: it downloads the Geofabrik continents in `continents-v2.txt`
two at a time (waiting while that would leave less than 60 GB free), cuts each with `osmium tags-filter`
to the objects these layers use and deletes it, merges the results, and runs planetiler twice (world
z0–z9; z10 on an `osmium extract` of `z10-v2.poly`). To give another place z10, add its box to
`z10-v2.poly` and publish the result as v3. Publish a new
build under a new version next to the old one, then switch the site's URL to it. Never change files
under a published version, since they are cached for a year.

    rsync -a pfb-build/tiles/v2/ bird@whereplane.server:pfb-tiles-t0530/tiles/v2/

## Remove

    docker compose stop pfb-tiles && docker compose rm -f pfb-tiles

Then drop the `pfb-tiles` service, the two globe volumes and this folder, and `docker compose up -d`
(this recreates globe without the proxy). Finally delete `/home/bird/pfb-tiles-t0530`.
