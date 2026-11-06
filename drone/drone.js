// whereplane: small-drone icon and Remote ID details for tar1090.
// nginx puts this script after tar1090's markers.js (08-pfb-drone). Everything is feature-tested:
// if tar1090 changes, this does nothing and drones keep tar1090's own icon.
(function () {
    'use strict';
    const NAME = 'pfb_drone';
    const POLL_MS = 3000;
    const log = (...a) => console.log('[pfb-drone]', ...a);

    // Quadcopter, top view: 4 rotor rings on an X frame, body pointing up (= track).
    // One path so the outline is drawn once under the fill (tar1090 draws paint-order stroke).
    function ring(cx, cy, r, ri) {
        return `M${cx - r} ${cy}a${r} ${r} 0 1 1 ${2 * r} 0a${r} ${r} 0 1 1 ${-2 * r} 0z`
            + `M${cx - ri} ${cy}a${ri} ${ri} 0 1 0 ${2 * ri} 0a${ri} ${ri} 0 1 0 ${-2 * ri} 0z`;
    }
    // Filled parts all wind clockwise (as the rings' outer circles), so overlaps stay filled.
    function poly(pts) {
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
            const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
            a += x1 * y2 - x2 * y1;
        }
        if (a < 0)
            pts = pts.slice().reverse();
        return 'M' + pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L') + 'z';
    }
    function arm(x1, y1, x2, y2, hw) {
        const dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy);
        const nx = -dy / l * hw, ny = dx / l * hw;
        return poly([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]);
    }
    const R = 5.6, RI = 3.4, C = 7.5;   // rotor ring radii, rotor centers at C / 32 - C
    const A = C + R * 0.62;             // arms start just inside the rings
    const SHAPE = {
        w: 22,
        h: 22,
        viewBox: '0 0 32 32',
        strokeScale: 1,
        path: [
            ring(C, C, R, RI) + ring(32 - C, C, R, RI) + ring(C, 32 - C, R, RI) + ring(32 - C, 32 - C, R, RI)
            + arm(A, A, 32 - A, 32 - A, 1.5) + arm(32 - A, A, A, 32 - A, 1.5)
            + poly([[16, 9.6], [20.2, 13.4], [20.2, 20.6], [11.8, 20.6], [11.8, 13.4]]),
        ].join(''),
    };

    // ─── Icon ────────────────────────────────────────────────────────────────
    let atlasURL = null;    // tar1090's WebGL sprite sheet plus the drone cell
    function webglOn() {
        try { return webgl; } catch (e) { return false; }
    }
    function droneUsable() {
        if (!webglOn())
            return true;    // SVG icons: the shape is enough
        try { return atlasURL !== null && spriteSrc === atlasURL; } catch (e) { return false; }
    }

    function addShape() {
        if (typeof shapes !== 'object' || typeof getBaseMarker !== 'function' || typeof svgShapeToURI !== 'function'
            || typeof getSpriteX !== 'function' || typeof getSpriteY !== 'function' || typeof glIconSize !== 'number')
            return false;
        if (!shapes.uav || shapes[NAME])
            return false;
        SHAPE.name = NAME;
        SHAPE.id = Object.keys(shapes).length;
        shapes[NAME] = SHAPE;
        const stock = getBaseMarker;
        // tar1090's B6 (UAV) icon is 'uav' (an MQ-9 outline); readsbee drones are B6 with type 'other'.
        getBaseMarker = function (category, typeDesignator, typeDescription, wtc, addrtype) {
            const m = stock.apply(this, arguments);
            try {
                if (m && m[0] === 'uav' && category === 'B6' && addrtype === 'other' && droneUsable())
                    return [NAME, 1];
            } catch (e) { /* keep stock */ }
            return m;
        };
        return true;
    }

    // WebGL draws icons from a prebuilt sprite sheet. Copy it, draw the drone into its cell
    // (as tar1090's iconTest() does), then useAtlas().
    function buildAtlas() {
        let src;
        try { src = spriteSrc; } catch (e) { return; }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
            try {
                const size = glIconSize;
                const can = document.createElement('canvas');
                can.width = Math.max(img.width, (getSpriteX(SHAPE) + 1) * size);
                can.height = Math.max(img.height, (getSpriteY(SHAPE) + 1) * size);
                const ctx = can.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const scale = size / Math.max(SHAPE.w, SHAPE.h);
                const cell = new Image();
                cell.onload = function () {
                    try {
                        ctx.drawImage(cell, getSpriteX(SHAPE) * size, getSpriteY(SHAPE) * size);
                        useAtlas(can.toDataURL());
                    } catch (e) { log('atlas', e); }
                };
                cell.src = svgShapeToURI(SHAPE, '#FFFFFF', '#000000', outlineWidth * 0.75, scale);
            } catch (e) { log('atlas', e); }
        };
        img.src = src;
    }

    // tar1090 builds its WebGL layer from spritesDataURL (when set) or spriteSrc. The layer usually
    // exists by now, so build a new one through tar1090's own webglAddLayer() and drop the old one;
    // if anything fails, the old layer goes back and drones keep the stock icon.
    function useAtlas(url) {
        const oldSrc = spriteSrc;
        spritesDataURL = url;
        atlasURL = url;
        if (!webglLayer || !webgl || heatmap)
            return log('sprite sheet ready');
        const old = webglLayer;
        let ok = false;
        try {
            layers.remove(old);
            ok = webglAddLayer();
        } catch (e) { log('webgl layer', e); }
        if (!ok) {
            try { if (webglLayer && webglLayer !== old) layers.remove(webglLayer); } catch (e) { /* gone */ }
            webglLayer = old;
            if (layers.getArray().indexOf(old) < 0)
                layers.push(old);
            spriteSrc = oldSrc;
            spritesDataURL = null;
            atlasURL = null;
            return log('sprite sheet not used: stock drone icon');
        }
        // its renderer still listens to the shared feature source; dispose() detaches it (the source stays)
        try { old.dispose(); } catch (e) { log('old layer', e); }
        for (const plane of g.planesOrdered) {
            if (plane.category === 'B6') {
                plane.baseMarkerKey = null;     // pick the shape again
                try { plane.updateMarker(); } catch (e) { /* next refresh */ }
            }
        }
        log('sprite sheet in use');
    }

    // ─── Remote ID: details panel and operator marker ────────────────────────
    let rid = {};           // hex -> drone from remoteid.json
    let layer = null, source = null;
    const OP_ICON = 'data:image/svg+xml;base64,' + btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">'
        + '<g fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round">'
        + '<path d="M9 2.5V6" fill="none"/><circle cx="9" cy="2.4" r="1.2"/>'
        + '<rect x="2" y="6" width="14" height="9" rx="3"/></g>'
        + '<g fill="#000"><circle cx="6" cy="10.5" r="1.6"/><circle cx="12" cy="10.5" r="1.6"/></g></svg>');

    function esc(s) {
        return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }
    function km(lat1, lon1, lat2, lon2) {
        const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2
            + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
        return 12742 * Math.asin(Math.sqrt(a));
    }
    function dist(k) {
        try {
            if (typeof format_distance_long === 'function')
                return format_distance_long(k * 1000, DisplayUnits, 2);
        } catch (e) { /* fall through */ }
        return k.toFixed(2) + ' km';
    }

    const LINKS = { bt4_legacy: 'Bluetooth 4', bt5_coded: 'Bluetooth 5 LR', bt5_ext_1m: 'Bluetooth 5',
        wifi_beacon: 'Wi-Fi beacon', wifi_nan: 'Wi-Fi NAN' };
    let panel = null;
    function makePanel() {
        const spatial = document.getElementById('spatial_block');
        if (!spatial || !spatial.previousElementSibling)
            return;
        const title = spatial.previousElementSibling;
        panel = document.createElement('div');
        panel.id = 'pfb_rid';
        panel.style.display = 'none';
        panel.innerHTML = '<div class="sectionTitle"><div class="section-title-content">REMOTE ID</div></div>'
            + '<div class="infoBlockSection"><table class="infoSectionTable"><tbody></tbody></table></div>';
        title.parentNode.insertBefore(panel, title);
    }
    function row(label, value, tip) {
        return `<tr><td><span class="infoHeading" title="${esc(tip)}">${esc(label)}:</span> `
            + `<span class="infoData">${value}</span></td></tr>`;
    }
    function updatePanel() {
        if (!panel)
            return;
        let d = null;
        try { d = SelectedPlane && rid[SelectedPlane.icao]; } catch (e) { /* none */ }
        if (!d) {
            panel.style.display = 'none';
            return;
        }
        let html = '';
        if (d.id)
            html += row('UAS ID', esc(d.id), 'Drone ID it broadcasts (' + (d.id_type || '') + ')');
        if (d.self_id)
            html += row('Self-ID', esc(d.self_id), 'Description the operator set');
        if (d.operator_id)
            html += row('Operator ID', esc(d.operator_id), 'Registration of the operator');
        const op = d.operator;
        if (op && isFinite(op.lat) && isFinite(op.lon)) {
            let where = `${op.lat.toFixed(4)}°, ${op.lon.toFixed(4)}°`;
            if (isFinite(d.lat) && isFinite(d.lon))
                where += ` · ${dist(km(d.lat, d.lon, op.lat, op.lon))}`;
            html += row('Operator', where, 'Operator location (' + (op.loc_type || '') + '), distance to the drone');
        }
        if (d.transports && d.transports.length)
            html += row('Link', esc(d.transports.map(t => LINKS[t] || t).join(', ')), 'How it was received');
        panel.querySelector('tbody').innerHTML = html;
        panel.style.display = html ? '' : 'none';
    }

    function makeLayer() {
        if (layer || typeof ol === 'undefined' || typeof OLMap === 'undefined' || !OLMap)
            return;
        source = new ol.source.Vector();
        layer = new ol.layer.Vector({
            source: source, zIndex: 150, declutter: false,
            properties: { name: 'pfb_rid_operators', title: 'Drone operators' },
        });
        OLMap.addLayer(layer);
    }
    const lineStyle = typeof ol !== 'undefined' ? [
        new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,0.55)', width: 3.5 }) }),
        new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#fff', width: 1.5, lineDash: [4, 4] }) }),
    ] : null;
    const opStyle = typeof ol !== 'undefined' ? new ol.style.Style({ image: new ol.style.Icon({ src: OP_ICON }) }) : null;

    function updateLayer() {
        makeLayer();
        if (!source)
            return;
        source.clear();
        for (const hex in rid) {
            const d = rid[hex], op = d.operator;
            if (!op || !isFinite(op.lat) || !isFinite(op.lon))
                continue;
            const plane = g.planes && g.planes[hex];
            if (!plane || !plane.position || plane.visible === false)
                continue;   // filtered out (?feed=, filters) or no position: no operator either
            const o = ol.proj.fromLonLat([op.lon, op.lat]);
            const p = ol.proj.fromLonLat(plane.position);
            const line = new ol.Feature(new ol.geom.LineString([o, p]));
            line.setStyle(lineStyle);
            const pt = new ol.Feature(new ol.geom.Point(o));
            pt.setStyle(opStyle);
            pt.set('pfbDrone', hex);
            source.addFeatures([line, pt]);
        }
    }

    async function poll() {
        try {
            const r = await fetch('data/remoteid.json', { cache: 'no-store' });
            if (r.ok) {
                const j = await r.json();
                const next = {};
                for (const d of (j.drones || []))
                    if (d.hex)
                        next[d.hex.toLowerCase()] = d;
                rid = next;
            }
        } catch (e) { /* no file: nothing to show */ }
        try { updatePanel(); updateLayer(); } catch (e) { log('rid', e); }
    }

    function hookUi() {
        try {
            makePanel();
            if (typeof refreshSelected === 'function') {
                const stock = refreshSelected;
                refreshSelected = function () {
                    const r = stock.apply(this, arguments);
                    try { updatePanel(); } catch (e) { /* ignore */ }
                    return r;
                };
            }
        } catch (e) { log('panel', e); }
        // a click on an operator selects its drone (a DOM click: tar1090's map click handler stops
        // OpenLayers propagation, and deselects first, which is fine)
        const tryClick = setInterval(function () {
            try {
                if (typeof OLMap === 'undefined' || !OLMap)
                    return;
                clearInterval(tryClick);
                makeLayer();
                OLMap.getViewport().addEventListener('click', function (e) {
                    OLMap.forEachFeatureAtPixel(OLMap.getEventPixel(e), function (f) {
                        const hex = f.get('pfbDrone');
                        if (hex && typeof selectPlaneByHex === 'function') {
                            selectPlaneByHex(hex, { follow: false });
                            return true;
                        }
                    }, { layerFilter: l => l === layer, hitTolerance: 4 });
                });
            } catch (e) { clearInterval(tryClick); log('layer', e); }
        }, 500);
        poll();
        setInterval(function () { if (!document.hidden) poll(); }, POLL_MS);
    }

    try {
        if (addShape()) {
            // spriteSrc and the WebGL layer come from scripts after this one
            document.addEventListener('DOMContentLoaded', buildAtlas);
        }
    } catch (e) { log('icon', e); }
    document.addEventListener('DOMContentLoaded', hookUi);
})();
