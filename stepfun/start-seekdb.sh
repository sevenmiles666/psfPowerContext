#!/bin/sh
# Start an existing official seekdb 1.4+ binary, using an isolated data directory.
set -eu
stepfun_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
stepfun_binary=${SEEKDB_BINARY:-seekdb}
stepfun_data=${SEEKDB_DATA_DIR:-"$stepfun_root/.seekdb-data"}
mkdir -p "$stepfun_data"
exec "$stepfun_binary" --nodaemon --base-dir "$stepfun_data"
