#!/usr/bin/env bash
# Build the morpheus-sandbox Docker image.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${MORPHEUS_SANDBOX_TAG:-morpheus-sandbox:latest}"

cd "${REPO_ROOT}"
exec docker build \
  -t "${TAG}" \
  -f docker/sandbox.Dockerfile \
  docker/
