#!/usr/bin/env bash
# Regenerate src/ from contract/ibee-cloud.yaml (needs Fern CLI 5.45.3 and Docker).
# Hand-written files (src/.fernignore) are kept. The package version comes from
# package.json.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
cd fern
fern generate --local --group ts-sdk --force --version "$version" --log-level warn
