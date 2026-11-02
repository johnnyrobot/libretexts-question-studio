#!/usr/bin/env bash
# Uploads one of the site's own model builds to qtistudio.libretexts.dev (LT-237).
#
#   scripts/deploy-models.sh <build> <stage root>                     dry run (the default)
#   DRY_RUN=0 DEPLOY_YES=1 scripts/deploy-models.sh <build> <stage root>   the real upload
#
# <stage root>/<build>/ comes from scripts/stage-model.py. The dry run checks
# the staged files against models/<build>/SHA256SUMS, then over ssh only reads:
# free disk space, whether the build is already there, and whether Caddy
# already serves /models/. It prints the files it would upload and the Caddy
# change. It uploads nothing and changes nothing.
#
# The real run uploads to /opt/libretexts/qtistudio-models/<build>.partial/,
# checks every sha256 on the server, renames the folder to <build>/ (a build
# that is already there is never replaced: a new build gets a new name), and,
# the first time, adds the /models/ handle to Caddy: backup, caddy validate,
# then reload. Upload the weights before the app build that uses them.
#
# Every ssh call shares one connection: the server refuses a burst of new ones.
set -euo pipefail

BUILD=${1:?usage: deploy-models.sh <build> <stage root>}
STAGE=${2:?usage: deploy-models.sh <build> <stage root>}/$BUILD
HOST=${DEPLOY_HOST:-hostinger}
DRY_RUN=${DRY_RUN:-1}
REMOTE_ROOT=/opt/libretexts/qtistudio-models
CADDYFILE=/etc/caddy/Caddyfile
REPO=$(cd "$(dirname "$0")/.." && pwd)
SUMS=$REPO/models/$BUILD/SHA256SUMS

case "$BUILD" in *[!a-z0-9._-]* | .*) echo "Not a build name: $BUILD" >&2; exit 2 ;; esac
[ -f "$SUMS" ] || { echo "No $SUMS" >&2; exit 2; }
[ "$DRY_RUN" = 1 ] || [ "${DEPLOY_YES:-}" = 1 ] || { echo "The real upload needs DEPLOY_YES=1 as well." >&2; exit 2; }

SOCKET=$(mktemp -u "${TMPDIR:-/tmp}/deploy-models.XXXXXX")
ssh -o ControlMaster=yes -o ControlPath="$SOCKET" -o ControlPersist=600 -fN "$HOST"
trap 'ssh -o ControlPath="$SOCKET" -O exit "$HOST" 2>/dev/null || true; rm -f "${CURRENT:-}" "${EDITED:-}"' EXIT
remote() { ssh -o ControlPath="$SOCKET" "$HOST" "$@"; }

