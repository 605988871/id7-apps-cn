# Build image for kit/carlife-tap: Ubuntu 18.04 has glibc 2.27, the same as the
# MGU, so the library built here is loaded by the head unit's CarLife
# unchanged. Keep it in step with kit/renderd/docker.
FROM ubuntu:18.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      gcc make libc6-dev file binutils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
