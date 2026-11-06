#!/bin/sh
# Only the site migrates (WHEREPLANE_ROLE=site, the default); the collector waits for it.
set -e
if [ "${WHEREPLANE_ROLE:-site}" = "site" ]; then
    python manage.py migrate --noinput
    python manage.py createcachetable
    python manage.py collectstatic --noinput
    python manage.py write_feeder_lists
fi
exec "$@"
