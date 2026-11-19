#!/bin/sh
# Build the .vsix and install it into Cursor or VS Code (whichever CLI is found).
# Usage: ./ship.sh            (or EDITOR_CLI=code ./ship.sh)
set -e
cd "$(dirname "$0")"
for f in extension.js mcp/server.js daemon/*.js media/panel.js; do node --check "$f"; done
npx --yes @vscode/vsce package -o claude-browser.vsix
CLI="${EDITOR_CLI:-}"
if [ -z "$CLI" ]; then
  for c in cursor code /Applications/Cursor.app/Contents/Resources/app/bin/cursor "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CLI="$c"; break; fi
  done
fi
if [ -n "$CLI" ]; then
  "$CLI" --install-extension claude-browser.vsix --force
  echo "Installed. Run 'Developer: Reload Window' in the editor."
else
  echo "Built claude-browser.vsix. Install it with 'Extensions: Install from VSIX...'."
fi
