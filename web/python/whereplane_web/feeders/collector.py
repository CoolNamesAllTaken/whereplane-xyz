"""
The collector loop (management command `collect`). Reads the live readsb over HTTP, read-only:

  every poll (10 s)  the accepted feeders from readsbee.json (WHEREPLANE_READSBEE_STATUS_FILE; without it,
                     /data/clients.json, which readsbee's globe no longer serves), /data/stats.json, and per
                     feeder /re-api/?all&filter_uuid=<uuid>: the aircraft it fed in the last ~2 s
  every minute       feeders' live state, coverage cells (upsert), Status
  every 5 minutes    FeederSample / NetworkSample rows, distinct aircraft per day
  every hour         range centers, pruning (samples 35 d, cells 31 d, days 40 d)

`fetch(path) -> dict` is passed in, so tests feed it canned JSON.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from datetime import timedelta

import requests
from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from . import lists, readsb
from .models import CoverageCell, Feeder, FeederDay, FeederSample, NetworkSample, Status

log = logging.getLogger('whereplane.collector')

MINUTE, SAMPLE, HOUR = 60, 300, 3600
RECENT_S = 60          # "aircraft now": distinct aircraft fed in this many seconds


def http_fetcher(base_url: str, timeout: float = 5.0):
    session = requests.Session()
    session.headers['User-Agent'] = 'whereplane-web-collector'

    def fetch(path: str) -> dict:
        r = session.get(base_url + path, timeout=timeout)
        r.raise_for_status()
        return r.json()
    return fetch


class Collector:
    def __init__(self, fetch, clock=time.time):
        self.fetch = fetch
        self.clock = clock
        self.clients: dict[str, readsb.ClientStats] = {}
        self.stats: dict = {}
        self.pending: dict[tuple, int] = defaultdict(int)       # (uuid, band, lat_i, lon_i) -> hits
        self.recent: dict[str, dict[str, float]] = defaultdict(dict)   # uuid -> hex -> last fed (s)
        self.day_hexes: dict[str, tuple] = {}                  # uuid -> (date, set of hex)
        self.next_minute = self.next_sample = self.next_hour = 0.0
        self.requests = 0
        self.poll_ms = 0.0
        self.error = ''
        self.source = ''

    # ─── Reading readsb ────────────────────────────────────────────────────
    def poll(self):
        t0 = time.monotonic()
        now = self.clock()
        today = timezone.now().date()
        self.requests = 0
        doc = lists.readsbee_doc()
        self.source = 'readsbee' if doc is not None else 'clients.json'
        self.clients = readsb.parse_readsbee(doc) if doc is not None else readsb.parse_clients(self._get('/data/clients.json'))
        self.stats = readsb.parse_stats(self._get('/data/stats.json'))
        for uuid in self.clients:
            try:
                doc = self._get(f'/re-api/?all&filter_uuid={uuid}')
            except Exception as e:  # one feeder's call failing shouldn't lose the round
                log.warning('re-api %s: %s', uuid, e)
                continue
            self.ingest(uuid, doc.get('aircraft') or [], now, today)
        self.poll_ms = (time.monotonic() - t0) * 1000

    def _get(self, path):
        self.requests += 1
        return self.fetch(path)

    def ingest(self, uuid: str, aircraft: list[dict], now: float, today):
        recent = self.recent[uuid]
        day, hexes = self.day_hexes.get(uuid) or self._load_day(uuid, today)
        if day != today:
            day, hexes = today, set()
        for ac in aircraft:
            hex_ = str(ac.get('hex') or '').lower()
            if hex_:
                recent[hex_] = now
                hexes.add(hex_)
            hit = readsb.coverage_hit(ac)
            if hit:
                self.pending[(uuid, *hit)] += 1
        self.day_hexes[uuid] = (day, hexes)

    def _load_day(self, uuid, today):
        row = FeederDay.objects.filter(feeder__uuid=uuid, day=today).first()
        return today, set(row.hexes.split()) if row and row.hexes else set()

    def aircraft_now(self, uuid: str, now: float) -> int:
        recent = self.recent.get(uuid) or {}
        for h in [h for h, t in recent.items() if now - t > RECENT_S]:
            del recent[h]
        return len(recent)

    # ─── Writing ───────────────────────────────────────────────────────────
    def flush_minute(self):
        now_s = self.clock()
        now = timezone.now()
        feeders = {f.uuid: f for f in Feeder.objects.all()}
        with transaction.atomic():
            for uuid, c in self.clients.items():
                f = feeders.get(uuid)
                if f is None:
                    f = feeders[uuid] = Feeder.objects.create(uuid=uuid, first_seen=now)
                if c.conn_seconds is not None:
                    f.connected_since = now - timedelta(seconds=c.conn_seconds)
                elif not f.online or not f.connected_since:
                    f.connected_since = now      # readsbee.json has no connection time: online since we saw it
                f.online = True
                f.accepted = f.accepted or self.source == 'readsbee'
                f.last_seen = now
                f.connections = c.connections
                f.msgs_s, f.pos_s, f.kbps = (None if v is None else round(v, 1) for v in (c.msgs_s, c.pos_s, c.kbps))
                f.aircraft_now = self.aircraft_now(uuid, now_s)
                f.save()
            Feeder.objects.exclude(uuid__in=list(self.clients)).filter(online=True).update(
                online=False, msgs_s=None, pos_s=None, kbps=None, aircraft_now=0, connections=0, connected_since=None)
            self.flush_cells(feeders, now)
            st = Status.get()
            st.last_poll = now
            st.last_error = self.error[:300]
            st.poll_ms = round(self.poll_ms, 1)
            st.requests = self.requests
            st.source = self.source
            st.aircraft = self.stats.get('aircraft', 0)
            st.msgs_s = self.stats.get('msgs_s', 0)
            st.pos_s = self.stats.get('pos_s', 0)
            st.save()

    def flush_cells(self, feeders, now):
        if not self.pending:
            return
        ts = connection.ops.adapt_datetimefield_value(now)
        rows = [(feeders[uuid].pk, band, la, lo, ts, ts, hits)
                for (uuid, band, la, lo), hits in self.pending.items() if uuid in feeders]
        table = CoverageCell._meta.db_table
        sql = (f'INSERT INTO {table} (feeder_id, band, lat_i, lon_i, first_seen, last_seen, hits) '
               f'VALUES (%s, %s, %s, %s, %s, %s, %s) '
               f'ON CONFLICT (feeder_id, band, lat_i, lon_i) DO UPDATE SET '
               f'last_seen = excluded.last_seen, hits = {table}.hits + excluded.hits')
        with connection.cursor() as cur:
            cur.executemany(sql, rows)
        self.pending.clear()

    def flush_samples(self):
        now = timezone.now()
        feeders = {f.uuid: f for f in Feeder.objects.filter(uuid__in=list(self.clients))}
        FeederSample.objects.bulk_create([
            FeederSample(feeder=f, t=now, msgs_s=f.msgs_s, pos_s=f.pos_s, aircraft=f.aircraft_now, kbps=f.kbps)
            for f in feeders.values()])
        if self.stats:
            NetworkSample.objects.create(t=now, feeders_online=len(self.clients), aircraft=self.stats['aircraft'],
                                         msgs_s=self.stats['msgs_s'], pos_s=self.stats['pos_s'])
        for uuid, (day, hexes) in self.day_hexes.items():
            f = feeders.get(uuid) or Feeder.objects.filter(uuid=uuid).first()
            if f:
                FeederDay.objects.update_or_create(feeder=f, day=day, defaults={
                    'hexes': ' '.join(sorted(hexes)), 'aircraft': len(hexes)})

    def hourly(self):
        now = timezone.now()
        CoverageCell.objects.filter(last_seen__lt=now - timedelta(days=31)).delete()
        FeederSample.objects.filter(t__lt=now - timedelta(days=35)).delete()
        NetworkSample.objects.filter(t__lt=now - timedelta(days=35)).delete()
        FeederDay.objects.filter(day__lt=(now - timedelta(days=40)).date()).delete()
        since = now - timedelta(days=7)
        for f in Feeder.objects.all():
            cells = list(f.cells.filter(last_seen__gte=since).values_list('band', 'lat_i', 'lon_i', 'hits'))
            c = readsb.estimate_center(cells) if cells else None
            if c:
                f.center_lat, f.center_lon = round(c[0], 3), round(c[1], 3)
                f.save(update_fields=['center_lat', 'center_lon'])

    # ─── Loop ──────────────────────────────────────────────────────────────
    def step(self):
        """One poll and whatever flushes are due. Returns seconds until the next poll."""
        started = self.clock()
        try:
            self.poll()
            self.error = ''
        except Exception as e:
            self.error = f'{type(e).__name__}: {e}'
            log.warning('poll failed: %s', self.error)
            self.clients = {}
            self.stats = {}
        now = self.clock()
        if now >= self.next_minute:
            self.next_minute = now + MINUTE
            if self.error and not self.clients:
                st = Status.get()
                st.last_error = self.error[:300]
                st.save(update_fields=['last_error'])
            else:
                self.flush_minute()
        if now >= self.next_sample and self.clients:
            self.next_sample = now + SAMPLE
            self.flush_samples()
        if now >= self.next_hour:
            self.next_hour = now + HOUR
            self.hourly()
        return max(0.5, settings.WHEREPLANE_POLL_SECONDS - (self.clock() - started))
