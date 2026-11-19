#!/bin/sh
# Deploy the OpenWrt aarch64 binary to the router. Assumes
# `make docker-openwrt` already produced dist/openwrt artifacts.
# OpenWrt specifics baked in from experience:
#   - dropbear has no sftp-server, so scp must use the legacy -O protocol
#   - scp -O drops the exec bit, and overwriting a running binary fails
#     with "Text file busy" — hence temp file + atomic mv + chmod
#   - the init service is named llm-gateway, not llm-router
set -e
ROOT=$(dist=dist/openwrt; cd "$(dirname "$0")/.." && pwd)
BIN="$ROOT/dist/openwrt/llm-router-openwrt-aarch64"
HOST=${1:-root@192.168.0.1}

[ -x "$BIN" ] || { echo "missing $BIN (run: make docker-openwrt)" >&2; exit 1; }

echo "→ copying"
scp -q -O "$BIN" "$HOST:/tmp/llm-router.new"
ssh "$HOST" '
  set -e
  mv /tmp/llm-router.new /usr/bin/llm-router
  chmod +x /usr/bin/llm-router
  /etc/init.d/llm-gateway restart
  # First boot after an upgrade may build schema/indexes; poll up to 30s.
  n=0
  while [ $n -lt 15 ]; do
    wget -qO- http://127.0.0.1:8090/health >/dev/null 2>&1 && break
    sleep 2
    n=$((n + 1))
  done
  [ $n -lt 15 ] || { echo "health check failed" >&2; exit 1; }
  echo "health: ok (after $((n * 2 + 2))s)"
  md5sum /usr/bin/llm-router
'
echo "→ local md5"
md5 -q "$BIN"
