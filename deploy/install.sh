#!/bin/bash
# Install claude-max-proxy as a systemd service.
# Run as root on the target host.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing claude-max-api-proxy npm package..."
npm install -g claude-max-api-proxy

echo "Installing wrapper script..."
cp "$SCRIPT_DIR/claude-max-proxy.sh" /usr/local/bin/claude-max-proxy.sh
chmod +x /usr/local/bin/claude-max-proxy.sh
# Restore SELinux context if applicable
command -v restorecon &>/dev/null && restorecon /usr/local/bin/claude-max-proxy.sh || true

echo "Installing systemd service..."
cp "$SCRIPT_DIR/claude-max-proxy.service" /etc/systemd/system/claude-max-proxy.service
systemctl daemon-reload
systemctl enable claude-max-proxy
systemctl restart claude-max-proxy

echo "Waiting for proxy to start..."
sleep 3
curl -s http://localhost:3456/v1/models | python3 -c 'import sys,json; [print(" -", m["id"]) for m in json.load(sys.stdin)["data"]]'
echo "Done. Proxy running on http://localhost:3456"
