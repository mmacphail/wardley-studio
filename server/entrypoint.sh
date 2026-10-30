#!/bin/sh
set -eu
# A new Fly volume is root-owned. The API itself runs as the unprivileged node user.
mkdir -p "$WARDLEY_WORKSPACE"
chown node:node "$WARDLEY_WORKSPACE"
exec gosu node "$@"
