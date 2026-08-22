# Huawei OLT verification and controlled ONT actions

The customer profile's **Verify with OLT** action is intentionally separate
from account status and network disconnection. It reads the saved
Frame/Card/PON/ONT tuple, connects from the NAS API to the MA5680T, runs only a
display command, and compares the live serial and customer Description with
the saved assignment.

## Safety properties

- OLT credentials exist only in `.env.production` on the NAS.
- Production refuses the SSH connection unless its host key is pinned.
- The browser receives no OLT password or raw CLI response.
- Live activate/deactivate is disabled unless both a global switch and an
  explicit customer-ID allowlist are configured on the NAS.
- A network/CLI failure leaves the existing mapping status unchanged.
- A serial or customer-description difference marks the mapping `mismatch`.
- A successful comparison records who verified it, when, and an audit entry.

## Configuration

Add one JSON object to `.env.production`, keyed by OLT management IP:

```dotenv
HUAWEI_OLT_CONNECTIONS_JSON={"192.168.1.3":{"protocol":"ssh","port":22,"username":"READ_ONLY_USER","password":"SECRET","hostKeySha256":"SHA256:PINNED_FINGERPRINT"}}
```

The fingerprint can use the usual OpenSSH `SHA256:...` base64 form or a
64-character SHA-256 hex value. If the firmware supports command authorization,
use a dedicated service account limited to display plus ONT activate/deactivate.
Do not reuse an administrator's personal login if that restricted account can
be created.

Newport's legacy `SSH-1.99-DOPRA-1.5` server offers only SHA-1 key exchange.
The verifier appends `diffie-hellman-group-exchange-sha1` after all modern
defaults because that is the algorithm the existing PuTTY client negotiates.
It does not enable the weaker fixed-group `diffie-hellman-group1-sha1` option,
and production still requires the OLT's SHA-256 host-key fingerprint.
The same server offers only legacy CBC encryption, so `aes128-cbc` is appended
after every modern cipher. Blowfish, 3DES, and DES remain disabled.

## One controlled test session

Before setting the secret, confirm in PuTTY whether Newport uses SSH and which
port it uses. From the NAS network, capture and independently compare the OLT
host-key fingerprint. Then configure the secret, rebuild/restart the API, and
use **Verify with OLT** on one spare/company ONT whose identity is already
known. If the older MA5680T requires legacy SSH algorithms, record the exact
handshake error and add only the necessary algorithm; do not enable a blanket
legacy compatibility set.

Actual deactivate/reactivate work starts only after this read-only test returns
`Verified` and the result agrees with PuTTY for the same test ONT.

## Test-only ONT controls

Keep the write switch off for normal deployments:

```dotenv
HUAWEI_OLT_WRITES_ENABLED=false
HUAWEI_OLT_WRITE_CUSTOMER_IDS=
```

For the first supervised test, set `HUAWEI_OLT_WRITES_ENABLED=true` and put
exactly one spare/company customer ID in `HUAWEI_OLT_WRITE_CUSTOMER_IDS`.
The profile then exposes test controls only for that allowlisted assignment.

Every requested action:

- requires Admin or Head Office authorization, a reason, and an exact typed
  confirmation containing the customer ID;
- re-reads and matches the live ONT serial and customer Description in the
  same SSH session immediately before the command;
- accepts only the fixed `ont activate` or `ont deactivate` command with
  numeric location values loaded from PostgreSQL;
- re-reads the ONT afterward and records the before/after state in
  `olt_action_attempts` plus Activity History;
- blocks another command after an uncertain result until a technician checks
  the ONT in PuTTY.

During this test phase the ONT control does **not** change billing or customer
account status. That integration is enabled only after deactivate and activate
both succeed on the spare/company ONT.
