#!/bin/bash
# Build pfb-tiles/v2: the whole world at z0-z9, plus z10 where whereplane's stations are (z10-v2.poly: the contiguous
# US, central Europe, the Balkans, Britain and Ireland, Anchorage, Hawaii). Same layers and trimming as v1.
# Run on a build machine, not on whereplane. Needs Java 21, planetiler.jar, osmium-tool and python3.
# The Geofabrik continents (continents-v2.txt, about 90 GB) are downloaded two at a time, each cut with
# osmium tags-filter to what the layers use (about 5% is left), and deleted; a download waits until it fits
# with KEEP_FREE_MB (default 60000) still free. Peak disk ~60 GB (Europe and North America at once), then
# planetiler temp ~25 GB. On 7 CPUs: ~3-4 h of downloads (filtering overlaps), planetiler 46 min (world) + 8 min (z10).
# usage: build-v2.sh [workdir]
set -euo pipefail
work=${1:-$PWD/pfb-build}
here=$(cd "$(dirname "$0")" && pwd)
java=${JAVA:-java}
planetiler=${PLANETILER_JAR:-planetiler.jar}
osmium=${OSMIUM:-osmium}
python=${PYTHON:-python3}
export KEEP_FREE_MB=${KEEP_FREE_MB:-60000} SEGMENTS=${SEGMENTS:-8} work osmium
mkdir -p "$work/osm" "$work/data"

# Geofabrik's mirrors give one connection ~3 MB/s, so a file comes as SEGMENTS byte ranges in parallel, all pinned to
# its ETag (If-Range: a file replaced meanwhile answers 200, and the build stops).
download() {   # <url> <file>
    local url size etag step i
    url=$(curl -sIL -o /dev/null -w '%{url_effective}' "$1")
    size=$(curl -sI "$url" | awk 'tolower($1) == "content-length:" {print $2}' | tr -d '\r')
    etag=$(curl -sI "$url" | awk 'tolower($1) == "etag:" {print $2}' | tr -d '\r')
    step=$(( (size + SEGMENTS - 1) / SEGMENTS ))
    for i in $(seq 0 $((SEGMENTS - 1))); do
        segment "$url" "$etag" "$2.$i" $((i * step)) $(( (i + 1) * step - 1 < size - 1 ? (i + 1) * step - 1 : size - 1 )) &
    done
    wait
    : > "$2"
    for i in $(seq 0 $((SEGMENTS - 1))); do cat "$2.$i" >> "$2"; rm "$2.$i"; done
    [ "$(stat -c %s "$2")" -eq "$size" ] || { echo "$1: incomplete or changed during the download" >&2; return 1; }
}
# One byte range; a dropped connection (they do drop after half an hour or so) continues where it stopped.
segment() {   # <url> <etag> <file> <first byte> <last byte>
    local try got code
    for try in $(seq 1 60); do
        got=$(stat -c %s "$3" 2>/dev/null || echo 0)
        [ "$got" -eq $(($5 - $4 + 1)) ] && return 0
        code=$(curl -s --speed-limit 50000 --speed-time 60 -r $(($4 + got))-$5 -H "If-Range: $2" -o "$3.tmp" -w '%{http_code}' "$1")
        [ "$code" = 206 ] && cat "$3.tmp" >> "$3"
        rm -f "$3.tmp"
        [ "$code" = 200 ] && return 1   # the file was replaced: If-Range sent all of the new one
        sleep 5
    done
    return 1
}
export -f segment
export -f download

# 1. Each continent: download when there is room, keep water, rivers/canals, motorway/trunk/primary and boundaries of
#    admin level <= 4 (with the nodes and ways they use), delete the download.
fetch() {   # <id> <url> <MB>
    local n=$1 o=$work/osm
    [ -s "$o/$n.f.pbf" ] && return 0
    while true; do
        local free pending
        free=$(df -m --output=avail "$work" | tail -1)
        pending=$(cat "$o"/*.reserve 2>/dev/null | awk '{t += $1} END {print t + 0}')
        [ $((free - pending)) -gt $((KEEP_FREE_MB + $3 + 5000)) ] && break
        sleep 60
    done
    echo "$3" > "$o/$n.reserve"
    download "$2" "$o/$n.osm.pbf"
    rm -f "$o/$n.reserve"
    "$osmium" tags-filter "$o/$n.osm.pbf" \
        nwr/natural=water,bay nwr/waterway=riverbank,dock,river,canal nwr/landuse=reservoir,basin \
        w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link \
        r/admin_level=2,3,4 w/admin_level=2,3,4 r/boundary=disputed w/boundary=disputed \
        -o "$o/$n.part.pbf" --overwrite
    mv "$o/$n.part.pbf" "$o/$n.f.pbf"
    rm -f "$o/$n.osm.pbf"
}
export -f fetch
grep -v '^#' "$here/continents-v2.txt" | xargs -P2 -L1 bash -c 'fetch "$@"' _
# Continents overlap a little at their borders; merge keeps one copy of each object, sorted (planetiler wants that).
"$osmium" merge "$work"/osm/*.f.pbf -o "$work/world.osm.pbf" --overwrite
"$osmium" extract -p "$here/z10-v2.poly" "$work/world.osm.pbf" -o "$work/z10.osm.pbf" --overwrite

flags=(--download --data-dir="$work/data/sources" --tmpdir="$work/data/tmp"
    --only-layers=water,waterway,transportation,boundary --simplify_tolerance=0.5 --simplify_tolerance_at_max_zoom=0.5
    --min_feature_size=2 --min_feature_size_at_max_zoom=1 --boundary_country_names=false --languages=en --force)
# 2. The world at z0-z9, then z10 inside z10-v2.poly.
"$java" -Xmx10g -jar "$planetiler" --osm-path="$work/world.osm.pbf" --bounds=world \
    --minzoom=0 --maxzoom=9 --render_maxzoom=9 "${flags[@]}" --output="$work/world.mbtiles"
"$java" -Xmx8g -jar "$planetiler" --osm-path="$work/z10.osm.pbf" --polygon="$here/z10-v2.poly" \
    --minzoom=10 --maxzoom=10 --render_maxzoom=10 "${flags[@]}" --output="$work/z10.mbtiles"

# 3. Trim both and put them together (they share no zoom level).
rm -rf "$work/tiles/v2" "$work/parts"
for part in world:0 z10:10; do
    name=${part%:*}
    "$python" "$here/trim.py" "$work/$name.mbtiles" "$work/parts/$name/v2" "${part#*:}" > /dev/null
    mkdir -p "$work/tiles/v2"; cp -a "$work/parts/$name/v2/." "$work/tiles/v2/"
done
"$python" - "$work/tiles/v2" <<'EOF'
import json, pathlib, sys
out = pathlib.Path(sys.argv[1]); tj = json.loads((out / 'tiles.json').read_text())
tj.update(minzoom=0, maxzoom=10, bounds=[-180, -85, 180, 85],
          description=tj['description'] + '. z0-z9 worldwide; z10 inside z10-v2.poly (the stations)')
for f in ('tiles.json', 'metadata.json'):
    (out / f).write_text(json.dumps(tj, indent=1, ensure_ascii=False))
EOF
echo "$(find "$work/tiles/v2" -name '*.pbf' | wc -l) tiles, $(du -sb --apparent-size "$work/tiles/v2" | cut -f1) bytes"
echo "Upload: rsync -a $work/tiles/v2/ bird@whereplane.server:pfb-tiles-t0530/tiles/v2/"
