#!/bin/bash
# Build pfb-tiles/<version> from a Geofabrik US extract (run on a build machine, not on whereplane).
# Needs Java 21 and planetiler.jar (https://github.com/onthegomap/planetiler); about 15 GB of disk,
# 8 GB of RAM and an hour for the US. usage: build.sh <version, e.g. v2> [workdir]
set -euo pipefail
version=${1:?version, e.g. v2}
work=${2:-$PWD/pfb-build}
here=$(cd "$(dirname "$0")" && pwd)
java=${JAVA:-java}
planetiler=${PLANETILER_JAR:-planetiler.jar}
mkdir -p "$work/data"
[ -f "$work/data/us-latest.osm.pbf" ] || curl -fL -o "$work/data/us-latest.osm.pbf" \
    https://download.geofabrik.de/north-america/us-latest.osm.pbf
"$java" -Xmx8g -jar "$planetiler" --osm-path="$work/data/us-latest.osm.pbf" --download \
    --data-dir="$work/data/sources" --tmpdir="$work/data/tmp" \
    --only-layers=water,waterway,transportation,boundary --minzoom=4 --maxzoom=10 --render_maxzoom=10 \
    --bounds=-128,22,-64,51 --simplify_tolerance=0.5 --simplify_tolerance_at_max_zoom=0.5 \
    --min_feature_size=2 --min_feature_size_at_max_zoom=1 --boundary_country_names=false --languages=en \
    --output="$work/us.mbtiles" --force
rm -rf "$work/tiles/$version"
python3 "$here/trim.py" "$work/us.mbtiles" "$work/tiles/$version" 4
echo "Upload: rsync -a $work/tiles/$version/ bird@whereplane.server:pfb-tiles-t0530/tiles/$version/"
