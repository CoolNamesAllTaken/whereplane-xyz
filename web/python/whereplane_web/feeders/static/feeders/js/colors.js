/*
 * Altitude band colors: --band-0 (ground) to --band-6 (30k+) in site.css, an ordered ramp from the brand yellow to
 * forest green, with its own steps in dark mode. Read from CSS so the map follows the theme.
 */
export function bandColor(band) {
    return getComputedStyle(document.documentElement).getPropertyValue(`--band-${band}`).trim() || '#5E9F4B';
}
