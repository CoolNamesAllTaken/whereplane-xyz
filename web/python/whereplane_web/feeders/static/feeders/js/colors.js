/*
 * tar1090's altitude colors (wiedehopf/tar1090 958e60e: html/defaults.js ColorByAlt.air,
 * html/planeObject.js altitudeColor): hue interpolated by altitude, lightness by hue,
 * saturation 88%. Low = orange, then yellow, green, cyan, blue, magenta high.
 */
const TAR1090_HUE = [[0, 20], [2000, 32.5], [4000, 43], [6000, 54], [8000, 72], [9000, 85], [11000, 140],
                     [40000, 300], [51000, 360]];
const TAR1090_LIGHT = [[0, 53], [20, 50], [32, 54], [40, 52], [46, 51], [50, 46], [60, 43], [80, 41], [100, 41],
                       [120, 41], [140, 41], [160, 40], [180, 40], [190, 44], [198, 50], [200, 58], [220, 58],
                       [240, 58], [255, 55], [266, 55], [270, 58], [280, 58], [290, 47], [300, 43], [310, 48],
                       [320, 48], [340, 52], [360, 53]];
function ramp(points, x) {
    if (x <= points[0][0]) { return points[0][1]; }
    for (let i = points.length - 1; i >= 0; i--) {
        if (x > points[i][0]) {
            if (i === points.length - 1) { return points[i][1]; }
            const [x0, y0] = points[i], [x1, y1] = points[i + 1];
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
        }
    }
    return points[0][1];
}
export function altitudeHsl(ft) {
    const h = ramp(TAR1090_HUE, ft);
    return [h, 88, ramp(TAR1090_LIGHT, h)];
}
// The aircraft band table (CONTRACT A); Remote ID borrows its colors by index.
export const AIRCRAFT_EDGES_FT = [0, 1000, 2000, 4000, 6000, 10000, 15000, 20000, 25000, 30000, 35000, 40000];

const hsl = ([h, s, l]) => `hsl(${h.toFixed(1)} ${s}% ${l.toFixed(1)}%)`;
/** Color of a band from its representative altitude (ft); band 0 (on the ground) is gray, as in tar1090. */
export function bandColor(band, midFt) {
    return band === 0 ? 'hsl(0 0% 55%)' : hsl(altitudeHsl(midFt));
}
