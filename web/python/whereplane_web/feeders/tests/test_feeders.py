import json
from datetime import timedelta
from pathlib import Path

import pytest
from django.contrib.auth.models import User
from django.test import Client
from django.core.cache import cache
from django.utils import timezone

from feeders import lists, queries, readsb
from feeders.collector import Collector
from feeders.models import CoverageCell, Feeder, FeederDay, FeederSample, ListEntry, NetworkSample, Status

BEE = 'bee0003c-a8bd-5d38-bee0-003ca8bd5d38'
BEE2 = 'bee0003a-71b8-8022-bee0-003a71b88022'
OTHER = '7ad590e5-b1cc-3000-7ad5-90e5b1cc3000'
IP = '104.151.147.148'

CLIENTS = {
    'now': 1793919125.053,
    'format': ['receiverId', 'host:port', 'avg. kbit/s', 'conn time(s)', 'messages/s', 'positions/s',
               'reduce_signal', 'recent_rtt(ms)', 'positions'],
    'clients': [
        [BEE, f'   {IP} port 51543', 49.44, 61, 274.403, 39.517, 0, -1, 2408],
        [BEE, '   47.151.255.159 port 52861', 10.0, 715, 25.6, 1.5, 0, -1, 27846],
        [OTHER, '   207.195.19.250 port 54289', 1.73, 8776, 10.317, 2.520, 0, -1, 22115],
        ['not-a-uuid', '   1.2.3.4 port 1', 1, 1, 1, 1, 0, -1, 1],
    ],
}
STATS = {'now': 1793919125.1, 'aircraft_with_pos': 922, 'aircraft_without_pos': 103,
         'last1min': {'start': 1793919065.0, 'end': 1793919125.0, 'messages_valid': 413891, 'position_count_total': 54300}}


def ac(hex_, lat=34.0, lon=-117.8, alt=9000, type_='adsb_icao', seen_pos=0.5):
    d = {'hex': hex_, 'type': type_, 'alt_baro': alt, 'seen_pos': seen_pos}
    if lat is not None:
        d.update(lat=lat, lon=lon)
    return d


REAPI = {
    BEE: {'aircraft': [ac('a81bcc'), ac('a00001', alt='ground', lat=33.9, lon=-118.4), ac('a00002', type_='tisb_icao'),
                       ac('a00003', lat=None), ac('a00004', alt=35000, lat=35.5, lon=-115.0)]},
    OTHER: {'aircraft': [ac('b00001', lat=21.3, lon=-157.9, alt=2000)]},
}


def fake_fetch(path):
    if path == '/data/clients.json':
        return CLIENTS
    if path == '/data/stats.json':
        return STATS
    uuid = path.split('filter_uuid=')[1]
    return REAPI.get(uuid, {'aircraft': []})


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()


# ─── Parsing and binning ──────────────────────────────────────────────────
def test_parse_clients_sums_connections_and_drops_addresses():
    got = readsb.parse_clients(CLIENTS)
    assert set(got) == {BEE, OTHER}
    s = got[BEE]
    assert s.connections == 2
    assert s.msgs_s == pytest.approx(300.003)
    assert s.pos_s == pytest.approx(41.017)
    assert s.conn_seconds == 715
    assert IP not in repr(got)


def test_parse_stats():
    s = readsb.parse_stats(STATS)
    assert s['aircraft'] == 1025
    assert s['msgs_s'] == pytest.approx(6898.2, abs=0.1)
    assert s['pos_s'] == 905.0


@pytest.mark.parametrize('alt,band', [('ground', 0), (-200, 1), (0, 1), (999, 1), (1000, 2), (2999, 2), (3000, 3),
                                      (9999, 3), (10000, 4), (25000, 5), (30000, 6), (45000, 6)])
def test_band_of(alt, band):
    assert readsb.band_of({'alt_baro': alt}) == band


def test_band_of_falls_back_to_geometric():
    assert readsb.band_of({'alt_geom': 12000}) == 4
    assert readsb.band_of({}) is None


