/*
 * Slab heights for the coverage map (coverage_map.js), no map code here so node can test it
 * (feeders/tests/test_coverage_shapes.py).
 *
 * Each band is drawn from its true bottom to its true top altitude, times one factor for the whole
 * page, chosen as adsbee.aero's swarm range map does (PantsForBirds/adsbee-aero, range_shapes.js):
 * the top of the band below which 90 % of heard cells lie reaches about 60 % of the reference
 * distance, rounded down to a nice number. The reference distance (/api/coverage.json `ref_range_m`,
 * queries.ref_range_m) is a feeder's farthest range on its own page and, on the full map, the 90th
 * percentile of the feeders' farthest ranges, as adsbee.aero uses its widest bee.
 */
export const FT_M = 0.3048;
export const TOP_OPEN_FT = 10000;   // the open top band (30k+) is drawn this wide, as on adsbee.aero
export const GROUND_FT = 100;       // "on the ground" has no height: a thin plate under the <1k band

const NICE = [1, 2, 3, 5, 10, 15, 20, 30, 50, 100];
/** Height factor: `topFt` reaches about 60 % of `maxRangeM`, rounded down to a nice number (as adsbee.aero). */
export function exaggeration(maxRangeM, topFt) {
    if (!maxRangeM || !topFt) { return 1; }
    const want = 0.6 * maxRangeM / (topFt * FT_M);
    return NICE.filter(n => n <= want).pop() || 1;
}

/** [bottom, top] ft drawn for band `b` of the API's bands ({low_ft, high_ft}). */
export function bandFt(bands, b) {
    const {low_ft: low, high_ft: high} = bands[b];
    if (low === null && high === null) { return [0, GROUND_FT]; }                   // ground
    const bottom = low ?? (bands.some(x => x.low_ft === null && x.high_ft === null) ? GROUND_FT : 0);
    return [bottom, high ?? bottom + TOP_OPEN_FT];
}

/** The top (ft) of the band below which 90 % of heard cells ([la, lo, band, ...]) lie. */
export function typicalTopFt(bands, cells) {
    if (!cells.length) { return bandFt(bands, bands.length - 1)[1]; }
    const heard = cells.map(c => c[2]).sort((x, y) => x - y);
    return bandFt(bands, heard[Math.floor(0.9 * (heard.length - 1))])[1];
}

/** The page's factor and each band's [base, top] in meters, from the API payload. */
export function slabs(data, fallbackRangeM) {
    const factor = exaggeration(data.ref_range_m || fallbackRangeM, typicalTopFt(data.bands, data.cells));
    const heights = data.bands.map((_b, i) => bandFt(data.bands, i).map(ft => ft * FT_M * factor));
    return {factor, heights};
}

/** A cell's ring [[w, s], [e, s], [e, n], [w, n], [w, s]] (lng, lat) on the API's grid (index = floor((deg + 90 or 180) / step)). */
export function cellRing(la, lo, step) {
    const s = la * step - 90, w = lo * step - 180, n = s + step, e = w + step;
    return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}

/**
 * Slab pieces for cells [[la, lo, band, ...], ...]: per cell a lid (`{cell, ring, lid: true}`, drawn with no
 * thickness) and a thin wall strip on each side where the band's coverage ends (`{cell, ring, lid: false}`).
 * Walls between neighboring cells of the same band are left out, so a camera inside a band (near the ground)
 * sees out to where the band ends rather than the walls of the cell it stands in. `cell` = index into cells.
 */
export function slabPieces(cells, step) {
    const has = new Set(cells.map(([la, lo, band]) => `${la},${lo},${band}`));
    const t = step / 200;                                  // wall strip width: 50-100 m on the 0.1-0.2° grids
    const out = [];
    cells.forEach(([la, lo, band], cell) => {
        const ring = cellRing(la, lo, step);
        const [[w, s], , [e, n]] = ring;
        out.push({cell, ring, lid: true});
        const strip = (x0, y0, x1, y1) => out.push({cell, lid: false, ring: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]});
        if (!has.has(`${la - 1},${lo},${band}`)) { strip(w, s, e, s + t); }
        if (!has.has(`${la + 1},${lo},${band}`)) { strip(w, n - t, e, n); }
        if (!has.has(`${la},${lo - 1},${band}`)) { strip(w, s, w + t, n); }
        if (!has.has(`${la},${lo + 1},${band}`)) { strip(e - t, s, e, n); }
    });
    return out;
}

/**
 * Where the camera is, from the map's public view: {lng, lat, altM}. MapLibre's camera sits
 * height / 2 / tan(fov / 2) px from the center, tilted back by the pitch along the bearing.
 */
export function cameraSpot({lng, lat, zoom, pitch, bearing, heightPx, fovDeg}) {
    const rad = Math.PI / 180, world = 512 * 2 ** zoom;                    // world size in px (Web Mercator)
    const distPx = heightPx / 2 / Math.tan(fovDeg * rad / 2);
    const back = Math.sin(pitch * rad) * distPx;
    const x = (lng + 180) / 360 * world - back * Math.sin(bearing * rad);
    const y = (0.5 - Math.log(Math.tan(Math.PI / 4 + lat * rad / 2)) / (2 * Math.PI)) * world + back * Math.cos(bearing * rad);
    const mpp = 40075016.686 * Math.cos(lat * rad) / world;                // meters per px at the center
    return {lng: x / world * 360 - 180, lat: (2 * Math.atan(Math.exp((0.5 - y / world) * 2 * Math.PI)) - Math.PI / 2) / rad,
            altM: Math.cos(pitch * rad) * distPx * mpp};
}
