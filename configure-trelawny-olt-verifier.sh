#!/usr/bin/env bash
# Adds the read-only Trelawny OLT SSH connection without replacing the
# existing Newport or Mandeville connections. Credentials travel only through
# the already-authenticated NAS control connection and are stored in the
# NAS-only production environment file.

set -euo pipefail

NAS_TARGET="SPCNAS@100.98.108.77"
NAS_SSH_PORT="9222"
NAS_CONTROL_PATH="/tmp/spcl-codex-nas.sock"
REMOTE_DIR="/Volume1/SPCL/deployment"
REMOTE_DOCKER="/Volume1/@apps/DockerEngine/dockerd/bin/docker"
REMOTE_COMPOSE="/Volume1/@apps/DockerEngine/dockerd/bin/docker-compose"
OLT_IP="192.168.1.2"
OLT_PORT="22"
OLT_FINGERPRINT="SHA256:+mNKyiQ2aLeJo5F5gqvU2vOvXjp/RhA+vqxHfCbA4Mk="

command -v node >/dev/null 2>&1 || {
  echo "Node.js is required on this Mac to encode the credential safely." >&2
  exit 1
}

if ! ssh -S "$NAS_CONTROL_PATH" -O check -p "$NAS_SSH_PORT" "$NAS_TARGET" >/dev/null 2>&1; then
  echo "The authenticated NAS connection is no longer open." >&2
  echo "Open it again, then rerun this script." >&2
  exit 1
fi

read -r -p "Trelawny OLT username [root]: " OLT_USERNAME
OLT_USERNAME="${OLT_USERNAME:-root}"
read -r -s -p "Trelawny OLT password (hidden): " OLT_PASSWORD
printf '\n'

if [ -z "$OLT_PASSWORD" ]; then
  echo "The OLT password cannot be blank." >&2
  exit 1
fi

# Read the current value directly into memory without printing it, then merge
# the new connection locally. Neither the existing nor new passwords appear in
# a command argument or terminal output.
EXISTING_JSON="$(ssh -S "$NAS_CONTROL_PATH" -o BatchMode=yes -p "$NAS_SSH_PORT" "$NAS_TARGET" \
  "$REMOTE_DOCKER exec spcl-api node -e 'process.stdout.write(process.env.HUAWEI_OLT_CONNECTIONS_JSON || \"{}\")'")"

OLT_ENV_VALUE="$({
  printf '%s\0' "$EXISTING_JSON" "$OLT_IP" "$OLT_PORT" "$OLT_USERNAME" "$OLT_PASSWORD" "$OLT_FINGERPRINT"
} | node -e '
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const [raw, ip, port, username, password, hostKeySha256] = Buffer.concat(chunks)
      .toString("utf8")
      .split("\0");
    const configured = JSON.parse(raw || "{}");
    configured[ip] = {
      protocol: "ssh",
      port: Number(port),
      username,
      password,
      hostKeySha256,
    };
    const quote = String.fromCharCode(39);
    const json = JSON.stringify(configured);
    process.stdout.write(quote + json.split(quote).join("\\" + quote) + quote);
  });
')"
unset EXISTING_JSON OLT_PASSWORD OLT_USERNAME

{
  printf "read -r olt_env_value <<'__SPCL_TRELAWNY_JSON__'\n%s\n__SPCL_TRELAWNY_JSON__\n" "$OLT_ENV_VALUE"
  printf '%s\n' \
    'set -eu' \
    "cd '$REMOTE_DIR'" \
    'env_file=.env.production' \
    'test -f "$env_file"' \
    'umask 077' \
    'tmp_file="$(mktemp .env.production.XXXXXX)"' \
    'trap '\''rm -f "$tmp_file"'\'' EXIT HUP INT TERM' \
    'grep -v '\''^HUAWEI_OLT_CONNECTIONS_JSON='\'' "$env_file" > "$tmp_file" || true' \
    'printf '\''\nHUAWEI_OLT_CONNECTIONS_JSON=%s\n'\'' "$olt_env_value" >> "$tmp_file"' \
    'unset olt_env_value' \
    'chmod 600 "$tmp_file"' \
    'mv "$tmp_file" "$env_file"' \
    'trap - EXIT HUP INT TERM'
} | ssh -S "$NAS_CONTROL_PATH" -o BatchMode=yes -p "$NAS_SSH_PORT" "$NAS_TARGET" 'sh -s'
unset OLT_ENV_VALUE

ssh -S "$NAS_CONTROL_PATH" -o BatchMode=yes -p "$NAS_SSH_PORT" "$NAS_TARGET" \
  "cd '$REMOTE_DIR' && '$REMOTE_COMPOSE' -f docker-compose.prod.yml --env-file .env.production up -d --no-deps --force-recreate api >/dev/null"

ssh -S "$NAS_CONTROL_PATH" -o BatchMode=yes -p "$NAS_SSH_PORT" "$NAS_TARGET" \
  "'$REMOTE_DOCKER' exec spcl-api node -e \"const configured=JSON.parse(process.env.HUAWEI_OLT_CONNECTIONS_JSON||'{}');const ids=process.env.HUAWEI_OLT_WRITE_CUSTOMER_IDS||'';console.log('Configured OLT count:',Object.keys(configured).length);console.log('Trelawny connection saved:',Boolean(configured['192.168.1.2']));console.log('ONT writes enabled:',process.env.HUAWEI_OLT_WRITES_ENABLED==='true');console.log('Allowlisted customer count:',ids?ids.split(',').filter(Boolean).length:0)\""

HEALTH="$(ssh -S "$NAS_CONTROL_PATH" -o BatchMode=yes -p "$NAS_SSH_PORT" "$NAS_TARGET" \
  "'$REMOTE_DOCKER' exec spcl-api node -e \"fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(t=>console.log(t)).catch(()=>process.exit(1))\"")"
if ! printf '%s' "$HEALTH" | grep -q '"status":"ok"'; then
  echo "The API did not report healthy after the restart." >&2
  exit 1
fi

echo "SPCL API healthy: true"

echo "Trelawny read-only OLT connection is configured."
