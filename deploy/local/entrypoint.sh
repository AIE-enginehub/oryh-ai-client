#!/bin/sh
set -eu
umask 077
mkdir -p "$HOME/workspace" "$HOME/.local/share/keyrings" "$HOME/.config/oryh-container"
# A private, persistent Linux Secret Service replaces the desktop OS keychain.
# This single-user development container trusts its own UID, including native Bash tools.
keyring_password="$HOME/.config/oryh-container/keyring-password"
if [ ! -f "$keyring_password" ]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$keyring_password"
fi
chmod 600 "$keyring_password"
eval "$(gnome-keyring-daemon --unlock --components=secrets < "$keyring_password")"
export GNOME_KEYRING_CONTROL
# Fail before opening the UI if credentials cannot be stored or survive a restart.
node --input-type=module <<'JS'
import { createRequire } from 'node:module'
import { existsSync, writeFileSync } from 'node:fs'
const require = createRequire('/opt/oryh-ai-client/packages/core/package.json')
const { Entry } = require('@napi-rs/keyring')
const marker = `${process.env.HOME}/.config/oryh-container/keyring-verified`
const entry = new Entry('ORYH Compose readiness', 'persistence-probe')
if (existsSync(marker) && entry.getPassword() !== 'ready') throw new Error('Linux credential store did not survive restart')
entry.setPassword('ready')
if (entry.getPassword() !== 'ready') throw new Error('Linux credential store is unavailable')
writeFileSync(marker, 'ready', { mode: 0o600 })
console.log('Linux credential store ready (persistence checked).')
JS
node scripts/install-profile.mjs
node deploy/local/model-config.mjs
# DSH remains loopback-only. The login gateway is the only published listener: it signs the person
# in with ORYH (OAuth authorization code + PKCE), obtains DSH's own session cookie for them, and
# hands the same sign-in to the client as its enterprise connection. DSH still checks Host, Origin
# and its cookie on every request.
export ORYH_CREDENTIAL_HANDOFF="$HOME/.config/oryh-container/connection-handoff.json"
export ORYH_CONTAINER_OWNER="$HOME/.config/oryh-container/owner.json"
exec node deploy/local/login-gateway.mjs -- pnpm exec dsh --profile oryh-web --host 127.0.0.1 --port 4174 --no-open --trusted-host 127.0.0.1:4180 localhost:4180
