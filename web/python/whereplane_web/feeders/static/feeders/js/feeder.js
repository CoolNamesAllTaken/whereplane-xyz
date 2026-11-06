/*
 * Feeder page: one uPlot chart per measure (one axis each), shared cursor, a value tooltip on
 * hover; 24h / 7d / 30d from /api/feeder/<uuid>/series.json. Also colors the range bars by band.
 */

const box = document.getElementById('charts');
const css = name => getComputedStyle(document.body).getPropertyValue(name).trim();
const fmt = (v, d = 0) => (v == null ? '–' : Number(v).toLocaleString('en-US', {maximumFractionDigits: d}));
let windowKey = box.dataset.window;
let plots = [];

// Range bars and swatches: the band colors from site.css.
document.querySelectorAll('.band-sw[data-band]').forEach(el => { el.style.background = `var(--band-${el.dataset.band})`; });
document.querySelectorAll('.rbar[data-band]').forEach(el => el.querySelectorAll('span').forEach(s => { s.style.background = `var(--band-${el.dataset.band})`; }));

document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); const was = b.innerHTML; b.textContent = '✓'; setTimeout(() => { b.innerHTML = was; }, 1200); } catch (e) { /* no clipboard */ }
}));

function tooltipPlugin(unit, digits) {
    let tip;
    return {hooks: {
        init: u => { tip = document.createElement('div'); tip.className = 'chart-tip'; tip.hidden = true; u.over.appendChild(tip); },
        setCursor: u => {
            const i = u.cursor.idx;
            const v = i == null ? null : u.data[1][i];
            if (i == null || v == null) { tip.hidden = true; return; }
            const t = new Date(u.data[0][i] * 1000);
            const when = windowKey === '24h' ? t.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
                                             : t.toLocaleDateString([], {month: 'short', day: 'numeric'}) + (unit === ' aircraft' ? '' : ' ' + t.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
            tip.textContent = `${fmt(v, digits)}${unit} · ${when}`;
            tip.hidden = false;
            const x = u.valToPos(u.data[0][i], 'x'), y = u.valToPos(v, 'y');
            tip.style.left = `${Math.min(Math.max(x - tip.offsetWidth / 2, 0), u.over.clientWidth - tip.offsetWidth)}px`;
            tip.style.top = `${Math.max(y - tip.offsetHeight - 10, 0)}px`;
        },
    }};
}

function draw(d) {
    plots.forEach(p => p.destroy());
    plots = [];
    const ink = css('--muted'), grid = css('--grid'), color = css('--chart');
    const sync = uPlot.sync('feeder');
    document.getElementById('online-pct').textContent = `${d.online_pct}%`;
    box.querySelectorAll('.chart').forEach(el => {
        const key = el.dataset.series;
        let xs, ys, bars = false;
        if (key === 'days') {
            xs = d.days.map(([day]) => Date.parse(day + 'T12:00:00Z') / 1000);
            ys = d.days.map(([, n]) => n);
            bars = true;
        } else {
            xs = d.t; ys = d[key];
            const last = [...ys].reverse().find(v => v != null);
            const now = box.querySelector(`[data-now="${key}"]`);
            if (now) { now.textContent = last == null ? '' : `${fmt(last, key === 'pos_s' ? 1 : 0)}${el.dataset.unit}`; }
        }
        const width = el.clientWidth || 300;
        const axis = {stroke: ink, grid: {stroke: grid, width: 1}, ticks: {show: false}, font: '11px Inter, sans-serif'};
        const opts = {
            width, height: 150, legend: {show: false},
            cursor: {sync: {key: sync.key}, points: {size: 8}, y: false},
            scales: {x: {time: true, range: () => (bars ? [d.from - 43200, d.to + 43200] : [d.from, d.to])}, y: {range: (u, min, max) => [0, Math.max(1, max * 1.1)]}},
            axes: [{...axis, space: 60}, {...axis, size: 42, values: (u, vals) => vals.map(v => fmt(v))}],
            series: [{}, bars
                ? {stroke: color, fill: color + '99', width: 0, paths: uPlot.paths.bars({size: [0.7, 40], radius: 0.2}), points: {show: false}}
                : {stroke: color, width: 2, fill: color + '1f', points: {show: false}, spanGaps: false}],
            plugins: [tooltipPlugin(el.dataset.unit, key === 'pos_s' ? 1 : 0)],
        };
        el.innerHTML = '';
        if (!xs.length) { el.innerHTML = '<p class="muted" style="padding-top:3rem;text-align:center">○ No data yet</p>'; return; }
        plots.push(new uPlot(opts, [xs, ys], el));
    });
}

async function load() {
    const r = await fetch(`${box.dataset.api}?w=${windowKey}`);
    draw(await r.json());
}

document.querySelectorAll('#series-windows [data-window]').forEach(b => b.addEventListener('click', () => {
    windowKey = b.dataset.window;
    document.querySelectorAll('#series-windows [data-window]').forEach(x => x.classList.toggle('on', x === b));
    load();
}));
new MutationObserver(load).observe(document.documentElement, {attributes: true, attributeFilter: ['data-bs-theme']});
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(load, 250); });
load();
