#!/bin/bash
set -e
exec node "$(dirname "$0")/../check-secrets.mjs" "$@"
