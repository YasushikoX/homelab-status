#!/bin/bash
# One-time bootstrap for a Linux host (or Proxmox LXC) that will run the
# dashboard: Debian / Ubuntu. Installs Tailscale (official repo), Node.js 24 LTS
# (from nodejs.org, checksum verified) and an unprivileged "status" user with
# its own SSH key, which the dashboard uses to reach your machines.
# Safe to re-run. Usage: sudo bash deploy/bootstrap-linux.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg openssh-client python3 xz-utils jq >/dev/null

if ! command -v tailscale >/dev/null; then
  curl -fsSL "https://pkgs.tailscale.com/stable/${ID}/${VERSION_CODENAME}.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL "https://pkgs.tailscale.com/stable/${ID}/${VERSION_CODENAME}.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
  apt-get update -qq
  apt-get install -y -qq tailscale >/dev/null
fi
echo "tailscale $(tailscale version | head -1)"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH=x64;; aarch64) ARCH=arm64;; esac
  V=$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false and (.version | startswith("v24.")))][0].version')
  cd /tmp
  curl -fsSLO "https://nodejs.org/dist/$V/node-$V-linux-$ARCH.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep " node-$V-linux-$ARCH.tar.xz\$" | sha256sum -c -
  mkdir -p /opt/node
  tar -xJf "node-$V-linux-$ARCH.tar.xz" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  rm -f "node-$V-linux-$ARCH.tar.xz"
fi
echo "node $(node -v)"

id status >/dev/null 2>&1 || useradd -r -m -d /opt/status -s /bin/bash status
su - status -c 'mkdir -p ~/.ssh ~/app ~/data && chmod 700 ~/.ssh && { test -f ~/.ssh/id_ed25519 || ssh-keygen -q -t ed25519 -N "" -C "homelab-status@$(hostname)" -f ~/.ssh/id_ed25519; }'
echo "Add this public key to each machine the dashboard should read (authorized_keys):"
cat /opt/status/.ssh/id_ed25519.pub
