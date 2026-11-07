#!/usr/bin/env bash
# Copy reference files off the head unit into ./unit-dump (git-ignored).
#
# Read-only on the unit: it runs find and tar and streams the result over ssh.
# It writes nothing there and restarts nothing.
#
# Usage: tools/unit-dump.sh -i <ssh key> [-h <host>] [-p <port>]
set -euo pipefail

host=172.16.222.97
port=22
key=

while getopts "i:h:p:" opt; do
  case "$opt" in
    i) key=$OPTARG ;;
    h) host=$OPTARG ;;
    p) port=$OPTARG ;;
    *) echo "usage: $0 -i <ssh key> [-h <host>] [-p <port>]" >&2; exit 2 ;;
  esac
done

if [ -z "$key" ]; then
  echo "usage: $0 -i <ssh key> [-h <host>] [-p <port>]" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/unit-dump
mkdir -p "$out"
chmod 700 "$out"

# Only explicit paths and UI description files. Never app data folders, which
# can hold personal data or tokens.
remote='
{
  echo etc/oap/someip/someip-interfaces.json
  echo var/opt/public/oap/oap_12204/source/javascript/app.js
  echo var/opt/public/oap/oap_12204/source/package.json
  cd /
  find usr/lib/oap-mainapp var/opt/public/oap -type f \
    -path "*rhmiData*" \
    \( -name application.xml -o -name uiDescription.json -o -name application.json \) \
    2>/dev/null
} | sort -u | ( cd / && tar czf - -T - 2>/dev/null )
'

echo "Reading from root@$host:$port into $out (nothing is written on the unit)"
# tar on the unit exits non-zero if a listed file is missing, so warn and let
# the summary below show what arrived.
ssh -i "$key" -p "$port" -o ConnectTimeout=10 "root@$host" "$remote" | tar xzf - -C "$out" \
  || echo "WARNING: the copy reported an error; check the list below" >&2

echo
echo "Files copied: $(find "$out" -type f | wc -l | tr -d ' ')"
for f in etc/oap/someip/someip-interfaces.json var/opt/public/oap/oap_12204/source/javascript/app.js; do
  if [ -f "$out/$f" ]; then
    echo "  ok      $f"
  else
    echo "  MISSING $f"
  fi
done
