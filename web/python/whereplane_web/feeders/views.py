from __future__ import annotations

from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import user_passes_test
from django.db import IntegrityError
from django.http import Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_POST

from . import lists, queries, readsb
from .models import Feeder, ListEntry, Status


def site_context(request):
    return {'globe_url': settings.WHEREPLANE_GLOBE_URL, 'feed_host': settings.WHEREPLANE_FEED_HOST}


def _bands():
    return [{'i': i, 'label': b[1], 'tip': t, 'mid_ft': m}
            for i, (b, t, m) in enumerate(zip(readsb.BANDS, readsb.BAND_TIPS, readsb.BAND_MID_FT))]


def duration(td) -> str:
    """'3 d 4 h', '5 h 12 m', '7 m'."""
    s = max(int(td.total_seconds()), 0)
    d, h, m = s // 86400, s % 86400 // 3600, s % 3600 // 60
    if d:
        return f'{d} d {h} h'
    if h:
        return f'{h} h {m} m'
    return f'{m} m'


# ─── Pages ──────────────────────────────────────────────────────────────────
def home(request):
    return render(request, 'feeders/home.html', {'nav': 'home', 'live': queries.live(), 'bands': _bands()})


def coverage(request):
    return render(request, 'feeders/coverage.html', {
        'nav': 'map', 'bands': _bands(), 'window': queries.window_of(request.GET.get('w')),
        'windows': list(queries.WINDOWS)})


def feeder_list(request):
    ranges = queries.max_ranges()
    feeders = list(queries.public_feeders())
    for f in feeders:
        f.max_km = ranges.get(f.pk)
    return render(request, 'feeders/feeders.html', {
        'nav': 'feeders', 'feeders': feeders, 'live': queries.live(),
        'rates': any(f.online and f.msgs_s is not None for f in feeders),
        'online': sum(f.online for f in feeders)})


def _public_feeder(uuid):
    f = get_object_or_404(Feeder, queries.public_q(), uuid=(uuid or '').lower())
    return f


def feeder_page(request, uuid):
    f = _public_feeder(uuid)
    ranges = queries.feeder_ranges(f)
    rows = [{**b, 'range': r} for b, r in zip(_bands(), ranges)]
    top = max([r['max_km'] for r in ranges if r] or [0])
    return render(request, 'feeders/feeder.html', {
        'nav': 'feeders', 'f': f, 'bands': _bands(), 'ranges': rows, 'range_top': top or 1,
        'distinct_today': max(queries.distinct_today(f), f.aircraft_now if f.online else 0),
        'uptime': duration(timezone.now() - f.connected_since) if f.online and f.connected_since else None,
        'window': queries.window_of(request.GET.get('w')), 'windows': list(queries.WINDOWS),
        'series_window': queries.window_of(request.GET.get('w')) if request.GET.get('w') in ('24h', '7d', '30d') else '24h',
        'fresh': queries.fresh()})


# ─── JSON ───────────────────────────────────────────────────────────────────
def _json(data, max_age=30):
    r = JsonResponse(data)
    r['Cache-Control'] = f'public, max-age={max_age}'
    return r


def api_live(request):
    return _json(queries.live(), 10)


def api_coverage(request):
    window = queries.window_of(request.GET.get('w'))
    feeder = _public_feeder(request.GET['feeder']) if request.GET.get('feeder') else None
    try:
        res = min(max(int(request.GET.get('res', '1' if feeder else '2')), 1), 10)
    except ValueError:
        res = 2
    return _json(queries.coverage(window, feeder, res), 60)


def api_cell(request):
    try:
        la, lo = int(request.GET['la']), int(request.GET['lo'])
        res = min(max(int(request.GET.get('res', '1')), 1), 10)
    except (KeyError, ValueError):
        return JsonResponse({'error': 'la, lo, res'}, status=400)
    window = queries.window_of(request.GET.get('w'))
    s, w, n, e = readsb.cell_bounds(la, lo, res)
    return _json({'bounds': [s, w, n, e], 'feeders': queries.cell_feeders(la, lo, res, window)}, 60)


def api_feeder_series(request, uuid):
    f = _public_feeder(uuid)
    return _json(queries.feeder_series(f, queries.window_of(request.GET.get('w'))), 60)


def api_network_series(request):
    return _json(queries.network_series(queries.window_of(request.GET.get('w'))), 60)


def healthz(request):
    return HttpResponse('ok', content_type='text/plain')


# ─── Staff ──────────────────────────────────────────────────────────────────
superuser_required = user_passes_test(lambda u: u.is_active and u.is_superuser)


@superuser_required
def staff(request):
    st = Status.get()
    listed = {(e.kind, e.uuid) for e in ListEntry.objects.all()}
    rb = lists.readsbee_status()
    for r in rb['rejected']:
        r['allowed'], r['denied'] = ('allow', r['uuid']) in listed, ('deny', r['uuid']) in listed
    flags = {r['uuid']: r.get('reason') or 'flagged' for r in rb['flagged']}
    status_missing = rb['missing']
    feeders = list(Feeder.objects.order_by('hidden', '-online', 'uuid'))
    for f in feeders:
        f.flag = flags.get(f.uuid)
    return render(request, 'feeders/staff.html', {
        'nav': 'staff', 'status': st, 'fresh': queries.fresh(),
        'allow': ListEntry.objects.filter(kind=ListEntry.ALLOW),
        'deny': ListEntry.objects.filter(kind=ListEntry.DENY),
        'rejected': rb['rejected'], 'flagged': rb['flagged'], 'status_file': settings.WHEREPLANE_READSBEE_STATUS_FILE, 'status_missing': status_missing,
        'feeders': feeders,
        'feeders_dir': settings.WHEREPLANE_FEEDERS_DIR})


@superuser_required
@require_POST
def staff_list_add(request):
    kind = request.POST.get('kind')
    uuid = readsb.normalize_uuid(request.POST.get('uuid', ''))
    if kind not in (ListEntry.ALLOW, ListEntry.DENY) or not uuid:
        messages.error(request, '✗ Not a UUID')
        return redirect('staff')
    try:
        ListEntry.objects.create(kind=kind, uuid=uuid, note=request.POST.get('note', '')[:120])
    except IntegrityError:
        messages.info(request, f'Already on the {kind} list')
        return redirect('staff')
    lists.write_all()
    messages.success(request, f'✓ {uuid} → {kind}.txt')
    return redirect('staff')


@superuser_required
@require_POST
def staff_list_remove(request, pk):
    e = get_object_or_404(ListEntry, pk=pk)
    e.delete()
    lists.write_all()
    messages.success(request, f'✓ {e.uuid} removed from {e.kind}.txt')
    return redirect('staff')


@superuser_required
@require_POST
def staff_feeder(request, pk):
    f = get_object_or_404(Feeder, pk=pk)
    f.name = request.POST.get('name', '').strip()[:60]
    f.hidden = request.POST.get('hidden') == '1'
    f.save(update_fields=['name', 'hidden'])
    messages.success(request, f'✓ {f.uuid}: {f.display_name}{" (hidden)" if f.hidden else ""}')
    return redirect('staff')