def test_cells_are_floor_indexed_and_never_negative():
    assert readsb.cell_of(-90, -180) == (0, 0)
    assert readsb.cell_of(0.05, 0.05) == (900, 1800)
    assert readsb.cell_of(-0.05, -0.05) == (899, 1799)
    assert readsb.cell_of(89.99, 179.99) == (1799, 3599)
    s, w, n, e = readsb.cell_bounds(*readsb.cell_of(34.05, -117.83))
    assert s <= 34.05 < n and w <= -117.83 < e
    # Merged cells: integer division keeps containment.
    la, lo = readsb.cell_of(34.05, -117.83)
    s, w, n, e = readsb.cell_bounds(la // 2, lo // 2, 2)
    assert s <= 34.05 < n and w <= -117.83 < e


def test_coverage_hit_only_direct_adsb_with_fresh_position():
    assert readsb.coverage_hit(ac('x')) == (3, *readsb.cell_of(34.0, -117.8))
    assert readsb.coverage_hit(ac('x', type_='tisb_icao')) is None
    assert readsb.coverage_hit(ac('x', type_='adsr_icao')) is None
    assert readsb.coverage_hit(ac('x', type_='mlat')) is None
    assert readsb.coverage_hit(ac('x', lat=None)) is None
    assert readsb.coverage_hit(ac('x', seen_pos=30)) is None


def test_default_name():
    assert readsb.default_name(BEE) == 'a8bd5d38'
    assert readsb.default_name('7105167e-a989-2665-0000-000000000000') == '7105167e'


def test_ranges_from_cells():
    center = (34.0, -118.0)
    la, lo = readsb.cell_of(*center)
    far_la, far_lo = readsb.cell_of(36.0, -118.0)            # ~222 km north
    cells = [(1, la, lo, 50), (1, la + 1, lo, 50), (6, far_la, far_lo, 10), (6, la, lo, 10)]
    r = readsb.band_ranges(cells, center)
    assert r[0] is None
    assert r[1]['max_km'] < 20
    assert 215 < r[6]['max_km'] < 230
    c = readsb.estimate_center(cells)
    assert abs(c[0] - 34.0) < 0.2 and abs(c[1] + 118.0) < 0.2


# ─── Collector ────────────────────────────────────────────────────────────
@pytest.mark.django_db
def test_collector_round_writes_feeders_cells_samples():
    c = Collector(fake_fetch, clock=lambda: 1000.0)
    c.step()
    assert Feeder.objects.count() == 2
    bee = Feeder.objects.get(uuid=BEE)
    assert bee.online and bee.connections == 2 and bee.msgs_s == 300.0
    assert bee.aircraft_now == 5                    # every aircraft it fed, with or without position
    cells = {(x.band, x.lat_i, x.lon_i): x.hits for x in CoverageCell.objects.filter(feeder=bee)}
    # tisb and no-position aircraft don't count
    assert cells == {(3, *readsb.cell_of(34.0, -117.8)): 1, (0, *readsb.cell_of(33.9, -118.4)): 1,
                     (6, *readsb.cell_of(35.5, -115.0)): 1}
    assert FeederSample.objects.filter(feeder=bee).count() == 1
    assert NetworkSample.objects.get().feeders_online == 2
    assert FeederDay.objects.get(feeder=bee).aircraft == 5
    st = Status.get()
    assert st.requests == 4 and st.aircraft == 1025


@pytest.mark.django_db
def test_collector_upsert_adds_hits_and_marks_offline():
    t = [1000.0]
    c = Collector(fake_fetch, clock=lambda: t[0])
    c.step()
    t[0] += 61
    c.step()
    cell = CoverageCell.objects.get(feeder__uuid=BEE, band=3)
    assert cell.hits == 2
    CLIENTS_ONE = {**CLIENTS, 'clients': CLIENTS['clients'][:2]}
    c.fetch = lambda p: CLIENTS_ONE if p == '/data/clients.json' else fake_fetch(p)
    t[0] += 61
    c.step()
    assert not Feeder.objects.get(uuid=OTHER).online
    assert Feeder.objects.get(uuid=BEE).online


@pytest.mark.django_db
def test_collector_failure_keeps_state():
    c = Collector(fake_fetch, clock=lambda: 1000.0)
    c.step()

    def broken(path):
        raise ConnectionError('readsb down')
    c.fetch = broken
    c.next_minute = 0
    c.step()
    assert Feeder.objects.get(uuid=BEE).online      # not flipped offline by an outage of ours
    assert 'readsb down' in Status.get().last_error


@pytest.mark.django_db
def test_no_ip_anywhere():
    Collector(fake_fetch, clock=lambda: 1000.0).step()
    dump = json.dumps([list(m.objects.values()) for m in (Feeder, Status, CoverageCell, FeederSample)], default=str)
    assert IP not in dump and '207.195' not in dump


# ─── Queries and pages ────────────────────────────────────────────────────
@pytest.fixture
def collected(db):
    Collector(fake_fetch, clock=lambda: 1000.0).step()


@pytest.mark.django_db
def test_coverage_merges_and_hides(collected):
    d = queries.coverage('24h', res=1)
    assert len(d['cells']) == 4
    assert len(d['bands']) == readsb.NUM_BANDS
    d2 = queries.coverage('24h', res=10)
    assert all(len(row) == 5 for row in d2['cells'])
    Feeder.objects.filter(uuid=OTHER).update(hidden=True)
    cache.clear()
    assert len(queries.coverage('24h', res=1)['cells']) == 3
    CoverageCell.objects.update(last_seen=timezone.now() - timedelta(hours=30))
    cache.clear()
    assert queries.coverage('24h', res=1)['cells'] == []
    assert len(queries.coverage('7d', res=1)['cells']) == 3


@pytest.mark.django_db
def test_cell_feeders(collected):
    la, lo = readsb.cell_of(34.0, -117.8)
    got = queries.cell_feeders(la, lo, 1, '24h')
    assert [f['uuid'] for f in got] == [BEE] and got[0]['bands'] == [3]
    assert queries.cell_feeders(la // 4, lo // 4, 4, '24h')[0]['uuid'] == BEE


@pytest.mark.django_db
@pytest.mark.parametrize('url', ['/', '/coverage/', '/feeders/', f'/feeder/{BEE}/', '/api/live.json',
                                 '/api/coverage.json', f'/api/coverage.json?feeder={BEE}&w=7d',
                                 f'/api/feeder/{BEE}/series.json?w=30d', '/api/network.json', '/healthz'])
def test_pages(client, collected, url):
    r = client.get(url)
    assert r.status_code == 200
    assert IP.encode() not in r.content


@pytest.mark.django_db
def test_pages_content(client, collected):
    html = client.get('/').content.decode()
    assert 'AT+FEED=6,feed.whereplane.xyz,30004,1,BEAST' in html
    assert "please don't point other receivers here" in html
    assert 'globe.whereplane.xyz' in html
    html = client.get(f'/feeder/{BEE}/').content.decode()
    assert f'https://globe.whereplane.xyz/?feed={BEE}' in html
    assert 'ADS-L' in html and 'Remote ID' in html and 'UAT' in html
    html = client.get('/feeders/').content.decode()
    assert 'a8bd5d38' in html


@pytest.mark.django_db
def test_hidden_feeder_404(client, collected):
    Feeder.objects.filter(uuid=BEE).update(hidden=True)
    assert client.get(f'/feeder/{BEE}/').status_code == 404
    assert BEE not in client.get('/feeders/').content.decode()
    assert client.get(f'/api/feeder/{BEE}/series.json').status_code == 404


@pytest.mark.django_db
def test_live_goes_quiet_when_collector_stale(client, collected):
    assert client.get('/api/live.json').json()['feeders_online'] == 2
    Status.objects.update(last_poll=timezone.now() - timedelta(minutes=10))
    d = client.get('/api/live.json').json()
    assert d['ok'] is False and d['feeders_online'] == 0


@pytest.mark.django_db
def test_cell_api(client, collected):
    la, lo = readsb.cell_of(34.0, -117.8)
    d = client.get(f'/api/cell.json?la={la}&lo={lo}&res=1').json()
    assert d['feeders'][0]['uuid'] == BEE
    assert client.get('/api/cell.json?la=x').status_code == 400


# ─── Allow / deny files ───────────────────────────────────────────────────
@pytest.fixture
def feeders_dir(settings, tmp_path):
    settings.WHEREPLANE_FEEDERS_DIR = tmp_path / 'feeders'
    return settings.WHEREPLANE_FEEDERS_DIR


@pytest.fixture
def staff_client(client, db):
    User.objects.create_superuser('admin', 'a@example.com', 'x' * 16)
    client.login(username='admin', password='x' * 16)
    return client


def test_staff_requires_superuser(client, db):
    r = client.get('/staff/')
    assert r.status_code == 302 and '/admin/login/' in r['Location']
    User.objects.create_user('plain', password='y' * 16, is_staff=True)
    client.login(username='plain', password='y' * 16)
    assert client.get('/staff/').status_code == 302
    assert client.post('/staff/list/add', {'kind': 'deny', 'uuid': BEE}).status_code == 302
    assert not ListEntry.objects.exists()


def test_allow_deny_writes_files(staff_client, feeders_dir):
    r = staff_client.post('/staff/list/add', {'kind': 'allow', 'uuid': OTHER.upper(), 'note': 'Kauai test\nstation'})
    assert r.status_code == 302
    staff_client.post('/staff/list/add', {'kind': 'deny', 'uuid': BEE})
    staff_client.post('/staff/list/add', {'kind': 'deny', 'uuid': 'nope'})
    allow = (feeders_dir / 'allow.txt').read_text()
    deny = (feeders_dir / 'deny.txt').read_text()
    assert lists.parse(allow) == [OTHER]
    assert lists.parse(deny) == [BEE]
    assert '# Kauai test station' in allow                    # newline in the note can't start a line
    assert all(line.startswith('#') or line.strip() == '' or readsb.normalize_uuid(line.split('#')[0])
               for line in allow.splitlines())
    assert not list(feeders_dir.glob('.*'))                   # no temp files left
    e = ListEntry.objects.get(kind='deny')
    staff_client.post(f'/staff/list/{e.pk}/remove')
    assert lists.parse((feeders_dir / 'deny.txt').read_text()) == []


def test_write_all_creates_empty_files(db, feeders_dir):
    lists.write_all()
    assert lists.parse((feeders_dir / 'allow.txt').read_text()) == []
    assert (feeders_dir / 'deny.txt').read_text().startswith('# deny')


def test_staff_page_and_rename(staff_client, collected, feeders_dir, settings, tmp_path):
    st = tmp_path / 'readsbee.json'
    st.write_text(json.dumps({'rejected': [{'uuid': OTHER, 'reason': 'test-reason-x', 'count': 3, 'ip': IP}],
                              'flagged': [{'uuid': BEE, 'reason': 'test-flag-y'}]}))
    settings.WHEREPLANE_READSBEE_STATUS_FILE = str(st)
    html = staff_client.get('/staff/').content.decode()
    assert OTHER in html and 'test-reason-x' in html and 'test-flag-y' in html and IP not in html
    # readsbee's reasons and flags are for staff only
    for url in ('/', '/feeders/', f'/feeder/{BEE}/', '/coverage/'):
        public = Client().get(url).content.decode()
        assert 'test-reason-x' not in public and 'test-flag-y' not in public
    bee = Feeder.objects.get(uuid=BEE)
    staff_client.post(f'/staff/feeder/{bee.pk}', {'name': 'Rooftop', 'hidden': '1'})
    bee.refresh_from_db()
    assert bee.name == 'Rooftop' and bee.hidden


def test_readsbee_status_formats(settings, tmp_path):
    p = tmp_path / 'r'
    settings.WHEREPLANE_READSBEE_STATUS_FILE = str(p)
    assert lists.readsbee_status() == {'rejected': [], 'flagged': [], 'missing': True}
    p.write_text(f'# rejected\n{OTHER}\njunk\n')
    assert lists.readsbee_status()['rejected'] == [{'uuid': OTHER}]
    p.write_text(json.dumps([OTHER, {'uuid': BEE, 'reason': 'r'}]))
    assert [r['uuid'] for r in lists.readsbee_status()['rejected']] == [OTHER, BEE]
    p.write_text(json.dumps({'rejected': [], 'flagged': [BEE, 'nope']}))
    assert lists.readsbee_status()['flagged'] == [{'uuid': BEE}]


def test_readsbee_json(settings, tmp_path):
    """The file readsbee writes (--net-uuid-status-dir, readsbee.c)."""
    p = tmp_path / 'readsbee.json'
    settings.WHEREPLANE_READSBEE_STATUS_FILE = str(p)
    p.write_text(json.dumps({
        'now': 1793919125.0, 'filter': {'active': True, 'max_sources': 2, 'reuse_action': 'flag'},
        'rejected_connections': {'policy': 3}, 'dropped_messages': {'pending': 10}, 'reuse_flagged': 1,
        'rejected': [{'uuid': OTHER, 'reason': 'policy', 'code': 2, 'open': 1, 'connections': 3,
                      'first': 1793900000, 'last': 1793919000}],
        'receivers': [{'uuid': BEE, 'state': 'ok', 'code': 0, 'sources': 3, 'flagged': True, 'dropped': 0, 'ext': {'ec': 5}},
                      {'uuid': BEE, 'state': 'ok', 'code': 0, 'sources': 3, 'flagged': True, 'dropped': 0},
                      {'uuid': BEE2, 'state': 'ok', 'code': 0, 'sources': 1, 'flagged': False, 'dropped': 0},
                      {'uuid': None, 'state': 'pending', 'code': 0, 'sources': 0, 'flagged': False, 'dropped': 4}],
    }))
    got = lists.readsbee_status()
    assert not got['missing']
    r = got['rejected'][0]
    assert (r['uuid'], r['reason'], r['code'], r['count']) == (OTHER, 'policy', 2, 3)
    assert r['last_seen'].timestamp() == 1793919000
    assert got['flagged'] == [{'uuid': BEE, 'reason': 'reuse', 'sources': 3}]
