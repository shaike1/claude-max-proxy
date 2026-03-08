#!/bin/bash
# Wrapper script for claude-max-proxy systemd service.
# Adjust NVM_NODE_PATH to match your Node.js version.
NVM_NODE_PATH=/root/.nvm/versions/node/v22.22.0/bin

export PATH=/root/.local/bin:${NVM_NODE_PATH}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

exec ${NVM_NODE_PATH}/node \
  ${NVM_NODE_PATH}/../lib/node_modules/claude-max-api-proxy/dist/server/standalone.js 3456
