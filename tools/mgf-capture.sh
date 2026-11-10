#!/bin/bash
# mgf-capture.sh - record what the MG Flasher iPhone app sends to the car over ENET.
#
# The iPhone is plugged into this Mac by USB. rvictl adds a virtual interface (rvi0) that
# mirrors all the phone's network traffic, and tcpdump writes it to private/ (git-ignored:
# the capture holds the VIN and the car's replies). Nothing is sent to the phone or the car.
#
#   tools/mgf-capture.sh            find the iPhone, start, record until Ctrl-C
#   tools/mgf-capture.sh <UDID>     use this UDID
#
# Then:  python3 tools/hsfz-parse.py private/mgf-<time>.pcap
set -u
cd "$(dirname "$0")/.."

RVICTL=$(command -v rvictl || echo /Library/Apple/usr/bin/rvictl)
[ -x "$RVICTL" ] || { echo "rvictl not found (it comes with Xcode: open Xcode once)"; exit 1; }
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}

UDID=${1:-}
if [ -z "$UDID" ]; then
    # physical devices only: "Name (iOS version) (UDID)" lines before the Simulators section
    UDID=$(xcrun xctrace list devices 2>/dev/null | sed '/Simulators/,$d' | grep -i -E 'iphone' | grep -o -E '\(([0-9A-Fa-f-]{24,40})\)$' | tr -d '()' | head -1)
fi
if [ -z "$UDID" ]; then
    echo "No iPhone found. Plug it in by USB, unlock it, tap Trust, then run again."
    echo "Or pass the UDID: Finder > the iPhone > click the line under its name until it shows the UDID."
    exit 1
fi
echo "iPhone UDID: $UDID"

# rvictl talks to Apple's rpmuxd daemon; on newer macOS it isn't loaded (rvictl: bootstrap_look_up(): 1102)
RPMUXD=/Library/Apple/System/Library/LaunchDaemons/com.apple.rpmuxd.plist
if [ -f "$RPMUXD" ] && ! launchctl print system/com.apple.rpmuxd >/dev/null 2>&1; then
    echo "Loading Apple's rpmuxd (needed by rvictl; asks for your Mac password)"
    sudo launchctl load -w "$RPMUXD" || { echo "could not load $RPMUXD"; exit 1; }
fi

mkdir -p private
OUT=private/mgf-$(date +%Y%m%d-%H%M%S).pcap
"$RVICTL" -s "$UDID" || { echo "rvictl could not start (unlock the phone and trust this Mac)"; exit 1; }
stop() {
    "$RVICTL" -x "$UDID" >/dev/null 2>&1
    [ -f "$OUT" ] && sudo chown "$(id -u):$(id -g)" "$OUT" && chmod 600 "$OUT"
    echo
    if [ -s "$OUT" ]; then echo "Stopped. Saved $OUT"; else echo "Stopped. Nothing was recorded."; fi
}
trap stop EXIT
sleep 2
ifconfig rvi0 >/dev/null 2>&1 || { echo "rvi0 did not appear"; exit 1; }

echo "Recording to $OUT. Do the steps in docs/mgflasher-capture.md, then press Ctrl-C."
echo "(tcpdump asks for your Mac password)"
# everything the phone sends: the ENET port isn't assumed, the parser picks out HSFZ and DoIP
sudo tcpdump -i rvi0 -s 0 -U -w "$OUT"
