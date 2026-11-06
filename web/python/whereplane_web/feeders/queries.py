"""Read side: what the pages and the JSON endpoints show. Hidden feeders never appear."""
from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.core.cache import cache
from django.db.models import Count, ExpressionWrapper, F, IntegerField, Q, Sum
from django.utils import timezone

from . import lists, readsb
from .models import CoverageCell, Feeder, FeederDay, FeederSample, NetworkSample, Status

WINDOWS = {'1h': timedelta(hours=1), '24h': timedelta(hours=24), '7d': timedelta(days=7), '30d': timedelta(days=30)}
DEFAULT_WINDOW = '24h'
ONLINE_STALE = timedelta(minutes=3)   # collector silent this long: nothing is "online"


def window_of(text: str | None, default=DEFAULT_WINDOW) -> str:
    return text if text in WINDOWS else default


def rejected_uuids() -> list[str]:
    """UUIDs readsbee rejected (its last 24 h): left off public pages, whatever was collected before."""
    hit = cache.get('rejected')
    if hit is None:
        hit = [r['uuid'] for r in lists.readsbee_status()['rejected']]
        cache.set('rejected', hit, 30)
    return hit


def readsbee_on() -> bool:
    hit = cache.get('readsbee_on')
    if hit is None:
        hit = lists.readsbee_doc() is not None
        cache.set('readsbee_on', hit, 30)
    return hit


def public_q():
    """Who public pages may show: not hidden, not an unset ID, not rejected by readsbee, and, while readsbee's
    status is there, accepted by it at least once (so feeders collected before readsbee don't linger)."""
    q = Q(hidden=False) & ~Q(uuid__in=rejected_uuids()) & ~Q(uuid__in=settings.WHEREPLANE_UNSET_IDS)
    return q & Q(accepted=True) if readsbee_on() else q


def public_feeders():
    return Feeder.objects.filter(public_q())


def fresh() -> bool:
    st = Status.get()
    return bool(st.last_poll and timezone.now() - st.last_poll < ONLINE_STALE)


def live() -> dict:
    st = Status.get()
    ok = fresh()
    feeders = public_feeders()
    return {
        'ok': ok,
        'updated': st.last_poll.isoformat() if st.last_poll else None,
        'feeders_online': feeders.filter(online=True).count() if ok else 0,
        'feeders': feeders.count(),
        'aircraft': st.aircraft if ok else 0,
        'msgs_s': round(st.msgs_s) if ok else 0,
        'pos_s': round(st.pos_s) if ok else 0,
    }


def coverage(window: str, feeder: Feeder | None = None, res: int = 1) -> dict:
    """
    Cells heard within `window`, merged res × res: [[lat_i, lon_i, band, feeders, hits], ...] with
    lat_i/lon_i in units of res × 0.1° (readsb.cell_bounds). Cached a minute.
    """
    key = f'cov:{window}:{feeder.pk if feeder else "all"}:{res}'
    hit = cache.get(key)
    if hit is not None:
        return hit
    qs = CoverageCell.objects.filter(last_seen__gte=timezone.now() - WINDOWS[window],
                                      feeder__in=public_feeders())
    if feeder:
        qs = qs.filter(feeder=feeder)
    if res > 1:
        qs = qs.annotate(la=ExpressionWrapper(F('lat_i') / res, output_field=IntegerField()),
                         lo=ExpressionWrapper(F('lon_i') / res, output_field=IntegerField()))
    else:
        qs = qs.annotate(la=F('lat_i'), lo=F('lon_i'))
    rows = (qs.values('la', 'lo', 'band').annotate(n=Count('feeder', distinct=True), h=Sum('hits'))
            .values_list('la', 'lo', 'band', 'n', 'h'))
    out = {
        'window': window, 'res': res, 'cell_deg': round(readsb.CELL_DEG * res, 4),
        'bands': [{'key': k, 'label': lab, 'tip': tip, 'mid_ft': mid}
                  for (k, lab, _, _), tip, mid in zip(readsb.BANDS, readsb.BAND_TIPS, readsb.BAND_MID_FT)],
        'cells': [list(r) for r in rows],
    }
    cache.set(key, out, 60)
    return out


