#!/usr/bin/env bash
# morpheus sandbox entrypoint.
#
# Behavior:
#   - If arguments are passed to `docker run`, exec them as-is. This lets the
#     runtime layer call e.g. `python -c '...'` or `bash -c '...'` directly.
#   - Otherwise, look for /workspace/script/main.{sh,py} and exec the right
#     interpreter against it.
#
# We do NOT trap signals: Docker's stop signal must reach the child process
# directly so it can be reaped (via `docker run --init`) by the runtime layer.
set -euo pipefail

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

SCRIPT_DIR="/workspace/script"
if [ -f "${SCRIPT_DIR}/main.py" ]; then
  exec python3 "${SCRIPT_DIR}/main.py"
elif [ -f "${SCRIPT_DIR}/main.sh" ]; then
  exec bash "${SCRIPT_DIR}/main.sh"
else
  echo "sandbox: no command given and no /workspace/script/main.{sh,py} found" >&2
  exit 64
fi
