"""
The coverage map's slab heights (static/feeders/js/coverage_shapes.js), run in node: true band
altitudes times one page factor, picked as adsbee.aero's swarm range map does.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from feeders import queries, readsb

JS = Path(__file__).resolve().parents[1] / 'static' / 'feeders' / 'js'
needs_node = pytest.mark.skipif(not shutil.which('node'), reason='needs node')


def node(script: str):
    out = subprocess.run(['node', '--input-type=module', '-e', script], cwd=JS, capture_output=True,
                         text=True, check=True).stdout
    return json.loads(out)


def bands():
    return [{'low_ft': low, 'high_ft': high} for _k, _l, low, high in readsb.BANDS]


@needs_node
def test_exaggeration_matches_adsbee_aero():
    out = node("import {exaggeration} from './coverage_shapes.js';"
               "console.log(JSON.stringify([exaggeration(116500, 40000), exaggeration(421000, 40000),"
               " exaggeration(9000, 300), exaggeration(0, 100), exaggeration(1000, 50000), exaggeration(1e9, 100)]));")
    # 0.6 x 116.5 km / 40,000 ft = 5.7 -> 5; 421 km -> 20.7 -> 20; adsbee.aero's own test case 59 -> 50; caps at 100.
    assert out == [5, 20, 50, 1, 1, 100]


@needs_node
def test_slabs_use_true_band_altitudes_and_90_percent_band():
    # 95 cells at 3-10k and 5 in the open top band: the factor fits the 3-10k band, not 30k+.
    cells = [[0, i, 3, 1, 1] for i in range(95)] + [[1, i, 6, 1, 1] for i in range(5)]
    data = {'bands': bands(), 'cells': cells, 'ref_range_m': 116500}
    out = node("import {slabs, bandFt} from './coverage_shapes.js';"
               f"const data = {json.dumps(data)};"
               "console.log(JSON.stringify([slabs(data, 0), [0, 1, 2, 6].map(b => bandFt(data.bands, b)),"
               " slabs({...data, ref_range_m: null}, 116500).factor, slabs({...data, cells: []}, 0).factor]));")
    s, edges, fallback, no_cells = out
    assert s['factor'] == 20                                 # 0.6 x 116.5 km / 10,000 ft (3048 m) = 22.9
    assert edges == [[0, 100], [100, 1000], [1000, 3000], [30000, 40000]]
    ft = 0.3048 * 20
    assert s['heights'][3] == [pytest.approx(3000 * ft), pytest.approx(10000 * ft)]
    assert s['heights'][6] == [pytest.approx(30000 * ft), pytest.approx(40000 * ft)]
    assert fallback == 20 and no_cells == 5               # no cells: sized to the top band (40,000 ft)


@pytest.mark.django_db
def test_coverage_api_sends_band_edges_and_reference_range(monkeypatch):
    ranges = {i: 50 + 10 * i for i in range(1, 21)} | {21: 900, 22: None}     # 60..250 km, one odd 900 km
    monkeypatch.setattr(queries, 'max_ranges', lambda: ranges)
    d = queries.coverage('24h', res=2)
    assert [(b['low_ft'], b['high_ft']) for b in d['bands']] == [(low, high) for _k, _l, low, high in readsb.BANDS]
    assert d['ref_range_m'] == 240000                        # 90th percentile: the 900 km outlier is ignored
    monkeypatch.setattr(queries, 'max_ranges', lambda: {})
    assert queries.ref_range_m() is None
