FROM node:22.23.0-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io ca-certificates curl git openssl xz-utils \
 && rm -rf /var/lib/apt/lists/*
# This image is only for jobs on a dedicated Pear CI machine. Docker access is
# needed by the disposable SpacetimeDB fixtures; the host must hold no prod data.
