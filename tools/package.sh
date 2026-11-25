#!/usr/bin/env bash
# Build the Chrome Web Store upload zip — only the extension runtime files.
# Output: dist/anamne-v<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -e "console.log(require('./manifest.json').version)")
OUT="dist/anamne-v${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"

# Explicit allowlist of runtime files (safer than excludes).
FILES=(
  manifest.json
  config.js theme.js platforms.js
  background.js inject.js claude-rest.js bridge.js picker.js
  parsers.js archive-logic.js prompt-logic.js db.js obsidian.js md.js zip.js
  popup.html popup.js
  archive.html archive.js
  prompts.html prompts.js
  icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png
)

# Verify every file exists before zipping.
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "MISSING: $f" >&2; exit 1; }
done

zip -q "$OUT" "${FILES[@]}"
echo "Built $OUT"
unzip -l "$OUT" | tail -n +2