def cell_feeders(lat_i: int, lon_i: int, res: int, window: str) -> list[dict]:
    """Feeders that heard anything in one (merged) cell, with the bands each heard there."""
    qs = CoverageCell.objects.filter(
        last_seen__gte=timezone.now() - WINDOWS[window], feeder__in=public_feeders(),
        lat_i__gte=lat_i * res, lat_i__lt=(lat_i + 1) * res, lon_i__gte=lon_i * res, lon_i__lt=(lon_i + 1) * res)
    by: dict[int, set] = {}
    for fid, band in qs.values_list('feeder_id', 'band').distinct():
        by.setdefault(fid, set()).add(band)
    feeders = Feeder.objects.in_bulk(list(by))
    out = [{'uuid': f.uuid, 'name': f.display_name, 'online': f.online, 'bands': sorted(by[f.pk])}
           for f in feeders.values()]
    out.sort(key=lambda d: (min(d['bands']), d['name']))
    return out


def feeder_ranges(f: Feeder, window='7d') -> list[dict | None]:
    if f.center_lat is None:
        return [None] * readsb.NUM_BANDS
    cells = f.cells.filter(last_seen__gte=timezone.now() - WINDOWS[window]).values_list('band', 'lat_i', 'lon_i', 'hits')
    return readsb.band_ranges(list(cells), (f.center_lat, f.center_lon))


def feeder_max_range(f: Feeder) -> int | None:
    vals = [r['max_km'] for r in feeder_ranges(f) if r]
    return max(vals) if vals else None


def max_ranges() -> dict[int, int]:
    """Farthest range (km, 7 d) per public feeder, cached 10 minutes: the list page shows it."""
    hit = cache.get('maxranges')
    if hit is None:
        hit = {f.pk: feeder_max_range(f) for f in public_feeders()}
        cache.set('maxranges', hit, 600)
    return hit


def feeder_series(f: Feeder, window: str) -> dict:
    since = timezone.now() - WINDOWS[window]
    rows = f.samples.filter(t__gte=since).order_by('t').values_list('t', 'msgs_s', 'pos_s', 'aircraft')
    t, msgs, pos, ac = [], [], [], []
    prev = None
    for ts, m, p, a in rows:
        s = int(ts.timestamp())
        if prev is not None and s - prev > 900:      # offline gap: break the line
            t.append(prev + 300); msgs.append(None); pos.append(None); ac.append(None)
        t.append(s); msgs.append(m); pos.append(p); ac.append(a)
        prev = s
    days = list(f.days.filter(day__gte=since.date()).order_by('day').values_list('day', 'aircraft'))
    span = min(WINDOWS[window], timezone.now() - f.first_seen)
    expected = max(span.total_seconds() / 300, 1)
    return {'window': window, 'from': int(since.timestamp()), 'to': int(timezone.now().timestamp()), 't': t, 'msgs_s': msgs, 'pos_s': pos, 'aircraft': ac,
            'days': [[d.isoformat(), n] for d, n in days],
            'online_pct': min(100, round(100 * len(rows) / expected)) if rows else 0}


def network_series(window: str) -> dict:
    rows = NetworkSample.objects.filter(t__gte=timezone.now() - WINDOWS[window]).order_by('t').values_list(
        't', 'feeders_online', 'aircraft', 'msgs_s')
    return {'t': [int(r[0].timestamp()) for r in rows], 'feeders': [r[1] for r in rows],
            'aircraft': [r[2] for r in rows], 'msgs_s': [r[3] for r in rows]}


def distinct_today(f: Feeder) -> int:
    row = FeederDay.objects.filter(feeder=f, day=timezone.now().date()).first()
    return row.aircraft if row else 0

