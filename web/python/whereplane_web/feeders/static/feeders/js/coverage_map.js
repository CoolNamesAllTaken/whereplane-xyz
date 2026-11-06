/*
 * Coverage map (templates/feeders/_map.html). Cells where feeders heard aircraft's own ADS-B
 * positions, per altitude band, on OSM tiles through our caching proxy (/tiles).
 *
 * 3D: each band is a slab stacked at its own height (equal thickness, not to scale), so every
 * altitude shows at once; tilt and turn with right-drag or two fingers. 2D: each cell colored by
 * the lowest shown band heard there. Band colors: tar1090's altitude ramp (colors.js).
 * Hover: band and feeder count. Click: the feeders that heard that cell (/api/cell.json).
 * Data: /api/coverage.json, refreshed every 2 minutes.
 */
import * as maplibregl from 'maplibre-gl';
import {bandColor} from 'wp/colors';

const root = document.getElementById('coverage');
const mode = root.dataset.mode;                      // full | preview | feeder
const feeder = root.dataset.feeder;
let windowKey = root.dataset.window || '24h';
const res = mode === 'feeder' ? 1 : 2;
const tip = document.getElementById('map-tip');
const empty = document.getElementById('map-empty');
const dark = () => document.documentElement.getAttribute('data-bs-theme') === 'dark';
const esc = t => String(t).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

maplibregl.setWorkerUrl(new URL(root.dataset.worker, location.href).href);

let data = null, bands = [], colors = [];
let shown = new Set();            // visible band indexes
let tilted = mode !== 'preview';
const PITCH = root.clientWidth < 600 ? 50 : 55;

function rasterPaint() {
    return dark() ? {'raster-brightness-min': 0.92, 'raster-brightness-max': 0.08, 'raster-hue-rotate': 180,
                     'raster-saturation': -0.4, 'raster-contrast': 0.1}
                  : {'raster-brightness-min': 0, 'raster-brightness-max': 1, 'raster-hue-rotate': 0,
                     'raster-saturation': -0.35, 'raster-contrast': 0};
}
function skyOf() {
    const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim() || (dark() ? '#0A1510' : '#F4F8F5');
    return {'sky-color': bg, 'horizon-color': bg, 'fog-color': bg, 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.5, 'fog-ground-blend': 1};
}

const map = new maplibregl.Map({
    container: 'coverage-map',
    style: {
        version: 8,
        sources: {
            osm: {type: 'raster', tiles: ['/tiles/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19,
                  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'},
            cells: {type: 'geojson', data: {type: 'FeatureCollection', features: []}},
            flat: {type: 'geojson', data: {type: 'FeatureCollection', features: []}},
        },
        layers: [{id: 'osm', type: 'raster', source: 'osm', paint: rasterPaint()}],
        sky: skyOf(),
    },
    center: [-98, 39], zoom: 3, maxPitch: 75,
    pitch: tilted ? PITCH : 0,
    interactive: mode !== 'preview',
    attributionControl: {compact: true},
    preserveDrawingBuffer: true,
});

// ─── Shapes ─────────────────────────────────────────────────────────────────
function cellRing(la, lo) {
    const step = data.cell_deg;
    const s = la * step - 90, w = lo * step - 180, n = s + step, e = w + step;
    return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}
function slab(band) {
    // Equal thickness per band, scaled to the cell size so slabs look like stacked tiles.
    const h = data.cell_deg * 111000 * (res === 1 ? 0.45 : 0.4);
    return [band * h, band * h + 0.8 * h];
}

function buildFeatures() {
    const features = data.cells.map(([la, lo, band, n, hits], i) => {
        const [base, top] = slab(band);
        return {type: 'Feature', id: i, geometry: {type: 'Polygon', coordinates: [cellRing(la, lo)]},
                properties: {la, lo, band, n, hits, base, top, color: colors[band]}};
    });
    map.getSource('cells').setData({type: 'FeatureCollection', features});
    buildFlat();
}

// 2D: one square per cell, the lowest shown band heard there.
function buildFlat() {
    const low = new Map();
    for (const [la, lo, band, n] of data.cells) {
        if (!shown.has(band)) { continue; }
        const k = `${la},${lo}`;
        const cur = low.get(k);
        if (!cur || band < cur.band) { low.set(k, {la, lo, band, n}); }
    }
    const features = [...low.values()].map((c, i) => ({
        type: 'Feature', id: i, geometry: {type: 'Polygon', coordinates: [cellRing(c.la, c.lo)]},
        properties: {...c, color: colors[c.band]}}));
    map.getSource('flat').setData({type: 'FeatureCollection', features});
}

function addLayers() {
    // Low bands first: a translucent slab hides what is behind its own front face.
    bands.forEach((_b, i) => {
        map.addLayer({
            id: `band-${i}`, type: 'fill-extrusion', source: 'cells', filter: ['==', ['get', 'band'], i],
            layout: {visibility: tilted && shown.has(i) ? 'visible' : 'none'},
            paint: {
                'fill-extrusion-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#ffffff', ['get', 'color']],
                'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'top'],
                'fill-extrusion-opacity': 0.82, 'fill-extrusion-vertical-gradient': true,
            },
        });
    });
    map.addLayer({
        id: 'flat', type: 'fill', source: 'flat', layout: {visibility: tilted ? 'none' : 'visible'},
        paint: {'fill-color': ['get', 'color'],
                'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.9, 0.55],
                'fill-outline-color': 'rgba(0,0,0,0)'},
    });
}
const queryLayers = () => (tilted ? bands.map((_b, i) => `band-${i}`).filter(id => shown.has(Number(id.slice(5)))) : ['flat']);

function applyVisibility() {
    bands.forEach((_b, i) => map.setLayoutProperty(`band-${i}`, 'visibility', tilted && shown.has(i) ? 'visible' : 'none'));
    map.setLayoutProperty('flat', 'visibility', tilted ? 'none' : 'visible');
    document.querySelectorAll('#band-chips .band-chip').forEach(c => c.classList.toggle('on', shown.has(Number(c.dataset.band))));
    buildFlat();
}

// Where most of the coverage is: median ± 1.5 IQR of cell centers (per axis), inside the full extent.
// Feeders are spread over continents; fitting every outlier would show the whole world.
function bulkBounds(all) {
    const step = data.cell_deg;
    const lats = data.cells.map(([la]) => la * step - 90 + step / 2).sort((a, b) => a - b);
    const lons = data.cells.map(([, lo]) => lo * step - 180 + step / 2).sort((a, b) => a - b);
    const q = (xs, f) => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))];
    if (all) { return [[lons[0], lats[0]], [lons.at(-1) + step, lats.at(-1) + step]]; }
    const box = xs => {
        const m = q(xs, 0.5), iqr = Math.max(q(xs, 0.75) - q(xs, 0.25), 1);
        return [Math.max(xs[0], m - 1.5 * iqr), Math.min(xs.at(-1) + step, m + 1.5 * iqr)];
    };
    const [s, n] = box(lats), [w, e] = box(lons);
    return [[w, s], [e, n]];
}

