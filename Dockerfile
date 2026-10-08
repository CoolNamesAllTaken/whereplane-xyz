# Stock ultrafeeder, but with readsb rebuilt using WITH_UUIDS=yes so the API
# supports filtering by individual station uuid (/re-api/?all&filter_uuid=<uuid>).
# The upstream image builds readsb without this flag, so it can't be enabled at runtime.
# Based on https://github.com/wiedehopf/ultrafeeder_uuid
FROM ghcr.io/sdr-enthusiasts/docker-baseimage:mlatclient AS buildimage

SHELL ["/bin/bash", "-x", "-o", "pipefail", "-c"]

RUN \
  git clone \
  --branch "dev" \
  --depth 1 \
  --single-branch \
  'https://github.com/wiedehopf/readsb.git' \
  '/src/readsb' \
  && \
  pushd /src/readsb && \
  make \
  RTLSDR=yes \
  WITH_UUIDS=yes \
  AIRCRAFT_HASH_BITS=14 \
  DISABLE_RTLSDR_ZEROCOPY_WORKAROUND=yes \
  -j "$(nproc)" \
  && \
  cp readsb /usr/local/bin/ && \
  /usr/local/bin/readsb --version && \
  popd

FROM ghcr.io/sdr-enthusiasts/docker-adsb-ultrafeeder:latest

COPY --from=buildimage /usr/local/bin/readsb /usr/local/bin/readsb
