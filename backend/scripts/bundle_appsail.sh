#!/usr/bin/env bash
# Build an AppSail-ready ZIP of backend/ (run from repo root or backend/)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
rm -rf lib appsail-bundle.zip
python3 -m pip install -r requirements.txt -t lib --upgrade
zip -r appsail-bundle.zip app catalyst_start.py app-config.json requirements.txt lib keycloak -x "*.pyc" "*__pycache__*"
echo "Wrote $ROOT/appsail-bundle.zip"
