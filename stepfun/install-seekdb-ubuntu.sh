#!/bin/sh
# Official Ubuntu 24.04 x86_64 package; extract without changing system packages.
set -eu
if [ "$(uname -m)" != x86_64 ]; then
  echo '此安装脚本用于 Linux x86_64；其他平台请用官方对应安装包。' >&2
  exit 1
fi
stepfun_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
stepfun_package="$stepfun_root/.seekdb-package"
mkdir -p "$stepfun_package"
curl -fL --retry 2 -o "$stepfun_package/seekdb.deb" 'https://mirrors.oceanbase.com/oceanbase/community/stable/ubuntu/noble/amd64/seekdb_1.4.0-100000212026082616ubuntu24.04_amd64.deb'
printf '%s  %s\n' '18f6b329d462a8fd841d43a12574cacce75f12b06156bdb0c7700d782478d5b1' "$stepfun_package/seekdb.deb" | sha256sum -c -
dpkg-deb -x "$stepfun_package/seekdb.deb" "$stepfun_package"
echo "SEEKDB_BINARY=$stepfun_package/usr/bin/seekdb sh $stepfun_root/start-seekdb.sh"
