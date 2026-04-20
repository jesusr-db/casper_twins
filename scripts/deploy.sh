#!/usr/bin/env bash
# Twins Digital Twin — one-command deploy.
# Chains bundle deploy → setup-lakebase run → apps deploy.
# Combined with the self-heal in setup/create_syncs.py, guarantees stale UC
# registrations are rebuilt on every deploy.
#
# Pre-requisites:
#   - `databricks` CLI available on PATH
#   - `-p DEFAULT` profile configured in ~/.databrickscfg
#   - The app `twins-digital-twin` is in RUNNING state (run `databricks apps start
#     twins-digital-twin -p DEFAULT` first if STOPPED)

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/3] databricks bundle deploy"
databricks bundle deploy -p DEFAULT

echo "==> [2/3] databricks bundle run setup-lakebase"
databricks bundle run setup-lakebase -p DEFAULT

echo "==> [3/3] databricks apps deploy twins-digital-twin"
databricks apps deploy twins-digital-twin -p DEFAULT

echo "==> done"
