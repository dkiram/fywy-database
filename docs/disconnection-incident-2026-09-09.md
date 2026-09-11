# Nightly disconnection investigation — September 9, 2026

Production run 23 started at 00:00:39 Jamaica time. It selected 30 accounts,
reported 29 missing-mapping skips and one missing-device failure, and disconnected
zero customers. Its remaining count was zero: the batch cap did not cause this
night's skips.

The visible delinquent report included another 204 accounts that the scheduler
excluded because they had unverified ledger entries. The affected entries
included monthly anniversary charges dated August 20–September 9, not just old
opening balances. The user confirmed that the current delinquent balance,
including imported entries, should govern nightly disconnection.

## Deployed correction

The automatic worker now defaults to including unverified ledger entries in
both candidate selection and the final customer-locked eligibility check.
Explicit maintenance callers can still request the stricter policy. Payment,
hold, live device identity, unresolved action, and calendar protections remain.

The NAS source was updated after its SHA-256 matched the local original. The
previous source is retained on the NAS with suffix `.before-20260909`. The normal
production Compose build produced image
`sha256:ced737190a3ce7aea84fbb93ed7ea94ee6b732554cb4d4aed9c00c74da9f230c`.
The API container was recreated from that image. `/health` reported an available
API and connected database; Docker reported healthy. Startup confirmed midnight
Jamaica time, a 300-customer cap, and configuration saves after 120 minutes.
Local compilation and all 12 tests passed. The next scheduled run is September
10 at midnight Jamaica time; its disconnections have not yet been observed.
No immediate bulk disconnection was launched.

## Live mapping checks and remaining work

- Customer 14800, Coreen Gayle: exact live name and saved location matched.
  Missing serial was enrolled as `4857544399712FA6`, mapping verified, and an
  audit record inserted. No disconnection command was sent.
- Customer 7055, Patricia Robinson-Heavy Tree: live location, name, and serial
  currently match; ONT was active and online.
- Customer 12724, Maureen Spencer: no ONT found at saved location
  192.168.1.4 / 0/2/8 / ONT 71. Requires locating the device.
- Customer 14661, Sharon Lewars-Bunkers Hill Church Of God: saved location
  returns description `Sharon Lewars`. No identity override or verification was
  applied because the exact customer description did not match.

The final snapshot contains 180 accounts passing the initial selection/mapping
and unresolved-action checks (177 with unverified entries), 49 missing or
unverified/mismatched mappings, 3 unresolved earlier actions, and 7 active holds.
Counts can change with payments and staff work. Passing selection does not
establish live device identity; Maureen Spencer remains among that first group.
The same-day journal guard remains in place, so this snapshot is not a promise
of immediate execution.

Account IDs and the production run evidence are in
`../scratchpad/disconnection-diagnosis-2026-09-09.txt`. The reusable read-only SQL
is `../deploy/check-disconnection-eligibility.sql`.

Historical configuration-save failures also exist for August 25–28. These are
not proof that the latest disconnections were lost and were not blindly retried.
Device mapping recovery and resolution of uncertain earlier actions remain
outstanding; the billing-policy fix alone does not eliminate those skips.