# The Caddy change: /models/* is left out of the app's no-cache rule and
# served from outside the app's folder, so the app's rsync --delete never
# touches it. Inside route the steps run in the order written: the path
# WebLLM asks for (<build>/resolve/main/<file>) is mapped to the file first,
# so only files that exist get the year-long immutable header.
IFS= read -r -d '' MODELS_HANDLE <<'CADDY' || true
	# The site's own model builds (LT-237, scripts/deploy-models.sh): one
	# folder per build, never changed, outside the app's folder.
	handle_path /models/* {
		route {
			uri replace /resolve/main/ /
			root * /opt/libretexts/qtistudio-models
			@found file
			header @found Cache-Control "public, max-age=31536000, immutable"
			header Access-Control-Allow-Origin "https://qtistudio.libretexts.dev"
			file_server
		}
	}

CADDY
APP_RULE_BEFORE='	@unhashed not path /assets/*'
APP_RULE_AFTER='	@unhashed not path /assets/* /models/*'
APP_ROOT='	root * /opt/libretexts/qtistudio'

# Caddyfile on stdin, changed Caddyfile out; refuses one that is not as expected.
edit_caddyfile() {
  python3 -I -c '
import sys
before, after, root, handle = sys.argv[1:5]
text = sys.stdin.read()
assert text.count(before + "\n") == 1 and text.count(root + "\n") == 1, "the qtistudio block has changed; edit Caddy by hand"
sys.stdout.write(text.replace(before + "\n", after + "\n").replace(root + "\n", handle + root + "\n"))
' "$APP_RULE_BEFORE" "$APP_RULE_AFTER" "$APP_ROOT" "$MODELS_HANDLE"
}

echo "== Build $BUILD, staged in $STAGE"
(cd "$STAGE" && shasum -a 256 -c --quiet "$SUMS") || { echo "Staged files do not match SHA256SUMS." >&2; exit 1; }
for name in MODEL.md SHA256SUMS; do cmp -s "$STAGE/$name" "$REPO/models/$BUILD/$name" || { echo "$STAGE/$name differs from the repo's." >&2; exit 1; }; done
FILES=$(awk '{print $2}' "$SUMS"; printf 'MODEL.md\nSHA256SUMS\n')
# "<bytes>  <name>" per file; wc -c rather than stat, whose flags differ between macOS and Linux.
SIZES=$(cd "$STAGE" && echo "$FILES" | while read -r name; do printf '%s  %s\n' "$(wc -c < "$name" | tr -d ' ')" "$name"; done)
BYTES=$(echo "$SIZES" | awk '{s+=$1} END {print s}')
echo "All $(awk 'END {print NR}' "$SUMS") pinned files match. To upload: $(echo "$FILES" | awk 'END {print NR}') files, $BYTES bytes."

echo "== Server ($HOST)"
remote "df -B1 --output=avail,target /opt/libretexts | tail -1" | awk -v need="$BYTES" '{printf "Free on %s: %d bytes (%.1f GB); the upload needs %.1f GB.\n", $2, $1, $1/1e9, need/1e9; if ($1 < need * 1.2) {print "Not enough room (wants 20% to spare)."; exit 1}}'
# Asked as a printed answer, so a failed ssh stops the script instead of reading as "not there".
ALREADY=$(remote "if test -e $REMOTE_ROOT/$BUILD; then echo 1; else echo 0; fi")
if [ "$ALREADY" = 1 ]; then
  echo "$REMOTE_ROOT/$BUILD is already there; builds are never replaced."
else
  echo "$REMOTE_ROOT/$BUILD is not there yet."
fi
CURRENT=$(mktemp) EDITED=$(mktemp)
remote "cat $CADDYFILE" > "$CURRENT"
if grep -q 'handle_path /models/\*' "$CURRENT"; then
  echo "Caddy already serves /models/."
  CADDY_DONE=1
else
  edit_caddyfile < "$CURRENT" > "$EDITED"
  echo "Caddy does not serve /models/ yet."
  CADDY_DONE=0
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "== Would upload to $HOST:$REMOTE_ROOT/$BUILD/"
  echo "$SIZES"
  if [ "$CADDY_DONE" = 0 ]; then
    echo "== Would change $CADDYFILE (backup first, caddy validate, then reload):"
    diff -u --label "$CADDYFILE" --label "$CADDYFILE (changed)" "$CURRENT" "$EDITED" || true
  fi
  echo "== Dry run: nothing was uploaded or changed."
  exit 0
fi

if [ "$ALREADY" = 0 ]; then
  echo "== Uploading"
  remote "mkdir -p $REMOTE_ROOT/$BUILD.partial"
  (cd "$STAGE" && echo "$FILES" | rsync -a --partial --files-from=- -e "ssh -o ControlPath=$SOCKET" . "$HOST:$REMOTE_ROOT/$BUILD.partial/")
  remote "cd $REMOTE_ROOT/$BUILD.partial && sha256sum -c --quiet SHA256SUMS && chmod -R a+rX . && mv $REMOTE_ROOT/$BUILD.partial $REMOTE_ROOT/$BUILD"
  echo "Uploaded and checked on the server."
fi

if [ "$CADDY_DONE" = 0 ]; then
  echo "== Caddy"
  BACKUP=$CADDYFILE.bak-$(date -u +%Y%m%dT%H%M%SZ)-models
  remote "cat > /tmp/Caddyfile.models" < "$EDITED"
  # Installed only if the server's file is still the one the change was made from.
  remote "echo '$(shasum -a 256 < "$CURRENT" | cut -d' ' -f1)  $CADDYFILE' | sha256sum -c --quiet \
    && sudo caddy validate --adapter caddyfile --config /tmp/Caddyfile.models \
    && sudo cp -p $CADDYFILE $BACKUP && sudo cp /tmp/Caddyfile.models $CADDYFILE && sudo systemctl reload caddy"
  echo "Caddy reloaded. Backup: $BACKUP"
fi

echo "== Check"
curl -sfI "https://qtistudio.libretexts.dev/models/$BUILD/resolve/main/mlc-chat-config.json" | grep -i -E '^(HTTP|cache-control|access-control-allow-origin|content-length)'
