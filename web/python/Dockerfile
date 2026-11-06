# syntax=docker/dockerfile:1.4
# Same shape as adsbee-aero's python/Dockerfile: base, then test and prod targets.
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /build
COPY requirements.txt /build
RUN pip3 install -r requirements.txt --no-cache-dir

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Code baked into the image: a deploy is `git pull && docker compose up -d --build`.
COPY whereplane_web /app
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# `docker compose --profile test run --rm --build site-test`
FROM base AS test
COPY requirements-dev.txt /build
RUN pip3 install --no-cache-dir -r /build/requirements-dev.txt
ENTRYPOINT []
CMD ["python", "-m", "pytest", "-q"]

FROM base AS prod
CMD ["gunicorn", "whereplane_web.wsgi:application", \
     "--bind", "0.0.0.0:8000", \
     "--workers", "3", "--threads", "4", "--worker-class", "gthread", \
     "--timeout", "60", \
     "--access-logfile", "-", \
     "--access-logformat", "%({x-real-ip}i)s %(t)s \"%(r)s\" %(s)s %(b)s"]
