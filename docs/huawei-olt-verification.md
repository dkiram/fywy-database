# Huawei OLT read-only verification

The customer profile's **Verify with OLT** action is intentionally separate
from account status and network disconnection. It reads the saved
Frame/Card/PON/ONT tuple, connects from the NAS API to the MA5680T, runs only a
display command, and compares the live serial and customer Description with
the saved assignment.

## Safety properties

- OLT credentials exist only in `.env.production` on the NAS.
- Production refuses the SSH connection unless its host key is pinned.
- The browser receives no OLT password or raw CLI response.
- The verifier contains no activate, deactivate, delete, or state-changing
  configuration action.
- A network/CLI failure leaves the existing mapping status unchanged.
- A serial or customer-description difference marks the mapping `mismatch`.
- A successful comparison records who verified it, when, and an audit entry.

## Configuration

Add one JSON object to `.env.production`, keyed by OLT management IP:

```dotenv
HUAWEI_OLT_CONNECTIONS_JSON={"192.168.1.3":{"protocol":"ssh","port":22,"username":"READ_ONLY_USER","password":"SECRET","hostKeySha256":"SHA256:PINNED_FINGERPRINT"}}
```

The fingerprint can use the usual OpenSSH `SHA256:...` base64 form or a
64-character SHA-256 hex value. Use a dedicated read-only OLT account if the
firmware supports command authorization. Do not reuse an administrator's
personal login if a restricted account can be created.

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
