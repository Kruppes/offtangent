#!/bin/bash
# Auto-track packages explicitly installed by the agent beyond the base image.
# Called automatically by DPkg::Post-Invoke apt hook after every dpkg operation.
# Only tracks manually (explicitly) installed packages — not auto-installed
# dependencies. This keeps the list small and avoids restoration failures
# from orphaned dependency packages.

BASE_FILE="/etc/dpkg-base-packages.txt"
TRACKED_FILE="/data/agent-packages.txt"

# Only track if prerequisites exist
[ -f "$BASE_FILE" ] || exit 0
[ -d "/data" ] || exit 0

# Get only explicitly (manually) installed packages, diff against base image
apt-mark showmanual 2>/dev/null | sort -u > /tmp/.dpkg-current-pkgs
comm -23 /tmp/.dpkg-current-pkgs "$BASE_FILE" > "$TRACKED_FILE" 2>/dev/null
rm -f /tmp/.dpkg-current-pkgs
