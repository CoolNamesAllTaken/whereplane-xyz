"""
What readsb (wiedehopf, built WITH_UUIDS) tells us about each feeder, as plain functions so the
tests need no network and no database.

Per-feeder attribution in stock readsb: every aircraft keeps the receiver IDs that sent it a
position (or, without an ADS-B position, any message) in the last minute, with times.
`/re-api/?all&filter_uuid=<uuid>` returns the aircraft that this receiver fed within the last
2 × json_interval (2 s here). Polling that per feeder samples "who hears what, where".
`/data/clients.json` has one row per connection: receiver UUID, address (never stored), msgs/s,
positions/s. Nothing else in stock readsb maps aircraft to receivers.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

# ─── Altitude bands ────────────────────────────────────────────────────────────
# (key, label, low ft, high ft). Band 0 is "on the ground" (alt_baro == "ground").
BANDS = (
    ('gnd', 'gnd', None, None),
    ('lt1k', '<1k', None, 1000),
    ('1k', '1–3k', 1000, 3000),
    ('3k', '3–10k', 3000, 10000),
    ('10k', '10–20k', 10000, 20000),
    ('20k', '20–30k', 20000, 30000),
    ('30k', '30k+', 30000, None),
)
NUM_BANDS = len(BANDS)
BAND_TIPS = ('On the ground', 'Below 1,000 ft', '1,000–3,000 ft', '3,000–10,000 ft',
             '10,000–20,000 ft', '20,000–30,000 ft', 'Above 30,000 ft')
# Representative altitude per band (ft).
BAND_MID_FT = (0, 500, 2000, 6500, 15000, 25000, 36000)


def band_of(aircraft: dict) -> int | None:
    """Band index from barometric altitude (geometric if there is none); None if unknown."""
    alt = aircraft.get('alt_baro')
    if alt == 'ground':
        return 0
    if not isinstance(alt, (int, float)):
        alt = aircraft.get('alt_geom')
    if not isinstance(alt, (int, float)):
        return None
    for b in range(NUM_BANDS - 1, 0, -1):
        low = BANDS[b][2]
        if low is None or alt >= low:
            return b
    return 1


# ─── Grid cells ────────────────────────────────────────────────────────────────
# 0.1° cells, indexed from the south-west corner of the world so indices are never negative
# (integer division then floors in SQL and Python alike). Coarser maps merge 2×2, 4×4... cells.
CELL_DEG = 0.1
LAT_CELLS = 1800
LON_CELLS = 3600


def cell_of(lat: float, lon: float) -> tuple[int, int]:
    lat_i = min(max(int(math.floor((lat + 90.0) / CELL_DEG)), 0), LAT_CELLS - 1)
    lon_i = int(math.floor((lon + 180.0) / CELL_DEG)) % LON_CELLS
    return lat_i, lon_i


def cell_bounds(lat_i: int, lon_i: int, res: int = 1) -> tuple[float, float, float, float]:
    """(south, west, north, east) of cell (lat_i, lon_i) at `res` × CELL_DEG."""
    step = CELL_DEG * res
    south = lat_i * step - 90.0
    west = lon_i * step - 180.0
    return round(south, 6), round(west, 6), round(south + step, 6), round(west + step, 6)


def cell_center(lat_i: int, lon_i: int, res: int = 1) -> tuple[float, float]:
    s, w, n, e = cell_bounds(lat_i, lon_i, res)
    return (s + n) / 2, (w + e) / 2


# ─── Positions that count as coverage ─────────────────────────────────────────
# Only direct ADS-B: TIS-B and ADS-R are rebroadcast by ground stations, so hearing them says
# nothing about hearing the aircraft's own position; MLAT and Mode S positions aren't heard either.
DIRECT_TYPES = frozenset({'adsb_icao', 'adsb_icao_nt', 'adsb_other'})
MAX_SEEN_POS_S = 5.0


def coverage_hit(aircraft: dict) -> tuple[int, int, int] | None:
    """(band, lat_i, lon_i) if this aircraft's current position counts for the feeder that heard it."""
    if aircraft.get('type') not in DIRECT_TYPES:
        return None
    lat, lon = aircraft.get('lat'), aircraft.get('lon')
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None
    if (aircraft.get('seen_pos') or 0) > MAX_SEEN_POS_S:
        return None
    band = band_of(aircraft)
    if band is None:
        return None
    return (band, *cell_of(lat, lon))


# ─── Feeder IDs ────────────────────────────────────────────────────────────────
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def normalize_uuid(text: str) -> str | None:
    t = (text or '').strip().lower()
    return t if UUID_RE.match(t) else None


