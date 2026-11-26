#!/bin/bash
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed yet."
  echo "Get the LTS installer from https://nodejs.org , install it, then run this file again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
if [ ! -f node_modules/ws/package.json ]; then
  echo "Downloading the app's components for a first run or an update. This needs internet and takes a minute or two."
  npm install
fi
npm start
