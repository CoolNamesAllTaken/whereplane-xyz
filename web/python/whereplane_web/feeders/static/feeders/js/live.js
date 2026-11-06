// Home page: refresh the live numbers every 15 s from /api/live.json.
(function () {
    const box = document.getElementById('live');
    if (!box) { return; }
    const fmt = n => Number(n).toLocaleString('en-US');
    async function tick() {
        try {
            const r = await fetch(box.dataset.api, {cache: 'no-store'});
            const d = await r.json();
            box.querySelectorAll('[data-k]').forEach(el => { el.textContent = fmt(d[el.dataset.k] ?? 0); });
            box.classList.toggle('stale', !d.ok);
            box.title = d.ok ? '' : 'Data is a few minutes old';
        } catch (e) { /* keep the last numbers */ }
    }
    box.querySelectorAll('[data-k]').forEach(el => { el.textContent = fmt(el.textContent); });
    setInterval(tick, 15000);
})();
