#!/bin/bash
# Double-click me (once) to make the WAVS Dashboard start by itself whenever this Mac logs in.
cd "$(dirname "$0")" || exit 1
echo "Setting up the WAVS Dashboard…"
if ! command -v node >/dev/null 2>&1; then
  for p in /opt/homebrew/bin /usr/local/bin; do [ -x "$p/node" ] && export PATH="$p:$PATH"; done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed. Download the LTS version from https://nodejs.org, install it, then double-click this file again."
  open "https://nodejs.org"
  read -r -p "Press Return to close."
  exit 1
fi
npm install --no-audit --no-fund || { read -r -p "Something went wrong (see above). Press Return to close."; exit 1; }
node scripts/service.mjs install && sleep 1 && open "http://localhost:8080"
read -r -p "Press Return to close this window."
