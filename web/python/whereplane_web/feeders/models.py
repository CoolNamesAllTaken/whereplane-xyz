"""
Feeders, their stats over time and their coverage. Written by the collector (management command
`collect`), read by the pages. No feeder address is ever stored.
"""
from django.db import models
from django.utils import timezone

from . import readsb


class Feeder(models.Model):
    uuid = models.CharField(max_length=36, unique=True)
    name = models.CharField(max_length=60, blank=True, help_text='Public name; blank shows the short ID.')
    hidden = models.BooleanField(default=False, help_text='Left out of every public page and map.')
    accepted = models.BooleanField(default=False, help_text='readsbee has accepted it (listed it as ok) at least once')
    first_seen = models.DateTimeField(default=timezone.now)
    last_seen = models.DateTimeField(default=timezone.now)
    # Live state, refreshed by the collector every minute.
    online = models.BooleanField(default=False)
    connected_since = models.DateTimeField(null=True, blank=True)
    connections = models.PositiveSmallIntegerField(default=0)
    # Rates per feeder come from readsbee.json once it reports them (or clients.json); None: not reported.
    msgs_s = models.FloatField(null=True, blank=True)
    pos_s = models.FloatField(null=True, blank=True)
    kbps = models.FloatField(null=True, blank=True)
    aircraft_now = models.PositiveIntegerField(default=0, help_text='Distinct aircraft in the last minute')
    # Rough location from its own coverage, only to measure range. Never shown or sent to a browser.
    center_lat = models.FloatField(null=True, blank=True)
    center_lon = models.FloatField(null=True, blank=True)

    class Meta:
        ordering = ['-online', '-aircraft_now']

    def __str__(self):
        return self.display_name

    @property
    def display_name(self):
        return self.name or readsb.default_name(self.uuid)



class FeederSample(models.Model):
    """One feeder every 5 minutes while online (gaps are offline)."""
    feeder = models.ForeignKey(Feeder, on_delete=models.CASCADE, related_name='samples')
    t = models.DateTimeField(db_index=True)
    msgs_s = models.FloatField(null=True)
    pos_s = models.FloatField(null=True)
    aircraft = models.PositiveIntegerField()
    kbps = models.FloatField(null=True)

    class Meta:
        indexes = [models.Index(fields=['feeder', 't'])]


class NetworkSample(models.Model):
    """The whole network every 5 minutes."""
    t = models.DateTimeField(db_index=True)
    feeders_online = models.PositiveIntegerField()
    aircraft = models.PositiveIntegerField()
    msgs_s = models.FloatField()
    pos_s = models.FloatField()


class FeederDay(models.Model):
    """Distinct aircraft (ICAO hex) one feeder heard in one UTC day."""
    feeder = models.ForeignKey(Feeder, on_delete=models.CASCADE, related_name='days')
    day = models.DateField()
    hexes = models.TextField(blank=True)
    aircraft = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['feeder', 'day'], name='feederday_unique')]


class CoverageCell(models.Model):
    """
    A 0.1° cell × altitude band one feeder heard a direct ADS-B position in. Rolling windows come
    from last_seen; cells not seen for 31 days are deleted.
    """
    feeder = models.ForeignKey(Feeder, on_delete=models.CASCADE, related_name='cells')
    band = models.PositiveSmallIntegerField()
    lat_i = models.PositiveIntegerField()
    lon_i = models.PositiveIntegerField()
    first_seen = models.DateTimeField()
    last_seen = models.DateTimeField(db_index=True)
    hits = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['feeder', 'band', 'lat_i', 'lon_i'], name='cell_unique')]
        indexes = [models.Index(fields=['feeder', 'last_seen'])]


class ListEntry(models.Model):
    """A line of feeders/allow.txt or feeders/deny.txt, which readsbee reads."""
    ALLOW, DENY = 'allow', 'deny'
    KINDS = [(ALLOW, 'allow'), (DENY, 'deny')]
    kind = models.CharField(max_length=5, choices=KINDS)
    uuid = models.CharField(max_length=36)
    note = models.CharField(max_length=120, blank=True)
    created = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['kind', 'created']
        constraints = [models.UniqueConstraint(fields=['kind', 'uuid'], name='listentry_unique')]
        verbose_name_plural = 'allow / deny entries'

    def __str__(self):
        return f'{self.kind} {self.uuid}'


class Status(models.Model):
    """Single row: the collector's last run, so pages can say how fresh the data is."""
    last_poll = models.DateTimeField(null=True)
    last_error = models.CharField(max_length=300, blank=True)
    poll_ms = models.FloatField(default=0, help_text='Wall time of the last poll round')
    source = models.CharField(max_length=20, blank=True, help_text='Where the feeder list came from')
    requests = models.PositiveIntegerField(default=0, help_text='HTTP requests in the last poll round')
    aircraft = models.PositiveIntegerField(default=0)
    msgs_s = models.FloatField(default=0)
    pos_s = models.FloatField(default=0)

    @classmethod
    def get(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj
