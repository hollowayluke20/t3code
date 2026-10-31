#!/usr/bin/env bash
# Install the hourly T3 fork updater LaunchAgent.
#
# Dry run by default. Use --apply to write the plist and load the job.
set -euo pipefail

LABEL="com.lukeholloway.t3-fork-updater"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist.template"
HOME_DIR="${HOME:?HOME is not set}"
AGENTS_DIR="$HOME_DIR/Library/LaunchAgents"
PLIST_PATH="$AGENTS_DIR/$LABEL.plist"
STATE_DIR="$HOME_DIR/.t3-fork-updater"
LOG_PATH="$STATE_DIR/launchd.log"
DOMAIN="gui/$(id -u)"
PROGRAM="$REPO/scripts/fork-updater/fork-updater.mjs"

usage() {
	cat <<EOF
Usage: $(basename "$0") [--print | --apply]

  (no arguments)  Dry run. Print what would be installed and change nothing.
  --print         Print the generated plist to stdout and exit.
  --apply         Write the plist and load it with launchctl bootstrap.

The job runs 'node $PROGRAM tick' every hour.
EOF
}

mode="dry-run"
print_flag=0
apply_flag=0

for arg in "$@"; do
	case "$arg" in
	--print)
		print_flag=1
		;;
	--apply)
		apply_flag=1
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "error: unknown argument: $arg" >&2
		usage >&2
		exit 2
		;;
	esac
done

if [[ "$print_flag" -eq 1 && "$apply_flag" -eq 1 ]]; then
	echo "error: --print and --apply are mutually exclusive" >&2
	exit 2
fi

if [[ "$print_flag" -eq 1 ]]; then
	mode="print"
elif [[ "$apply_flag" -eq 1 ]]; then
	mode="apply"
fi

if [[ ! -f "$TEMPLATE" ]]; then
	echo "error: missing plist template: $TEMPLATE" >&2
	exit 1
fi

is_loaded() {
	launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

render_plist() {
	REPO="$REPO" HOME_DIR="$HOME_DIR" perl -pe '
		BEGIN {
			sub xml_escape {
				my $s = shift;
				$s =~ s/&/&amp;/g;
				$s =~ s/</&lt;/g;
				$s =~ s/>/&gt;/g;
				return $s;
			}
		}
		s/\Q__REPO__\E/xml_escape($ENV{REPO})/ge;
		s/\Q__HOME__\E/xml_escape($ENV{HOME_DIR})/ge;
	' "$TEMPLATE"
}

tmp_plist="$(mktemp "${TMPDIR:-/tmp}/t3-fork-updater.XXXXXX")"
trap 'rm -f "$tmp_plist"' EXIT
render_plist >"$tmp_plist"

if grep -qE '__REPO__|__HOME__' "$tmp_plist"; then
	echo "error: template placeholders were not fully substituted" >&2
	exit 1
fi

if ! lint_output="$(plutil -lint "$tmp_plist" 2>&1)"; then
	printf '%s\n' "$lint_output" >&2
	echo "error: generated plist failed plutil -lint" >&2
	exit 1
fi

if [[ "$mode" == "print" ]]; then
	printf 'validated: %s\n' "$lint_output" >&2
	cat "$tmp_plist"
	exit 0
fi

if [[ "$mode" == "dry-run" ]]; then
	echo "Dry run: no changes made. Re-run with --apply to install."
	echo
	echo "  label:    $LABEL"
	echo "  program:  /opt/homebrew/bin/node $PROGRAM tick"
	echo "  schedule: every 3600 seconds (hourly), not at load"
	echo "  logs:     $LOG_PATH"
	echo "  plist:    $PLIST_PATH"
	echo
	if [[ -f "$PROGRAM" ]]; then
		echo "  program file: present"
	else
		echo "  program file: MISSING right now ($PROGRAM)"
	fi
	if is_loaded; then
		echo "  launchd job:  loaded (would be booted out and reloaded)"
	else
		echo "  launchd job:  not loaded"
	fi
	echo
	echo "Would:"
	echo "  1. render the plist from $TEMPLATE"
	echo "  2. validate it with plutil -lint (already done)"
	echo "  3. create $STATE_DIR"
	echo "  4. write $PLIST_PATH"
	echo "  5. boot out $DOMAIN/$LABEL first if it is loaded"
	echo "  6. launchctl bootstrap $DOMAIN $PLIST_PATH (no kickstart)"
	exit 0
fi

echo "Installing $LABEL ..."
mkdir -p "$STATE_DIR" "$AGENTS_DIR"
touch "$LOG_PATH"

if is_loaded; then
	echo "  job is already loaded; booting it out first"
	launchctl bootout "$DOMAIN/$LABEL"
fi

cp "$tmp_plist" "$PLIST_PATH"
chmod 644 "$PLIST_PATH"
echo "  wrote $PLIST_PATH"

launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
echo "  loaded $DOMAIN/$LABEL"
echo "Done. The job runs 'tick' every hour; no kickstart was issued."