const tiltButton = () => root.querySelector('button[title="3D slabs or flat map"]');
function fit(animate, all) {
    if (!data.cells.length) { return; }
    const pad = mode === 'preview' ? 16 : 40;
    const cam = map.cameraForBounds(bulkBounds(all || mode === 'feeder'), {padding: pad});
    if (!cam) { return; }
    // Slabs are only readable from about state scale in; farther out, start flat.
    if (!animate && mode !== 'preview' && cam.zoom < 4.5 && tilted) {
        tilted = false;
        tiltButton()?.classList.remove('on');
        applyVisibility();
    }
    const view = {center: cam.center, zoom: Math.min(cam.zoom - (tilted ? 0.3 : 0), 10), pitch: tilted ? PITCH : 0, bearing: 0};
    if (animate) { map.flyTo({...view, duration: 1200}); } else { map.jumpTo(view); }
}

// ─── Data ───────────────────────────────────────────────────────────────────
async function load(refit) {
    const q = new URLSearchParams({w: windowKey, res: String(res)});
    if (feeder) { q.set('feeder', feeder); }
    const r = await fetch(`${root.dataset.api}?${q}`);
    data = await r.json();
    if (!bands.length) {
        bands = data.bands;
        colors = bands.map((b, i) => bandColor(i, b.mid_ft));
        shown = new Set(bands.map((_b, i) => i));
        addLayers();
        paintChips();
    }
    buildFeatures();
    empty.hidden = data.cells.length > 0;
    if (refit) { fit(false); }
}

// ─── Controls ───────────────────────────────────────────────────────────────
function paintChips() {
    document.querySelectorAll('#band-chips .band-chip').forEach(chip => {
        const b = Number(chip.dataset.band);
        chip.querySelector('.sw').style.background = colors[b];
        chip.style.borderColor = colors[b];
        chip.addEventListener('click', () => {
            if (shown.has(b) && shown.size > 1) { shown.delete(b); } else { shown.add(b); }
            applyVisibility();
        });
        chip.addEventListener('dblclick', () => { shown = new Set([b]); applyVisibility(); });
    });
}

document.querySelectorAll('[data-window]').forEach(a => {
    if (!a.closest('.map-bar')) { return; }
    a.addEventListener('click', e => {
        e.preventDefault();
        windowKey = a.dataset.window;
        document.querySelectorAll('.map-bar [data-window]').forEach(x => x.classList.toggle('on', x === a));
        const u = new URL(location.href); u.searchParams.set('w', windowKey); history.replaceState(null, '', u);
        closePanel();
        load(false);
    });
});

