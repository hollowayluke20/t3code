#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: build-fork-archive.sh <repo-or-worktree-dir> <version> <out-dir> [<resource-monitor-source-dir>]

Builds a darwin-arm64 CLI archive for the checkout and publishes it where
`t3 update` looks for it:

  <out-dir>/v<version>/t3-<version>-darwin-arm64.tar.gz
  <out-dir>/v<version>/SHA256SUMS

The optional resource-monitor source is a directory laid out like
apps/server/dist/resource-monitor (containing darwin-arm64/t3-resource-monitor).
Without it, the newest resource-monitor under ~/.t3/runtime/versions is used.
EOF
}

fail() {
  printf 'build-fork-archive: error: %s\n' "$*" >&2
  exit 1
}

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  usage >&2
  exit 2
fi

REPO_DIR=$1
VERSION=$2
OUT_DIR=$3
RM_SOURCE_ARG=${4:-}

START_SECONDS=$SECONDS
VERSION_BACKUP_DIR=""
ARCHIVE_STAGE=""
RM_STAGE=""
VERSION_FILES=(
  "apps/server/package.json"
  "apps/desktop/package.json"
  "apps/web/package.json"
  "packages/contracts/package.json"
)

restore_version_files() {
  if [ -z "$VERSION_BACKUP_DIR" ] || [ ! -d "$VERSION_BACKUP_DIR" ]; then
    return 0
  fi
  local file
  for file in "${VERSION_FILES[@]}"; do
    if [ -f "$VERSION_BACKUP_DIR/$file" ]; then
      cp -p "$VERSION_BACKUP_DIR/$file" "$REPO_DIR/$file" || true
    fi
  done
  rm -rf "$VERSION_BACKUP_DIR"
  VERSION_BACKUP_DIR=""
}

cleanup() {
  local status=$?
  restore_version_files
  if [ -n "$ARCHIVE_STAGE" ]; then
    rm -rf "$ARCHIVE_STAGE"
  fi
  if [ -n "$RM_STAGE" ]; then
    rm -rf "$RM_STAGE"
  fi
  return "$status"
}

on_error() {
  local status=$?
  printf 'build-fork-archive: error: command failed (exit %s) at line %s\n' "$status" "$1" >&2
  exit "$status"
}

trap cleanup EXIT
trap 'on_error "$LINENO"' ERR

disk_free_gb() {
  df -g /System/Volumes/Data 2>/dev/null | awk 'NR == 2 { gsub(/[^0-9]/, "", $4); print $4 }'
}

require_free_disk() {
  local free
  free=$(disk_free_gb)
  [ -n "$free" ] || fail "could not read free space for /System/Volumes/Data"
  if [ "$free" -lt 20 ]; then
    fail "only ${free} GB free on /System/Volumes/Data; 20 GB is required"
  fi
  printf 'Free space: %s GB\n' "$free"
}

printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' ||
  fail "'$VERSION' is not a semantic version"

[ -d "$REPO_DIR" ] || fail "repo directory does not exist: $REPO_DIR"
REPO_DIR=$(cd "$REPO_DIR" && pwd -P)
[ -f "$REPO_DIR/package.json" ] || fail "no package.json in $REPO_DIR"
[ -f "$REPO_DIR/apps/server/package.json" ] || fail "no apps/server/package.json in $REPO_DIR"
[ -f "$REPO_DIR/scripts/build-cli-archive.ts" ] || fail "no scripts/build-cli-archive.ts in $REPO_DIR"
[ -f "$REPO_DIR/scripts/smoke-cli-archive.ts" ] || fail "no scripts/smoke-cli-archive.ts in $REPO_DIR"

mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd -P)

require_free_disk

if [ ! -d "$REPO_DIR/node_modules" ]; then
  printf 'Installing dependencies (node_modules is missing)...\n'
  if command -v vp >/dev/null 2>&1; then
    (cd "$REPO_DIR" && vp install)
  elif command -v pnpm >/dev/null 2>&1; then
    (cd "$REPO_DIR" && pnpm install)
  else
    fail "node_modules is missing and neither vp nor pnpm is on PATH"
  fi
fi

VP="$REPO_DIR/node_modules/.bin/vp"
[ -x "$VP" ] || fail "missing $VP; run the worktree setup or install dependencies"
export PATH="$REPO_DIR/node_modules/.bin:$PATH"

