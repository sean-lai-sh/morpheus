FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    MPLBACKEND=Agg

# Pre-install scientific stack from apt for cached, glibc-friendly layers.
# bash is in the base image; we install only what's needed and clean up.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3-matplotlib \
      python3-numpy \
      python3-pandas \
      python3-scipy \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Non-root runner. uid 65532 matches distroless "nonroot".
RUN groupadd --system --gid 65532 runner \
 && useradd  --system --uid 65532 --gid 65532 --home /home/runner --create-home runner \
 && mkdir -p /workspace \
 && chown -R runner:runner /workspace

COPY sandbox.entrypoint.sh /usr/local/bin/sandbox-entrypoint
RUN chmod 0555 /usr/local/bin/sandbox-entrypoint

USER runner
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
