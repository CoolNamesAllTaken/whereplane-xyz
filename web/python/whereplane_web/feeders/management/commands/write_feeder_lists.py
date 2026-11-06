from django.core.management.base import BaseCommand

from feeders import lists


class Command(BaseCommand):
    help = 'Write feeders/allow.txt and feeders/deny.txt from the database.'

    def handle(self, *args, **options):
        for path in lists.write_all():
            self.stdout.write(f'wrote {path}')