# Bake the public T3 Connect settings into the build (shell values win if already set).
PUBLIC_CONFIG_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/public-config.env"
if [ -f "$PUBLIC_CONFIG_FILE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    if [ -z "${!key:-}" ]; then export "$key=$value"; fi
  done <"$PUBLIC_CONFIG_FILE"
fi

command -v node >/dev/null 2>&1 || fail "node is not on PATH"

HOST_NODE_VERSION=$(node -p 'process.versions.node')
WANT_NODE_VERSION=$(cd "$REPO_DIR" && node -p 'require("./package.json").engines.node')

node_sea_disabled() {
  local output
  output=$("$1" --build-sea /nonexistent-sea-config.json 2>&1 || true)
  case "$output" in
    *"Single executable application is disabled"*) return 0 ;;
    *) return 1 ;;
  esac
}

BUILD_NODE_DIR=""
if [ "$HOST_NODE_VERSION" = "$WANT_NODE_VERSION" ] && ! node_sea_disabled "$(command -v node)"; then
  printf 'Using Node v%s at %s.\n' "$HOST_NODE_VERSION" "$(command -v node)"
else
  NODE_CACHE_DIR="$REPO_DIR/.t3/fork-build-node"
  BUILD_NODE_DIR="$NODE_CACHE_DIR/node-v$WANT_NODE_VERSION-darwin-arm64"
  if [ ! -x "$BUILD_NODE_DIR/bin/node" ] || node_sea_disabled "$BUILD_NODE_DIR/bin/node"; then
    printf 'Downloading Node v%s for darwin-arm64 (the host Node cannot build single executables)...\n' \
      "$WANT_NODE_VERSION"
    mkdir -p "$BUILD_NODE_DIR"
    node_archive="node-v$WANT_NODE_VERSION-darwin-arm64.tar.gz"
    node_url="https://nodejs.org/dist/v$WANT_NODE_VERSION"
    curl -fsSL --retry 3 --connect-timeout 10 -o "$BUILD_NODE_DIR/$node_archive" \
      "$node_url/$node_archive" ||
      fail "could not download $node_url/$node_archive"
    curl -fsSL --retry 3 --connect-timeout 10 -o "$BUILD_NODE_DIR/SHASUMS256.txt" \
      "$node_url/SHASUMS256.txt" ||
      fail "could not download $node_url/SHASUMS256.txt"
    (cd "$BUILD_NODE_DIR" && grep " $node_archive\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) ||
      fail "checksum verification failed for $node_archive"
    tar -xzf "$BUILD_NODE_DIR/$node_archive" -C "$BUILD_NODE_DIR" --strip-components=1 ||
      fail "could not extract $node_archive"
    rm -f "$BUILD_NODE_DIR/$node_archive" "$BUILD_NODE_DIR/SHASUMS256.txt"
    [ -x "$BUILD_NODE_DIR/bin/node" ] || fail "downloaded Node has no bin/node"
  fi
  export PATH="$BUILD_NODE_DIR/bin:$PATH"
  printf 'Using Node v%s at %s.\n' "$("$BUILD_NODE_DIR/bin/node" --version)" "$BUILD_NODE_DIR/bin/node"
fi

if git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  for file in "${VERSION_FILES[@]}"; do
    dirty=$(git -C "$REPO_DIR" status --porcelain -- "$file")
    if [ -n "$dirty" ]; then
      fail "refusing to build: $file has uncommitted changes ($dirty)"
    fi
  done
fi

VERSION_BACKUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/t3-fork-version-backup.XXXXXX")
for file in "${VERSION_FILES[@]}"; do
  [ -f "$REPO_DIR/$file" ] || fail "missing $file"
  mkdir -p "$VERSION_BACKUP_DIR/$(dirname "$file")"
  cp -p "$REPO_DIR/$file" "$VERSION_BACKUP_DIR/$file"
done

printf 'Stamping package versions as %s...\n' "$VERSION"
(cd "$REPO_DIR" && node scripts/update-release-package-versions.ts "$VERSION")
STAMPED=$(cd "$REPO_DIR" && node -p 'require("./apps/server/package.json").version')
[ "$STAMPED" = "$VERSION" ] || fail "version stamp failed: apps/server/package.json has $STAMPED"

printf 'Building web client and server bundle...\n'
(cd "$REPO_DIR" && "$VP" run --filter t3 build)
[ -f "$REPO_DIR/apps/server/dist/client/index.html" ] ||
  fail "server bundle did not produce apps/server/dist/client/index.html"

printf 'Building single executable...\n'
(cd "$REPO_DIR" && node apps/server/scripts/cli.ts build-exe)

if [ -f "$REPO_DIR/apps/server/dist-exe/t3-darwin-arm64" ]; then
  :
elif [ -f "$REPO_DIR/apps/server/dist-exe/t3" ]; then
  :
else
  fail "build-exe produced neither dist-exe/t3-darwin-arm64 nor dist-exe/t3"
fi

if [ -n "$RM_SOURCE_ARG" ]; then
  RM_SOURCE=$RM_SOURCE_ARG
else
  RM_SOURCE=""
  for candidate in "$HOME"/.t3/runtime/versions/*/resource-monitor; do
    [ -d "$candidate" ] || continue
    if [ -z "$RM_SOURCE" ] || [ "$candidate" -nt "$RM_SOURCE" ]; then
      RM_SOURCE=$candidate
    fi
  done
fi

[ -n "$RM_SOURCE" ] || fail "no resource-monitor source found; pass it as the fourth argument"
[ -d "$RM_SOURCE" ] || fail "resource-monitor source does not exist: $RM_SOURCE"
RM_SOURCE=$(cd "$RM_SOURCE" && pwd -P)
[ -x "$RM_SOURCE/darwin-arm64/t3-resource-monitor" ] ||
  fail "resource-monitor source is not laid out like dist/resource-monitor: $RM_SOURCE"

printf 'Staging resource monitor from %s...\n' "$RM_SOURCE"
RM_STAGE=$(mktemp -d "${TMPDIR:-/tmp}/t3-fork-resource-monitor.XXXXXX")
cp -R "$RM_SOURCE/." "$RM_STAGE/"
[ -x "$RM_STAGE/darwin-arm64/t3-resource-monitor" ] || fail "resource-monitor staging failed"

printf 'Building CLI archive...\n'
ARCHIVE_STAGE=$(mktemp -d "${TMPDIR:-/tmp}/t3-fork-archive.XXXXXX")
(cd "$REPO_DIR" && node scripts/build-cli-archive.ts \
  --platform mac \
  --arch arm64 \
  --version "$VERSION" \
  --resource-monitor-dir "$RM_STAGE" \
  --output-dir "$ARCHIVE_STAGE")

ARCHIVE_NAME="t3-$VERSION-darwin-arm64.tar.gz"
ARCHIVE_PATH="$ARCHIVE_STAGE/$ARCHIVE_NAME"
[ -f "$ARCHIVE_PATH" ] || fail "archive was not created: $ARCHIVE_PATH"

printf 'Running archive smoke test...\n'
(cd "$REPO_DIR" && node scripts/smoke-cli-archive.ts \
  --archive "$ARCHIVE_PATH" \
  --expect-version "$VERSION")

VERSION_DIR="$OUT_DIR/v$VERSION"
mkdir -p "$VERSION_DIR"
rm -f "$VERSION_DIR/$ARCHIVE_NAME" "$VERSION_DIR/SHA256SUMS"
mv "$ARCHIVE_PATH" "$VERSION_DIR/$ARCHIVE_NAME"
(cd "$VERSION_DIR" && shasum -a 256 "$ARCHIVE_NAME" > SHA256SUMS)
(cd "$VERSION_DIR" && shasum -a 256 -c SHA256SUMS >/dev/null) ||
  fail "checksum verification failed for $VERSION_DIR/$ARCHIVE_NAME"

require_free_disk

ARCHIVE_BYTES=$(stat -f %z "$VERSION_DIR/$ARCHIVE_NAME")
ELAPSED_SECONDS=$((SECONDS - START_SECONDS))
printf '\nPublished fork CLI archive\n'
printf '  archive:   %s (%s bytes)\n' "$VERSION_DIR/$ARCHIVE_NAME" "$ARCHIVE_BYTES"
printf '  checksums: %s\n' "$VERSION_DIR/SHA256SUMS"
printf '  version:   %s\n' "$VERSION"
printf '  build time: %ss\n' "$ELAPSED_SECONDS"
