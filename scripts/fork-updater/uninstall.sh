#!/usr/bin/env bash
# Remove the hourly T3 fork updater LaunchAgent.
set -euo pipefail

LABEL="com.lukeholloway.t3-fork-updater"
HOME_DIR="${HOME:?HOME is not set}"
PLIST_PATH="$HOME_DIR/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
	launchctl bootout "$DOMAIN/$LABEL"
	echo "Unloaded $DOMAIN/$LABEL."
else
	echo "$LABEL was not loaded."
fi

if [[ -f "$PLIST_PATH" ]]; then
	rm -f "$PLIST_PATH"
	echo "Removed $PLIST_PATH."
else
	echo "No plist at $PLIST_PATH; nothing to remove."
fi

echo "Logs and state in $HOME_DIR/.t3-fork-updater were left in place."
echo "The T3 version that is running was not changed."
