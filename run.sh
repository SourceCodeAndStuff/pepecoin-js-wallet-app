#!/usr/bin/env bash
# Launch the optional web console from the project root, exporting local .env settings.
# exec lets Node receive shutdown signals directly; this launcher does not install dependencies.
set -euo pipefail
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
exec node web/server.js
