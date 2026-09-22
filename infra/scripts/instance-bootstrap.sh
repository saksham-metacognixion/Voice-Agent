#!/usr/bin/env bash
# One-time EC2 instance preparation (Ubuntu 24.04 or Amazon Linux 2023) — ADR 0004, ADR 0015.
#
# A box created from infra/aws/staging-stack.yaml has already run the package half of this
# as user data (check /var/log/voice-agent-bootstrap.done); on such a box only the second
# half — the registry login and the private clone — is needed, and it is safe to run the
# whole script again. Run as root once, then every deploy is infra/scripts/deploy.sh over SSM.
#
#   GH_USER=<github user> GH_TOKEN=<classic PAT: repo + read:packages> ./instance-bootstrap.sh
#
# The repository is private: CI's deploy does `git fetch` on the box and `docker compose pull`
# reads GHCR, so one read-only token is stored for both — in root's docker config and in
# /root/.git-credentials (mode 600). It never goes in SSM, the template or the repo.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Metacognixion-labs/AI_Voiceagent_MCX.git}"
APP_DIR="${APP_DIR:-/opt/voice-agent}"

if [ ! -f /var/log/voice-agent-bootstrap.done ]; then
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg git unattended-upgrades
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    snap install aws-cli --classic 2>/dev/null || true
    systemctl enable --now unattended-upgrades
  else
    dnf install -y docker git
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  fi
  systemctl enable --now docker
  mkdir -p "$APP_DIR/caddy"
  git config --system credential.helper 'store --file /root/.git-credentials'
  echo 'voice-agent bootstrap done' > /var/log/voice-agent-bootstrap.done
fi

if [ -z "${GH_USER:-}" ] || [ -z "${GH_TOKEN:-}" ]; then
  echo "Packages are in place. Now the private repository and the registry:"
  echo "  GH_USER=<github user> GH_TOKEN=<classic PAT with repo + read:packages> $0"
  exit 0
fi

# Registry (docker compose pull) and repository (git fetch in the deploy) share the token.
printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin
umask 077
printf 'https://%s:%s@github.com\n' "$GH_USER" "$GH_TOKEN" > /root/.git-credentials
umask 022
if [ -d "$APP_DIR/infra/.git" ]; then
  git -C "$APP_DIR/infra" fetch --quiet origin
  git -C "$APP_DIR/infra" checkout --quiet develop && git -C "$APP_DIR/infra" pull --quiet --ff-only
else
  git clone --quiet --branch develop "$REPO_URL" "$APP_DIR/infra"
fi
echo "ready — first deploy:  sudo $APP_DIR/infra/infra/scripts/deploy.sh staging develop"
