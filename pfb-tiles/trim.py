"""Trim a planetiler OpenMapTiles .mbtiles into a static z/x/y.pbf folder (gzip) for pfb-tiles.

Keeps only what the faint basemap draws, with OpenMapTiles layer and field names:
  water           class (ocean, lake, river, ...)
  waterway        class river, canal
  transportation  class motorway, trunk, primary (no ramps)
  boundary        admin_level <= 4 (admin_level, maritime)
Features are filtered at the protobuf level: geometry is copied byte for byte. Empty tiles are not
written (the server answers 204 for them).

usage: python3 trim.py <in.mbtiles> <out dir (tiles/v1)> [minzoom]
"""
from __future__ import annotations

import gzip
import json
import sqlite3
import statistics
import sys
from pathlib import Path

KEEP = {
    "water": ({"class"}, lambda t: True),
    "waterway": ({"class"}, lambda t: t.get("class") in ("river", "canal")),
    "transportation": ({"class"}, lambda t: t.get("class") in ("motorway", "trunk", "primary")
                       and not t.get("ramp")),
    "boundary": ({"admin_level", "maritime"}, lambda t: isinstance(t.get("admin_level"), int)
                 and t["admin_level"] <= 4),
}


# --- minimal protobuf -------------------------------------------------------------------------

def varint(buf: bytes, i: int):
    shift = result = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if b < 0x80:
            return result, i
        shift += 7


def fields(buf: bytes):
    """(field number, wire type, value) for each field; value is int or bytes."""
    i, n = 0, len(buf)
    while i < n:
        key, i = varint(buf, i)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, i = varint(buf, i)
        elif wire == 2:
            length, i = varint(buf, i)
            value, i = buf[i:i + length], i + length
        elif wire == 5:
            value, i = buf[i:i + 4], i + 4
        elif wire == 1:
            value, i = buf[i:i + 8], i + 8
        else:
            raise ValueError(f"wire type {wire}")
        yield number, wire, value


def enc_varint(value: int) -> bytes:
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def enc_field(number: int, wire: int, value) -> bytes:
    key = enc_varint(number << 3 | wire)
    if wire == 0:
        return key + enc_varint(value)
    if wire == 2:
        return key + enc_varint(len(value)) + value
    return key + value


def decode_value(buf: bytes):
    for number, wire, value in fields(buf):
        if number == 1:
            return value.decode()
        if number in (4, 5):                     # int, uint
            return value
        if number == 6:                          # sint
            return (value >> 1) ^ -(value & 1)
        if number == 7:
            return bool(value)
        if number in (2, 3):                     # float, double: keep raw
            return ("raw", number, value)
    return None


def encode_value(value) -> bytes:
    if isinstance(value, tuple):
        return enc_field(value[1], 5 if value[1] == 2 else 1, value[2])
    if isinstance(value, bool):
        return enc_field(7, 0, int(value))
    if isinstance(value, int):
        return enc_field(4, 0, value) if value >= 0 else enc_field(6, 0, (value << 1) ^ (value >> 63))
    return enc_field(1, 2, str(value).encode())


# --- tiles ---------------------------------------------------------------------------------------

