#!/usr/bin/env bash
# Updates only Kingston's independently verified SSH host-key fingerprint.
# No OLT password is read, printed, or replaced. Run this script on the NAS.

set -euo pipefail

DEPLOY_DIR="/Volume1/SPCL/deployment"
DOCKER="/Volume1/@apps/DockerEngine/dockerd/bin/docker"
COMPOSE="/Volume1/@apps/DockerEngine/dockerd/bin/docker-compose"
ENV_FILE="$DEPLOY_DIR/.env.production"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
KINGSTON_IP="192.168.1.24"
OLD_FINGERPRINT="SHA256:+mNKyiQ2aLeJo5F5gqvU2vOvXjp/RhA+vqxHfCbA4Mk"
NEW_FINGERPRINT="SHA256:4ZjDII2+3s5gVaL10/ijHVljoMfQ6c04UWN/c2rSeLs"

for required in "$DOCKER" "$COMPOSE" "$ENV_FILE" "$COMPOSE_FILE"; do
  if [ ! -e "$required" ]; then
    echo "Required production path is missing: $required" >&2
    exit 1
  fi
done

CURRENT_JSON="$($DOCKER exec spcl-api node -e \
  'process.stdout.write(process.env.HUAWEI_OLT_CONNECTIONS_JSON || "{}")')"

UPDATED_JSON="$(printf '%s' "$CURRENT_JSON" | $DOCKER exec -i spcl-api node -e '
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const configured = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const ip = "192.168.1.24";
    const oldFingerprint = "SHA256:+mNKyiQ2aLeJo5F5gqvU2vOvXjp/RhA+vqxHfCbA4Mk";
    const newFingerprint = "SHA256:4ZjDII2+3s5gVaL10/ijHVljoMfQ6c04UWN/c2rSeLs";
    const connection = configured[ip];
    if (!connection) {
      console.error("Kingston is missing from HUAWEI_OLT_CONNECTIONS_JSON.");
      process.exit(1);
    }
    if (connection.hostKeySha256 === newFingerprint) {
      process.stdout.write(JSON.stringify(configured));
      return;
    }
    if (connection.hostKeySha256 !== oldFingerprint) {
      console.error("Kingston has an unexpected saved fingerprint; refusing to overwrite it.");
      process.exit(1);
    }
    connection.hostKeySha256 = newFingerprint;
    process.stdout.write(JSON.stringify(configured));
  });
')"

ENV_VALUE="$(printf '%s' "$UPDATED_JSON" | $DOCKER exec -i spcl-api node -e '
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const quote = String.fromCharCode(39);
    const json = Buffer.concat(chunks).toString("utf8");
    process.stdout.write(quote + json.split(quote).join("\\" + quote) + quote);
  });
')"
unset CURRENT_JSON UPDATED_JSON

cd "$DEPLOY_DIR"
BACKUP_FILE=".env.production.before-kingston-key-update-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$BACKUP_FILE"

umask 077
TMP_FILE="$(mktemp "$DEPLOY_DIR/.env.production.XXXXXX")"
cleanup() {
  [ ! -e "$TMP_FILE" ] || rm -f "$TMP_FILE"
}
trap cleanup EXIT HUP INT TERM
grep -v '^HUAWEI_OLT_CONNECTIONS_JSON=' "$ENV_FILE" > "$TMP_FILE" || true
printf '\nHUAWEI_OLT_CONNECTIONS_JSON=%s\n' "$ENV_VALUE" >> "$TMP_FILE"
unset ENV_VALUE
chmod 600 "$TMP_FILE"
mv "$TMP_FILE" "$ENV_FILE"
trap - EXIT HUP INT TERM

echo "Saved production environment backup: $DEPLOY_DIR/$BACKUP_FILE"

"$COMPOSE" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
  up -d --no-deps --force-recreate api

"$DOCKER" exec spcl-api node -e '
  const configured = JSON.parse(process.env.HUAWEI_OLT_CONNECTIONS_JSON || "{}");
  const connection = configured["192.168.1.24"];
  console.log("Kingston configured:", Boolean(connection));
  console.log(
    "Kingston fingerprint updated:",
    connection?.hostKeySha256 ===
      "SHA256:4ZjDII2+3s5gVaL10/ijHVljoMfQ6c04UWN/c2rSeLs"
  );
'

"$DOCKER" exec -i spcl-api node <<'NODE'
const { createHash } = require("node:crypto");
const { Client } = require("ssh2");

const host = "192.168.1.24";
const configured = JSON.parse(process.env.HUAWEI_OLT_CONNECTIONS_JSON || "{}");
const secret = configured[host];
if (!secret) throw new Error("Kingston connection setting is missing after restart.");

const expected = String(secret.hostKeySha256 || "")
  .replace(/^sha256:/i, "")
  .replace(/=+$/, "");
const connection = new Client();
let settled = false;
const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  console.error("Kingston timed out opening the secure OLT CLI.");
  connection.end();
  process.exitCode = 1;
}, 25000);

connection
  .on("keyboard-interactive", (_name, _instructions, _language, prompts, done) => {
    done(prompts.map(() => secret.password));
  })
  .on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    console.error(`Kingston SSH error: ${error.message}`);
    process.exitCode = 1;
  })
  .once("ready", () => {
    connection.shell({ term: "vt100", cols: 160, rows: 60 }, (error, stream) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        console.error(`Kingston CLI shell error: ${error.message}`);
        process.exitCode = 1;
      } else {
        console.log("Kingston SECURE CLI LOGIN OK");
        stream.end("quit\r");
      }
      connection.end();
    });
  })
  .connect({
    host,
    port: Number(secret.port || 22),
    username: secret.username,
    password: secret.password,
    tryKeyboard: true,
    readyTimeout: 15000,
    hostVerifier: (key) =>
      createHash("sha256").update(key).digest("base64").replace(/=+$/, "") === expected,
    algorithms: {
      kex: {
        append: ["diffie-hellman-group-exchange-sha1"],
        prepend: [],
        remove: [],
      },
      cipher: {
        prepend: ["aes128-ctr"],
        append: ["aes128-cbc"],
        remove: ["aes128-gcm@openssh.com", "aes256-gcm@openssh.com"],
      },
    },
  });
NODE

"$DOCKER" exec spcl-api node -e '
  fetch("http://127.0.0.1:3000/health")
    .then(async (response) => {
      const body = await response.text();
      console.log("API health:", response.status, body);
      if (!response.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error("API health check failed:", error.message);
      process.exitCode = 1;
    });
'

echo "Kingston pinned fingerprint updated and verified."
