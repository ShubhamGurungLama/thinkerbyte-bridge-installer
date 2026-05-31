#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="${TBLAB_REPO_OWNER:-ShubhamGurungLama}"
REPO_NAME="${TBLAB_REPO_NAME:-thinkerbyte-bridge-installer}"
REPO_REF="${TBLAB_REPO_REF:-main}"
ARCHIVE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${REPO_REF}.tar.gz"

BASE_DIR="${HOME}/.thinkerbyte"
BRIDGE_DIR="${BASE_DIR}/bridge"
BIN_DIR="${HOME}/.local/bin"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP_DIR}" || true
}
trap cleanup EXIT

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[error] missing command: $1"
    exit 1
  }
}

need_cmd curl
need_cmd tar
need_cmd node

mkdir -p "${BASE_DIR}" "${BIN_DIR}"

echo "[info] downloading ThinkerByte bridge bundle..."
curl -fsSL "${ARCHIVE_URL}" -o "${TMP_DIR}/bundle.tar.gz"
tar -xzf "${TMP_DIR}/bundle.tar.gz" -C "${TMP_DIR}"

SRC_ROOT="$(find "${TMP_DIR}" -maxdepth 1 -type d -name '*thinkerbyte-bridge-installer*' | head -n 1)"
if [ -z "${SRC_ROOT}" ]; then
  echo "[error] unable to locate extracted installer bundle"
  exit 1
fi

rm -rf "${BRIDGE_DIR}"
mkdir -p "${BRIDGE_DIR}"
cp -R "${SRC_ROOT}/bridge/." "${BRIDGE_DIR}/"

cat > "${BIN_DIR}/tblab-bridge" <<'SH'
#!/usr/bin/env sh
set -eu
exec node "$HOME/.thinkerbyte/bridge/agent/bridge-agent.js" "$@"
SH
chmod +x "${BIN_DIR}/tblab-bridge"

cat > "${BIN_DIR}/tblab-bridge-start" <<'SH'
#!/usr/bin/env sh
set -eu
LOG_DIR="$HOME/.thinkerbyte/bridge/logs"
mkdir -p "$LOG_DIR"
nohup "$HOME/.local/bin/tblab-bridge" >"$LOG_DIR/bridge.log" 2>&1 &
echo $! > "$HOME/.thinkerbyte/bridge/bridge.pid"
echo "started ThinkerByte Bridge pid $(cat "$HOME/.thinkerbyte/bridge/bridge.pid")"
SH
chmod +x "${BIN_DIR}/tblab-bridge-start"

if ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
  echo "[warn] docker/podman not found. Install one runtime for full networking labs."
fi

echo "[ok] ThinkerByte Bridge installed."
echo "[next] Start bridge: ~/.local/bin/tblab-bridge-start"
echo "[next] Health check: curl -fsS http://127.0.0.1:19777/health"