if (mode !== 'preview') {
    map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), 'top-right');
    const group = document.createElement('div');
    group.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const mk = (text, title, fn) => {
        const b = document.createElement('button');
        b.type = 'button'; b.title = title; b.innerHTML = `<span class="ctrl-icon">${text}</span>`;
        b.addEventListener('click', fn); group.appendChild(b); return b;
    };
    const tiltBtn = mk('3D', '3D slabs or flat map', () => {
        tilted = !tilted;
        tiltBtn.classList.toggle('on', tilted);
        applyVisibility();
        map.easeTo({pitch: tilted ? PITCH : 0, bearing: tilted ? map.getBearing() : 0, duration: 700});
    });
    tiltBtn.classList.toggle('on', tilted);
    mk('⤢', 'Fit everything', () => fit(true, true));
    map.addControl({onAdd: () => group, onRemove() {}}, 'top-right');
    const note = document.createElement('div');
    note.className = 'map-scale';
    note.textContent = '↕ bands stacked, not to scale';
    note.title = 'Each altitude band is a slab at its own height; slab heights are not to scale, distances are';
    root.appendChild(note);
}

// ─── Hover and click ────────────────────────────────────────────────────────
let hovered = null;
function setHover(f) {
    const key = f ? {source: f.source, id: f.id} : null;
    if (hovered && (!key || hovered.source !== key.source || hovered.id !== key.id)) {
        map.setFeatureState(hovered, {hover: false});
    }
    hovered = key;
    if (key) { map.setFeatureState(key, {hover: true}); }
}
function showTip(e, f) {
    if (!f) { tip.hidden = true; setHover(null); map.getCanvas().style.cursor = ''; return; }
    setHover(f);
    map.getCanvas().style.cursor = 'pointer';
    const p = f.properties, b = bands[p.band];
    tip.innerHTML = `<span class="sw" style="background:${p.color}"></span>${esc(b.label)} ft · ● ${p.n} feeder${p.n === 1 ? '' : 's'}`;
    const box = root.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = `${Math.max(8, Math.min(e.point.x + 14, box.width - tip.offsetWidth - 8))}px`;
    tip.style.top = `${Math.min(e.point.y + 14, box.height - tip.offsetHeight - 8)}px`;
}
const featureAt = point => map.queryRenderedFeatures(point, {layers: queryLayers()})[0] || null;

let panel = null;
function closePanel() { if (panel) { panel.remove(); panel = null; } }
async function openPanel(p) {
    closePanel();
    panel = document.createElement('div');
    panel.className = 'map-panel';
    panel.innerHTML = `<header>◎ ${(p.la * data.cell_deg - 90 + data.cell_deg / 2).toFixed(1)}°, ${(p.lo * data.cell_deg - 180 + data.cell_deg / 2).toFixed(1)}° <button type="button" title="Close">×</button></header><ul><li class="muted">…</li></ul>`;
    panel.querySelector('button').addEventListener('click', closePanel);
    root.appendChild(panel);
    const q = new URLSearchParams({la: p.la, lo: p.lo, res: String(res), w: windowKey});
    const d = await (await fetch(`${root.dataset.cellApi}?${q}`)).json();
    if (!panel) { return; }
    const strip = got => bands.map((b, i) => `<i class="${got.includes(i) ? '' : 'no'}" style="background:${colors[i]}" title="${esc(b.label)}${got.includes(i) ? ' ✓' : ''}"></i>`).join('');
    const base = root.dataset.feederUrl.replace(/feeders\/$/, 'feeder/');
    panel.querySelector('ul').innerHTML = d.feeders.length ? d.feeders.map(f =>
        `<li><span class="status ${f.online ? 'online' : 'offline'}" title="${f.online ? 'online' : 'offline'}"><span class="dot"></span></span>`
        + `<a href="${base}${encodeURIComponent(f.uuid)}/">${esc(f.name)}</a><span class="bands">${strip(f.bands)}</span></li>`).join('')
        : '<li class="muted">○ None</li>';
}

if (mode !== 'preview') {
    map.on('mousemove', e => showTip(e, featureAt(e.point)));
    map.on('mouseout', () => showTip(null, null));
    map.on('click', e => {
        const f = featureAt(e.point);
        showTip(e, f);
        if (f) { openPanel(f.properties); } else { closePanel(); }
    });
}

// ─── Theme, start, refresh ──────────────────────────────────────────────────
function applyTheme() {
    Object.entries(rasterPaint()).forEach(([k, v]) => map.setPaintProperty('osm', k, v));
    map.setSky(skyOf());
}
new MutationObserver(() => { if (map.isStyleLoaded()) { applyTheme(); } })
    .observe(document.documentElement, {attributes: true, attributeFilter: ['data-bs-theme']});

// The box can change size after the map starts (fonts, layout): keep the canvas matched.
new ResizeObserver(() => map.resize()).observe(root);

map.on('load', async () => {
    map.resize();
    try {
        await load(true);
    } catch (e) {
        empty.textContent = '⚠ Coverage unavailable';
        empty.hidden = false;
        console.warn('coverage', e);
    }
    root.classList.add('is-ready');
    setInterval(() => load(false), 120000);
});

window.coverageMap = {map, fit, setTilt: on => { if (on !== tilted) { root.querySelector('.ctrl-icon')?.parentElement.click(); } },
                      solo: b => { shown = new Set(b === null ? bands.map((_x, i) => i) : [b]); applyVisibility(); }};
