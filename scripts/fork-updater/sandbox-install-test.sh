#!/usr/bin/env bash
# Prove the fork install path end to end in a throwaway T3 home.
# Usage: sandbox-install-test.sh [--releases-dir DIR] [--version VER] [--keep-home]
set -euo pipefail

RELEASES_DIR="${T3_SANDBOX_RELEASES_DIR:-$HOME/Development/t3code-fork-releases/test-u1}"
VERSION=""
HTTP_PORT="${T3_SANDBOX_HTTP_PORT:-3791}"
APP_PORT="${T3_SANDBOX_APP_PORT:-3792}"
KEEP_HOME=0
T3_BIN="${T3_SANDBOX_T3_BIN:-$HOME/.t3/bin/t3}"
FORK_MARKER="${T3_SANDBOX_MARKER:-Dictate}"

usage() {
  sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --releases-dir) RELEASES_DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --keep-home) KEEP_HOME=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

command -v python3 >/dev/null || { echo "python3 missing" >&2; exit 1; }
[ -x "$T3_BIN" ] || { echo "t3 binary not executable: $T3_BIN" >&2; exit 1; }
[ -d "$RELEASES_DIR" ] || { echo "releases dir missing: $RELEASES_DIR" >&2; exit 1; }

if [ -z "$VERSION" ]; then
  VERSION="$(
    find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -name 'v*' 2>/dev/null \
      | while read -r dir; do
          ver="${dir##*/v}"
          [ -f "$dir/SHA256SUMS" ] || continue
          [ -f "$dir/t3-$ver-darwin-arm64.tar.gz" ] || continue
          echo "$ver"
        done \
      | sort -V | tail -1
  )"
fi
[ -n "$VERSION" ] || { echo "no release found under $RELEASES_DIR (need v<ver>/SHA256SUMS + t3-<ver>-darwin-arm64.tar.gz)" >&2; exit 1; }

VERSION_DIR="$RELEASES_DIR/v$VERSION"
ARCHIVE="$VERSION_DIR/t3-$VERSION-darwin-arm64.tar.gz"
[ -f "$VERSION_DIR/SHA256SUMS" ] || { echo "missing $VERSION_DIR/SHA256SUMS" >&2; exit 1; }
[ -f "$ARCHIVE" ] || { echo "missing $ARCHIVE" >&2; exit 1; }

for port in "$HTTP_PORT" "$APP_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port already in use; refusing to touch another process" >&2
    exit 1
  fi
done

TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/t3-sandbox-update.XXXXXX")"
HTTP_PID=""
APP_PID=""
LOG_DIR="$TMP_HOME/logs"
mkdir -p "$LOG_DIR"

cleanup() {
  for pid in "$APP_PID" "$HTTP_PID"; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  if [ "$KEEP_HOME" -eq 1 ]; then
    echo "kept temp home: $TMP_HOME"
  else
    rm -rf "$TMP_HOME"
  fi
}
trap cleanup EXIT

now() { date +%s; }
elapsed() { echo "$(( $(now) - $1 ))s"; }

echo "==> releases dir: $RELEASES_DIR"
echo "==> version:      $VERSION"
echo "==> temp home:    $TMP_HOME"
echo "==> t3:           $T3_BIN ($("$T3_BIN" --version 2>&1))"
echo "==> archive:      $ARCHIVE ($(du -h "$ARCHIVE" | awk '{print $1}'))"

