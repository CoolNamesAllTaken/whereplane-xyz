"""
feeders/allow.txt and feeders/deny.txt, the files readsbee reads (one UUID per line, `#` comments,
reloaded when they change). The database (ListEntry) is the source; every change rewrites both
files atomically (temp file + rename in the same folder), so readsbee never reads half a file.
Mount the folder, not the files: a file bind mount keeps pointing at the replaced inode.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from django.conf import settings
from django.utils import timezone

from . import readsb
from .models import ListEntry

HEADER = ('# {kind}list for readsbee: one feeder UUID per line, # starts a comment.\n'
          '# Written by the whereplane.xyz staff page ({when}); edits made here are overwritten.\n')


def render(kind: str) -> str:
    lines = [HEADER.format(kind=kind, when=timezone.now().strftime('%Y-%m-%d %H:%M UTC'))]
    for e in ListEntry.objects.filter(kind=kind).order_by('created'):
        note = ' '.join(e.note.split())
        lines.append(f'{e.uuid}  # {note}\n' if note else f'{e.uuid}\n')
    return ''.join(lines)


def write_all(directory: Path | None = None) -> list[Path]:
    directory = Path(directory or settings.WHEREPLANE_FEEDERS_DIR)
    directory.mkdir(parents=True, exist_ok=True)
    written = []
    for kind in (ListEntry.ALLOW, ListEntry.DENY):
        path = directory / f'{kind}.txt'
        fd, tmp = tempfile.mkstemp(prefix=f'.{kind}.', dir=directory)
        with os.fdopen(fd, 'w') as f:
            f.write(render(kind))
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
        written.append(path)
    return written


def parse(text: str) -> list[str]:
    """UUIDs in a list file, the way readsbee reads it."""
    out = []
    for line in text.splitlines():
        u = readsb.normalize_uuid(line.split('#', 1)[0])
        if u:
            out.append(u)
    return out


def _entries(items) -> list[dict]:
    out = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str):
            item = {'uuid': item}
        if isinstance(item, dict) and readsb.normalize_uuid(str(item.get('uuid', ''))):
            # Only what the staff page shows; anything else in the file (an address) is dropped here.
            out.append({k: item[k] for k in ('uuid', 'reason', 'count', 'last_seen') if k in item})
    return out


def readsbee_status() -> dict:
    """
    What readsbee decided about feeders, from WHEREPLANE_READSBEE_STATUS_FILE (staff only):
    {"rejected": [...], "flagged": [...]}, each a list of UUIDs or of objects with "uuid" and
    optional "reason", "count", "last_seen". A plain list or one UUID per line means rejected.
    Missing or unreadable file: both empty.
    """
    empty = {'rejected': [], 'flagged': []}
    path = settings.WHEREPLANE_READSBEE_STATUS_FILE
    if not path:
        return empty
    try:
        text = Path(path).read_text()
    except OSError:
        return empty
    try:
        doc = json.loads(text)
    except ValueError:
        return {'rejected': [{'uuid': u} for u in parse(text)], 'flagged': []}
    if isinstance(doc, list):
        return {'rejected': _entries(doc), 'flagged': []}
    if isinstance(doc, dict):
        return {'rejected': _entries(doc.get('rejected')), 'flagged': _entries(doc.get('flagged'))}
    return empty