def trim_layer(buf: bytes):
    name, keys, values, features, rest = None, [], [], [], []
    for number, wire, value in fields(buf):
        if number == 1:
            name = value.decode()
        elif number == 3:
            keys.append(value.decode())
        elif number == 4:
            values.append(decode_value(value))
        elif number == 2:
            features.append(value)
        elif number in (5, 15):                  # extent, version
            rest.append((number, wire, value))
    if name not in KEEP:
        return None
    wanted, keep = KEEP[name]
    out_keys, out_values, out_features = [], [], []
    for feature in features:
        tags, geom_type, geometry = [], 0, b""
        for number, wire, value in fields(feature):
            if number == 2:
                packed, j = [], 0
                while j < len(value):
                    item, j = varint(value, j)
                    packed.append(item)
                tags = packed
            elif number == 3:
                geom_type = value
            elif number == 4:
                geometry = value
        props = {keys[tags[k]]: values[tags[k + 1]] for k in range(0, len(tags), 2)}
        if not keep(props) or not geometry:
            continue
        new_tags = []
        for key in sorted(wanted & props.keys()):
            value = props[key]
            if key not in out_keys:
                out_keys.append(key)
            if value not in out_values:
                out_values.append(value)
            new_tags += [out_keys.index(key), out_values.index(value)]
        body = b""
        if new_tags:
            body += enc_field(2, 2, b"".join(enc_varint(item) for item in new_tags))
        body += enc_field(3, 0, geom_type) + enc_field(4, 2, geometry)
        out_features.append(body)
    if not out_features:
        return None
    layer = enc_field(1, 2, name.encode())
    layer += b"".join(enc_field(2, 2, feature) for feature in out_features)
    layer += b"".join(enc_field(3, 2, key.encode()) for key in out_keys)
    layer += b"".join(enc_field(4, 2, encode_value(value)) for value in out_values)
    layer += b"".join(enc_field(number, wire, value) for number, wire, value in rest)
    return enc_field(3, 2, layer)


def trim_tile(data: bytes) -> bytes:
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return b"".join(filter(None, (trim_layer(value) for number, _, value in fields(data) if number == 3)))


def main():
    source, out = sys.argv[1], Path(sys.argv[2])
    minzoom = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    db = sqlite3.connect(source)
    meta = dict(db.execute("SELECT name, value FROM metadata"))
    sizes, per_zoom, dropped = [], {}, 0
    for z, x, row, data in db.execute("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles"):
        if z < minzoom:
            continue
        y = (1 << z) - 1 - row
        tile = trim_tile(data)
        if not tile:
            dropped += 1
            continue
        packed = gzip.compress(tile, compresslevel=9, mtime=0)
        path = out / str(z) / str(x) / f"{y}.pbf"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(packed)
        sizes.append(len(packed))
        per_zoom.setdefault(z, []).append(len(packed))
    bounds = [float(v) for v in meta.get("bounds", "-180,-85,180,85").split(",")]
    zooms = sorted(per_zoom)
    tilejson = {
        "tilejson": "3.0.0", "name": "pfb-tiles", "version": out.name,
        "description": "Trimmed OpenMapTiles basemap for the live-traffic background on pantsforbirds.com",
        "attribution": "© OpenStreetMap contributors, OpenMapTiles",
        "tiles": [f"https://globe.whereplane.xyz/pfb-tiles/{out.name}/{{z}}/{{x}}/{{y}}.pbf"],
        "minzoom": zooms[0], "maxzoom": zooms[-1], "bounds": bounds,
        "vector_layers": [{"id": "water", "fields": {"class": "String"}},
                          {"id": "waterway", "fields": {"class": "String"}},
                          {"id": "transportation", "fields": {"class": "String"}},
                          {"id": "boundary", "fields": {"admin_level": "Number", "maritime": "Number"}}],
        "built_from": {"planetiler": meta.get("generator", ""), "osm": meta.get("planetiler:osm:osmosisreplicationtime", "")},
    }
    (out / "tiles.json").write_text(json.dumps(tilejson, indent=1, ensure_ascii=False))
    (out / "metadata.json").write_text(json.dumps(tilejson, indent=1, ensure_ascii=False))
    sizes.sort()
    stats = {"tiles": len(sizes), "empty_dropped": dropped, "bytes": sum(sizes),
             "avg": round(statistics.mean(sizes)), "p95": sizes[int(len(sizes) * .95)], "max": sizes[-1],
             "per_zoom": {z: {"n": len(v), "avg": round(statistics.mean(v)), "p95": sorted(v)[int(len(v) * .95)]}
                          for z, v in sorted(per_zoom.items())}}
    (out.parent / f"stats-{out.name}.json").write_text(json.dumps(stats, indent=1))
    print(json.dumps(stats, indent=1))


if __name__ == "__main__":
    main()
