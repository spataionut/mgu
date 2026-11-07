#!/usr/bin/env bash
# Put this repo's committed apps on a USB stick for the MGU Store.
#
# Exports HEAD with git archive (only committed files: never dist/, oap-sdk/,
# unit-dump/ or anything else ignored), then runs mgu-install.js usb-repo on it.
# Uncommitted changes are NOT included.
#
# Usage: tools/make-stick.sh [stick folder]   (default /Volumes/MGU)
set -euo pipefail

stick=${1:-/Volumes/MGU}
root=$(cd "$(dirname "$0")/.." && pwd)
installer=$root/mgu-install.js

[ -d "$stick" ] || { echo "No stick at $stick" >&2; exit 1; }
[ -f "$installer" ] || { echo "Missing $installer (download it from robertnisipeanu/mgu-store deploy/)" >&2; exit 1; }
if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  echo "Note: uncommitted changes are not included; only commit $(git -C "$root" rev-parse --short HEAD) goes on the stick." >&2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/servicebook"
git -C "$root" archive HEAD | tar xf - -C "$tmp/servicebook"

node "$installer" usb-repo "$stick" "$tmp/servicebook"
echo "Done. Eject the stick before unplugging it."
