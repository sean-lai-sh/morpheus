FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    MPLBACKEND=Agg

# bash is already in the base image. Install scientific stack into the
# runtime (/usr/local) interpreter via pip — the Debian python3-* packages
# install into a different site-packages and would not be visible to
# `python` / `python3` on PATH in this image.
RUN pip install --no-cache-dir \
      numpy \
      pandas \
      matplotlib

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
