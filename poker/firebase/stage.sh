#!/usr/bin/env bash
# Copy poker/ and lib/ into hosting public/ so relative paths stay ../lib/auth/...
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$(cd "$(dirname "$0")" && pwd)/public"
rm -rf "$DEST"
mkdir -p "$DEST/poker" "$DEST/lib"

# Prefer rsync; fall back to cp
copy_tree() {
  local src="$1" dst="$2"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$src" "$dst"
  else
    rm -rf "$dst"
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
  fi
}

# poker app (exclude firebase public staging + node_modules)
mkdir -p "$DEST/poker"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'firebase/public' \
    --exclude 'node_modules' \
    --exclude 'test-artifacts' \
    --exclude '.git' \
    "$ROOT/poker/" "$DEST/poker/"
else
  # cp fallback with exclusions
  (cd "$ROOT/poker" && tar --exclude='firebase/public' --exclude='node_modules' --exclude='test-artifacts' -cf - .) | (cd "$DEST/poker" && tar -xf -)
fi
copy_tree "$ROOT/lib/." "$DEST/lib/"
# ensure lib is a directory tree
if [[ ! -d "$DEST/lib/auth" ]]; then
  rm -rf "$DEST/lib"
  mkdir -p "$DEST/lib"
  cp -a "$ROOT/lib/." "$DEST/lib/"
fi
echo "Staged → $DEST (poker/ + lib/)"
