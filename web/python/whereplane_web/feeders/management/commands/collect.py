import logging
import time

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import close_old_connections

from feeders.collector import Collector, http_fetcher


class Command(BaseCommand):
    help = 'Poll the live readsb forever (see feeders/collector.py). --once: one round, all flushes.'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true')

    def handle(self, *args, once=False, **options):
        logging.getLogger('whereplane.collector').setLevel(logging.INFO)
        c = Collector(http_fetcher(settings.WHEREPLANE_READSB_URL))
        self.stdout.write(f'collecting from {settings.WHEREPLANE_READSB_URL} every {settings.WHEREPLANE_POLL_SECONDS} s')
        while True:
            close_old_connections()
            wait = c.step()
            if once:
                self.stdout.write(f'{len(c.clients)} feeders, {c.requests} requests, {c.poll_ms:.0f} ms')
                return
            time.sleep(wait)
