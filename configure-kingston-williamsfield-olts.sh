#!/usr/bin/env bash
# Adds Kingston and Williamsfield OLT SSH connections to production without
# printing or placing their passwords in shell history. Run this on the NAS.

set -euo pipefail

DEPLOY_DIR="/Volume1/SPCL/deployment"
DOCKER="/Volume1/@apps/DockerEngine/dockerd/bin/docker"
COMPOSE="/Volume1/@apps/DockerEngine/dockerd/bin/docker-compose"
ENV_FILE="$DEPLOY_DIR/.env.production"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
EXPECTED_FINGERPRINT="SHA256:+mNKyiQ2aLeJo5F5gqvU2vOvXjp/RhA+vqxHfCbA4Mk"

for required in "$DOCKER" "$COMPOSE" "$ENV_FILE" "$COMPOSE_FILE"; do
  if [ ! -e "$required" ]; then
    echo "Required production path is missing: $required" >&2
    exit 1
  fi
done

read -r -s -p "Kingston OLT password for root (hidden): " KINGSTON_PASSWORD
printf '\n'
read -r -s -p "Williamsfield OLT password for root (hidden): " WILLIAMSFIELD_PASSWORD
printf '\n'

if [ -z "$KINGSTON_PASSWORD" ] || [ -z "$WILLIAMSFIELD_PASSWORD" ]; then
  echo "Neither OLT password may be blank." >&2
  exit 1
fi

CURRENT_JSON="$($DOCKER exec spcl-api node -e \
  'process.stdout.write(process.env.HUAWEI_OLT_CONNECTIONS_JSON || "{}")')"

UPDATED_JSON="$({
  printf '%s\0' \
    "$CURRENT_JSON" \
    "$KINGSTON_PASSWORD" \
    "$WILLIAMSFIELD_PASSWORD" \
    "$EXPECTED_FINGERPRINT"
} | $DOCKER exec -i spcl-api node -e '
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const [raw, kingstonPassword, williamsfieldPassword, fingerprint] =
      Buffer.concat(chunks).toString("utf8").split("\0");
    const configured = JSON.parse(raw || "{}");
    configured["192.168.1.24"] = {
      protocol: "ssh",
      port: 22,
      username: "root",
      password: kingstonPassword,
      hostKeySha256: fingerprint,
    };
    configured["192.168.1.47"] = {
      protocol: "ssh",
      port: 22,
      username: "root",
      password: williamsfieldPassword,
      hostKeySha256: fingerprint,
    };
    process.stdout.write(JSON.stringify(configured));
  });
')"

# Compose accepts a single-quoted dotenv value. Escape an unlikely apostrophe
# in a password before writing so the JSON remains one protected value.
ENV_VALUE="$(printf '%s' "$UPDATED_JSON" | $DOCKER exec -i spcl-api node -e '
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const quote = String.fromCharCode(39);
    const json = Buffer.concat(chunks).toString("utf8");
    process.stdout.write(quote + json.split(quote).join("\\" + quote) + quote);
  });
')"

unset CURRENT_JSON UPDATED_JSON KINGSTON_PASSWORD WILLIAMSFIELD_PASSWORD

cd "$DEPLOY_DIR"
BACKUP_FILE=".env.production.before-kingston-williamsfield-$(date +%Y%m%d-%H%M%S)"
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
  console.log("Configured OLT count:", Object.keys(configured).length);
  console.log("Kingston configured:", Boolean(configured["192.168.1.24"]));
  console.log("Williamsfield configured:", Boolean(configured["192.168.1.47"]));
'

"$DOCKER" exec -i spcl-api node <<'NODE'
const { createHash } = require("node:crypto");
const { Client } = require("ssh2");

const configured = JSON.parse(process.env.HUAWEI_OLT_CONNECTIONS_JSON || "{}");
const hosts = ["192.168.1.24", "192.168.1.47"];

function verifyHost(host) {
  return new Promise((resolve, reject) => {
    const secret = configured[host];
    if (!secret) return reject(new Error(`${host}: connection setting is missing`));
    const expected = String(secret.hostKeySha256 || "")
      .replace(/^sha256:/i, "")
      .replace(/=+$/, "");
    const connection = new Client();
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.end();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`${host}: timed out opening the OLT CLI`)),
      25000
    );

    connection
      .on("keyboard-interactive", (_name, _instructions, _language, prompts, done) => {
        done(prompts.map(() => secret.password));
      })
      .on("error", (error) => finish(new Error(`${host}: ${error.message}`)))
      .once("ready", () => {
        connection.shell({ term: "vt100", cols: 160, rows: 60 }, (error, stream) => {
          if (error) return finish(new Error(`${host}: ${error.message}`));
          console.log(`${host} SECURE CLI LOGIN OK`);
          stream.end("quit\r");
          finish();
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
  });
}

Promise.all(hosts.map(verifyHost)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
NODE

"$DOCKER" exec -i spcl-backup psql -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DO $block$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('Kingston'::TEXT, '192.168.1.24'::INET, 'Kingston'::TEXT),
      ('Williamsfield'::TEXT, '192.168.1.47'::INET, 'Williamsfield'::TEXT)
    ) AS values_to_add(name, management_ip, site)
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.olts
      WHERE normalized_name = UPPER(item.name)
        AND management_ip <> item.management_ip
    ) THEN
      RAISE EXCEPTION 'OLT name % already belongs to another IP.', item.name;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.olts
      WHERE management_ip = item.management_ip
        AND normalized_name <> UPPER(item.name)
    ) THEN
      RAISE EXCEPTION 'OLT IP % already belongs to another name.', item.management_ip;
    END IF;

    INSERT INTO public.olts (name, management_ip, site)
    VALUES (item.name, item.management_ip, item.site)
    ON CONFLICT DO NOTHING;
  END LOOP;
END
$block$;
COMMIT;

SELECT name, host(management_ip) AS management_ip, is_active
FROM public.olts
WHERE management_ip IN ('192.168.1.24'::INET, '192.168.1.47'::INET)
ORDER BY name;
SQL

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

echo "Kingston and Williamsfield are configured and available for customer OLT mappings."
