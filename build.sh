#!/bin/bash
# Builds PadCoder.app next to this script; `./build.sh install` also copies it to /Applications
# and installs the approval hook script. Signs with your Apple Development cert when available
# so the Accessibility grant survives rebuilds; falls back to ad-hoc.
set -euo pipefail
cd "$(dirname "$0")"

# Build into a temp dir so a failed compile never removes the working app.
WORK="$(mktemp -d)"
STAGE="$WORK/PadCoder.app"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources"
cp Info.plist "$STAGE/Contents/Info.plist"

swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" \
  -framework AppKit -framework GameController -framework CoreHaptics -framework ServiceManagement \
  -o "$STAGE/Contents/MacOS/PadCoder" Sources/*.swift

# The icon is drawn in code (Sources/AppIcon.swift); render it and pack it as an .icns.
"$STAGE/Contents/MacOS/PadCoder" --render-icon "$WORK/AppIcon.iconset"
iconutil -c icns "$WORK/AppIcon.iconset" -o "$STAGE/Contents/Resources/AppIcon.icns"

IDENTITY=$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development|Developer ID/ {print $2; exit}')
if [ -n "$IDENTITY" ] && perl -e 'alarm 30; exec @ARGV' codesign --force --sign "$IDENTITY" "$STAGE" 2>/dev/null; then
  echo "Signed with: $IDENTITY"
else
  codesign --force --sign - "$STAGE"
  echo "Signed ad-hoc (re-grant Accessibility after each rebuild)"
fi

rm -rf PadCoder.app
mv "$STAGE" PadCoder.app
echo "Built $(pwd)/PadCoder.app"

if [ "${1:-}" = "install" ]; then
  SUPPORT="$HOME/Library/Application Support/PadCoder"
  mkdir -p "$SUPPORT"
  install -m 755 hooks/permission-hook.sh "$SUPPORT/permission-hook.sh"
  pkill -x PadCoder 2>/dev/null || true
  rm -rf /Applications/PadCoder.app
  ditto PadCoder.app /Applications/PadCoder.app
  echo "Installed /Applications/PadCoder.app and $SUPPORT/permission-hook.sh"
fi
