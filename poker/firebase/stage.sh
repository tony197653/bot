#!/usr/bin/env bash
# Copy poker/ and lib/ into hosting public/ so relative paths stay ../lib/auth/...
# Exclude tests, rules sources, and internal mockups — keep playground.html + lib/auth/demo.html.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$(cd "$(dirname "$0")" && pwd)/public"
rm -rf "$DEST"
mkdir -p "$DEST/poker" "$DEST/lib"

EXCLUDES=(
  --exclude 'firebase'
  --exclude 'node_modules'
  --exclude 'test-artifacts'
  --exclude 'test'
  --exclude '.git'
  --exclude 'package.json'
  --exclude 'package-lock.json'
  --exclude 'README.md'
  --exclude 'assets/component-library-index.html'
  --exclude 'assets/style-green-mockup.html'
)

mkdir -p "$DEST/poker"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "${EXCLUDES[@]}" "$ROOT/poker/" "$DEST/poker/"
else
  (cd "$ROOT/poker" && tar \
    --exclude='firebase' \
    --exclude='node_modules' \
    --exclude='test-artifacts' \
    --exclude='test' \
    --exclude='package.json' \
    --exclude='package-lock.json' \
    --exclude='README.md' \
    --exclude='assets/component-library-index.html' \
    --exclude='assets/style-green-mockup.html' \
    -cf - .) | (cd "$DEST/poker" && tar -xf -)
fi

# lib/auth: serve demo.html; drop README + auth.rules only
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'README.md' \
    --exclude 'auth.rules' \
    "$ROOT/lib/." "$DEST/lib/"
else
  mkdir -p "$DEST/lib"
  cp -a "$ROOT/lib/." "$DEST/lib/"
  rm -f "$DEST/lib/auth/README.md" "$DEST/lib/auth/auth.rules" 2>/dev/null || true
fi

if [[ ! -d "$DEST/lib/auth" ]]; then
  rm -rf "$DEST/lib"
  mkdir -p "$DEST/lib"
  cp -a "$ROOT/lib/." "$DEST/lib/"
  rm -f "$DEST/lib/auth/README.md" "$DEST/lib/auth/auth.rules" 2>/dev/null || true
fi
echo "Staged → $DEST (poker/ + lib/; playground + auth demo kept; tests & rules excluded)"
