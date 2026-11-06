/*
 * Altitude band colors: --band-0 (ground) to --band-6 (30k+) in site.css, tar1090's altitude colors at each band's
 * middle, the same in both themes. Read from CSS so the map, legend and range table share one definition.
 */
export function bandColor(band) {
    return getComputedStyle(document.documentElement).getPropertyValue(`--band-${band}`).trim() || '#888888';
}