EXPECTED_SHA="$(awk -v name="$(basename "$ARCHIVE")" '$2 == name || $2 == "*" name { print $1; exit }' "$VERSION_DIR/SHA256SUMS")"
ACTUAL_SHA="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
[ -n "$EXPECTED_SHA" ] || { echo "archive not listed in SHA256SUMS" >&2; exit 1; }
[ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || { echo "checksum mismatch: $ACTUAL_SHA != $EXPECTED_SHA" >&2; exit 1; }
echo "==> checksum:     ok ($ACTUAL_SHA)"

STEP_START="$(now)"
python3 -m http.server "$HTTP_PORT" --bind 127.0.0.1 --directory "$RELEASES_DIR" \
  >"$LOG_DIR/http-server.log" 2>&1 &
HTTP_PID=$!
for _ in $(seq 1 100); do
  curl -fsS "http://127.0.0.1:$HTTP_PORT/v$VERSION/SHA256SUMS" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$HTTP_PORT/v$VERSION/SHA256SUMS" >/dev/null \
  || { echo "release server did not come up on $HTTP_PORT" >&2; exit 1; }
echo "==> http server:  pid $HTTP_PID on 127.0.0.1:$HTTP_PORT ($(elapsed "$STEP_START"))"

STEP_START="$(now)"
echo "==> t3 update (allow-downgrade always passed)"
T3CODE_RELEASE_BASE_URL="http://127.0.0.1:$HTTP_PORT" \
  "$T3_BIN" update "$VERSION" --base-dir "$TMP_HOME" --allow-downgrade --yes
UPDATE_SECONDS="$(elapsed "$STEP_START")"
echo "==> update done in $UPDATE_SECONDS"

INSTALLED_T3="$TMP_HOME/runtime/versions/$VERSION/t3"
[ -x "$INSTALLED_T3" ] || { echo "installed binary missing: $INSTALLED_T3" >&2; exit 1; }
INSTALLED_VERSION="$("$INSTALLED_T3" --version 2>&1)"
echo "==> installed:    $INSTALLED_VERSION"
case "$INSTALLED_VERSION" in
  *"v$VERSION"*) ;;
  *) echo "installed binary reports '$INSTALLED_VERSION', expected v$VERSION" >&2; exit 1 ;;
esac
[ -f "$TMP_HOME/runtime/versions/$VERSION/.install-complete" ] \
  || { echo "install sentinel missing" >&2; exit 1; }

STEP_START="$(now)"
"$INSTALLED_T3" serve --base-dir "$TMP_HOME" --port "$APP_PORT" --host 127.0.0.1 --no-browser \
  >"$LOG_DIR/serve.log" 2>&1 &
APP_PID=$!
HTTP_CODE="000"
for _ in $(seq 1 600); do
  HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/" 2>/dev/null || true)"
  [ "$HTTP_CODE" = "200" ] && break
  sleep 0.1
done
SERVE_SECONDS="$(elapsed "$STEP_START")"
[ "$HTTP_CODE" = "200" ] || { echo "served / returned $HTTP_CODE" >&2; tail -50 "$LOG_DIR/serve.log" >&2; exit 1; }
echo "==> serve:        pid $APP_PID on 127.0.0.1:$APP_PORT, GET / -> $HTTP_CODE in $SERVE_SECONDS"

curl -fsS "http://127.0.0.1:$APP_PORT/" >"$LOG_DIR/served-index.html"
echo "==> index.html:   $(wc -c <"$LOG_DIR/served-index.html" | tr -d ' ') bytes, title: $(grep -o '<title>[^<]*' "$LOG_DIR/served-index.html" | head -1 | sed 's/<title>//')"

CLIENT_DIR="$TMP_HOME/runtime/versions/$VERSION/client"
DICTATE_ASSET="$(grep -lF "$FORK_MARKER" "$CLIENT_DIR"/assets/*.js 2>/dev/null | head -1 || true)"
[ -n "$DICTATE_ASSET" ] || { echo "no built client chunk contains '$FORK_MARKER' under $CLIENT_DIR" >&2; exit 1; }
ASSET_NAME="$(basename "$DICTATE_ASSET")"
ASSET_CODE="$(curl -s -o "$LOG_DIR/served-asset.js" -w '%{http_code}' "http://127.0.0.1:$APP_PORT/assets/$ASSET_NAME")"
[ "$ASSET_CODE" = "200" ] || { echo "GET /assets/$ASSET_NAME returned $ASSET_CODE" >&2; exit 1; }
grep -qF "$FORK_MARKER" "$LOG_DIR/served-asset.js" || { echo "served $ASSET_NAME lacks '$FORK_MARKER'" >&2; exit 1; }
echo "==> fork build:   /assets/$ASSET_NAME -> $ASSET_CODE and contains '$FORK_MARKER' ($CLIENT_DIR)"

kill "$APP_PID"
wait "$APP_PID" 2>/dev/null || true
APP_PID=""
for _ in $(seq 1 100); do
  lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 0.1
done
if lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "server still listening on $APP_PORT after kill" >&2
  exit 1
fi
echo "==> stopped:      serve pid gone, port $APP_PORT closed"

echo
echo "SANDBOX PASS version=$VERSION update=$UPDATE_SECONDS serve=$SERVE_SECONDS"