def default_name(uuid: str) -> str:
    """Short public name: the last 8 hex digits (the first 8 if those are all zero)."""
    tail = uuid.replace('-', '')[-8:]
    return tail if tail.strip('0') else uuid[:8]


# ─── clients.json ──────────────────────────────────────────────────────────────
@dataclass
class ClientStats:
    uuid: str
    connections: int = 0
    kbps: float = 0.0
    conn_seconds: float = 0.0
    msgs_s: float = 0.0
    pos_s: float = 0.0
    extras: dict = field(default_factory=dict)


def parse_clients(doc: dict) -> dict[str, ClientStats]:
    """
    Per-UUID totals from /data/clients.json. The address column is read past and never kept:
    feeder IPs must not reach the database or a page. Rows without a valid UUID are skipped.
    """
    fmt = doc.get('format') or []
    col = {name: i for i, name in enumerate(fmt)}

    def get(row, name, default=0.0):
        i = col.get(name)
        if i is None or i >= len(row):
            return default
        v = row[i]
        return float(v) if isinstance(v, (int, float)) else default

    out: dict[str, ClientStats] = {}
    for row in doc.get('clients') or []:
        if not row:
            continue
        uuid = normalize_uuid(str(row[col.get('receiverId', 0)]))
        if not uuid:
            continue
        s = out.setdefault(uuid, ClientStats(uuid))
        s.connections += 1
        s.kbps += get(row, 'avg. kbit/s')
        s.conn_seconds = max(s.conn_seconds, get(row, 'conn time(s)'))
        s.msgs_s += get(row, 'messages/s')
        s.pos_s += get(row, 'positions/s')
    return out


def parse_stats(doc: dict) -> dict:
    """Network totals from /data/stats.json: aircraft now, messages/s and positions/s over the last minute."""
    last = doc.get('last1min') or {}
    span = max((last.get('end') or 0) - (last.get('start') or 0), 1.0)
    return {
        'aircraft': int(doc.get('aircraft_with_pos') or 0) + int(doc.get('aircraft_without_pos') or 0),
        'aircraft_with_pos': int(doc.get('aircraft_with_pos') or 0),
        'msgs_s': round((last.get('messages_valid') or last.get('messages') or 0) / span, 1),
        'pos_s': round((last.get('position_count_total') or 0) / span, 1),
    }


# ─── Ranges ────────────────────────────────────────────────────────────────────
EARTH_KM = 6371.0088


def distance_km(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


def estimate_center(cells) -> tuple[float, float] | None:
    """
    Where a feeder roughly is, from its coverage cells [(band, lat_i, lon_i, hits)]: the hit-weighted
    mean of its low cells (ground to 3k ft, which it only hears nearby), else of all cells.
    Used only to measure range; never shown.
    """
    def mean(rows):
        w = sum(h for *_, h in rows)
        if not w:
            return None
        lat = sum(cell_center(la, lo)[0] * h for _, la, lo, h in rows) / w
        # Longitudes as unit vectors, so a feeder near the antimeridian isn't put on the other side.
        x = sum(math.cos(math.radians(cell_center(la, lo)[1])) * h for _, la, lo, h in rows)
        y = sum(math.sin(math.radians(cell_center(la, lo)[1])) * h for _, la, lo, h in rows)
        return lat, math.degrees(math.atan2(y, x))

    low = [c for c in cells if c[0] <= 2]
    if sum(c[3] for c in low) >= 20:
        return mean(low)
    return mean(list(cells))


def band_ranges(cells, center) -> list[dict | None]:
    """
    Per band: farthest and typical distance (km) of the cells a feeder hears from `center`.
    Farthest is the 98th percentile by hits, so one bad position doesn't set it; typical is the median.
    """
    out: list[dict | None] = [None] * NUM_BANDS
    if not center:
        return out
    by_band: dict[int, list[tuple[float, int]]] = {}
    for band, la, lo, hits in cells:
        lat, lon = cell_center(la, lo)
        by_band.setdefault(band, []).append((distance_km(center[0], center[1], lat, lon), hits))
    for band, rows in by_band.items():
        rows.sort()
        total = sum(h for _, h in rows)

        def pct(p):
            acc = 0
            for d, h in rows:
                acc += h
                if acc >= p * total:
                    return d
            return rows[-1][0]
        out[band] = {'max_km': round(pct(0.98)), 'typical_km': round(pct(0.5)), 'cells': len(rows)}
    return out
