#!/usr/bin/env bash
# Check A: the generated code is up to date with contract/ibee-cloud.yaml.
# Regenerates in a temporary copy of the repo and fails if a generated file differs,
# is missing or is new. Fern keeps the hand-written files (src/.fernignore), so they
# never differ.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
rsync -a --exclude .git --exclude node_modules --exclude dist "$root/" "$tmp/"
cd "$tmp"
git init -q && git add -A && git -c user.name=check -c user.email=check@localhost commit -qm repo
scripts/regenerate.sh
if [ -n "$(git status --porcelain -- src)" ]; then
  echo "src/ is not what contract/ibee-cloud.yaml generates. Run scripts/regenerate.sh and commit:" >&2
  git status --short -- src >&2
  exit 1
fi
echo "Generated code matches contract/ibee-cloud.yaml."
