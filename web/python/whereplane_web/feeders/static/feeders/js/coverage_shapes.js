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
