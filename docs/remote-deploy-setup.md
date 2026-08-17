# Deploying to the NAS from anywhere

Right now, changing anything on the NAS means being on the office network in
Jamaica. This is the one-time setup that removes that, so deploying from
Toronto is a single command.

You do this **once**. After that you never open UltraViewer for deployment
again.

```
   Your laptop, Toronto                   The NAS, Jamaica
   ────────────────────                   ────────────────
   edit code
   ./deploy/deploy.sh  ──── Tailscale ───▶  git pull
                                            rebuild
        git push ──▶ GitHub ───pull────▶     migrate
                                            restart
                     ◀─── "it's healthy" ───
```

Two separate paths, doing two different jobs:

- **GitHub carries the code.** You push, the NAS pulls. The NAS only needs
  outbound internet, which it has.
- **Tailscale carries the control.** It is how you tell the NAS to go and do
  it, and how you see whether it worked.

Tailscale is a private network of your own devices. Install it on two machines
and they can reach each other from anywhere on earth — no ports opened on the
router, nothing exposed to the internet, no static IP. It is not a VPN in the
NordVPN sense; that kind sends your browsing through someone else's servers
and cannot connect you to your father's house.

---

## Before you start

- UltraViewer access to a home-office computer that is on the same network as
  the NAS.
- The NAS admin password.
- The real path to the deployment folder on the NAS. In TOS File Manager it
  is usually something like `/Volume1/SPCL/deployment` or
  `/mnt/md0/SPCL/deployment`.
- About 30–45 minutes, most of it waiting.

Do this when nobody is entering data, in case a restart is needed.

---

## 1. Make a Tailscale account

On your own laptop, before you connect to anything.

1. Go to `tailscale.com` and sign up. The free tier covers up to 100 devices —
   far more than this needs, and it does not expire.
2. Install Tailscale on your laptop and sign in.
3. In the admin console, open **Settings → Keys → Generate auth key**.
   - Set **Reusable** on
   - Set **Expiry** to 90 days
   - Give it a tag or description like `spcl-nas`
4. Copy the key. It starts with `tskey-auth-`. You will paste it into the NAS
   in step 3, so keep it to hand — and treat it like a password.

---

## 2. Get to a terminal on the NAS

Open UltraViewer and connect to the home-office computer. Everything from here
happens inside that session.

If SSH is not already enabled on the NAS, turn it on in TOS: **Control Panel →
Terminal & SNMP → Enable SSH**.

Then from the home-office computer, open Command Prompt or PowerShell:

```
ssh admin@192.168.1.8
```

Use the NAS's real address. You should land at a shell prompt on the NAS.

---

## 3. Put Tailscale on the NAS

The NAS already runs Docker, so the most reliable route on TOS is a container
rather than a TOS app package. Run this on the NAS, with your auth key from
step 1:

First confirm the NAS has the TUN device, which Tailscale needs in order to
create a real network interface:

```bash
ls -l /dev/net/tun
```

If that reports no such file, load the module and check again:

```bash
modprobe tun && ls -l /dev/net/tun
```

Then start it:

```bash
docker run -d \
  --name tailscale \
  --hostname spcl-nas \
  --restart unless-stopped \
  --network host \
  --cap-add NET_ADMIN \
  --cap-add NET_RAW \
  --device /dev/net/tun \
  -v /Volume1/SPCL/tailscale-state:/var/lib/tailscale \
  -e TS_AUTHKEY=tskey-auth-PASTE-YOURS-HERE \
  -e TS_STATE_DIR=/var/lib/tailscale \
  -e TS_HOSTNAME=spcl-nas \
  -e TS_USERSPACE=false \
  tailscale/tailscale:latest
```

Adjust `/Volume1/SPCL/tailscale-state` to match your real path. That volume is
what lets the NAS stay logged in across reboots — without it, a power cut
means re-authenticating, which means another UltraViewer session.

**`TS_USERSPACE=false` and `--device /dev/net/tun` are not optional here.**
The container defaults to userspace networking, which is fine for a container
that only makes outbound connections. In that mode the NAS still appears in
your Tailscale console looking perfectly healthy, but nothing running *on the
NAS* — SSH included — is reachable at the Tailscale address. Kernel mode
creates a real `tailscale0` interface on the host, which is what makes
`ssh admin@100.x.y.z` work from Toronto.

Check it connected:

```bash
docker logs tailscale --tail 30
docker ps --filter name=tailscale
```

You are looking for `Authenticated` or a transition to `Running` in the logs,
and the container still present in `docker ps` a minute later.

If the logs say the key is invalid, the auth key was single-use and the first
attempt consumed it — generate a new one with **Reusable** turned on.

Then look at your Tailscale admin console in a browser. `spcl-nas` should
appear in the machine list with an address starting `100.`.

**Write that address down.** That is how you reach the NAS from now on.

While you are in the admin console, open the `spcl-nas` machine and **disable
key expiry**. Otherwise it drops off the network in a few months and you need
UltraViewer again to fix it. This is the single most common way this setup
breaks months later.

---

## 4. First-time setup on the NAS

This is the step that makes the NAS able to pull the code. Two things have to
be true: it needs a git, and that git needs credentials for a private
repository. Neither is true out of the box.

**TOS ships without git.** You can install it from the App Center if it is
offered, but do not count on it — `deploy.sh` runs git inside an `alpine/git`
container against the same directory, which works on any TOS version. All the
commands below use that container.

### 4a. Make a token for the NAS

On GitHub, signed in as the account that owns `dkimaree-bot/fywy-database`:

**Settings → Developer settings → Personal access tokens → Fine-grained
tokens → Generate new token**

- **Repository access:** Only select repositories → `fywy-database`
- **Permissions:** Repository permissions → **Contents: Read-only**. Nothing
  else. The NAS only ever reads.
- **Expiration:** whatever you will actually remember to rotate. A year is
  reasonable; when it lapses, deploys fail with a clear message and you write
  a new token into the same file.

Copy the token. It starts with `github_pat_`. You will not see it again.

### 4b. Put the token on the NAS

SSH into the NAS and write the token into a file of its own — not into
`.git/config`, and not into the deployment directory:

```bash
unset HISTFILE                    # keep the token out of shell history

mkdir -p /Volume1/SPCL/secrets
chmod 700 /Volume1/SPCL/secrets

cat > /Volume1/SPCL/secrets/git-credentials <<'EOF'
https://dkimaree-bot:github_pat_PASTE_YOURS_HERE@github.com
EOF

chmod 600 /Volume1/SPCL/secrets/git-credentials
```

That directory is mounted into the git container, and `deploy.conf` points at
the file with `SPCL_GIT_CREDENTIALS`. Keep the directory dedicated to secrets:
everything in it is visible to that container.

### 4c. Give yourself a git you can type

Still on the NAS. This is the same command `deploy.sh` builds internally, as a
shell function so the rest of this section reads normally:

```bash
g() {
  /Volume1/@apps/DockerEngine/dockerd/bin/docker run --rm \
    -v /Volume1/SPCL/deployment:/repo -w /repo -e HOME=/tmp \
    -v /Volume1/SPCL/secrets:/creds \
    alpine/git \
      -c safe.directory=/repo \
      -c "credential.helper=store --file=/creds/git-credentials" "$@"
}
```

`safe.directory` is needed because the checkout is owned by a different uid
than the one inside the container, and modern git refuses to touch a
repository it thinks belongs to someone else.

Check the credentials work before touching anything:

```bash
g ls-remote origin 2>&1 | head -3
```

- A list of refs — good, carry on.
- `could not read Username` — the credentials file is missing, unreadable, or
  in the wrong place.
- `Repository not found` — the token is valid but cannot see this repo. Either
  the repository name is wrong or the token was scoped to a different one.

### 4d. Turn the deployment directory into a real checkout

The deployment directory already has files in it — `.env.production` above
all, which exists only on the NAS and must survive. Back it up first, then
force it onto `origin/main`:

```bash
tar czf "/Volume1/SPCL/deployment-backup-$(date +%Y%m%d-%H%M).tar.gz" \
  -C /Volume1/SPCL deployment

cd /Volume1/SPCL/deployment

g init
g remote remove origin 2>/dev/null
g remote add origin https://github.com/dkimaree-bot/fywy-database.git
g fetch origin main
g checkout -f -B main origin/main
g log --oneline -3
```

`checkout -f -B main` does three things at once: creates `main` (the repo was
left on an empty `master` by `git init`), points it at what GitHub has, and
replaces anything that was hand-edited on the NAS. That last part is why the
backup comes first.

`.env.production` is gitignored, so it is untracked and stays exactly where it
is. Confirm before moving on:

```bash
ls -la .env.production
g status --short
```

From here the NAS is a normal checkout and `deploy.sh` drives it. You should
not need to run `g` by hand again.

---

## 4a. Let Tailscale traffic through the NAS firewall

**Do not skip this.** TOS ships its own firewall — the `INPUT_PROTECT` chain —
which restricts the SSH port to the local network. Tailscale traffic is
dropped silently, so SSH from outside just times out with no explanation.

The tell-tale sign is an asymmetry: port 22 answers with a clean
"Connection refused" while port 9222 times out entirely. A closed port
refuses; a firewalled port says nothing.

On the NAS:

```bash
iptables -I INPUT 1 -i tailscale0 -j ACCEPT
iptables-legacy -I INPUT 1 -i tailscale0 -j ACCEPT 2>/dev/null
```

Two commands because TOS has both the modern and legacy iptables rule sets
active at once, and a DROP in either one is enough to kill the packet. The
second may error harmlessly.

This allows anything arriving over Tailscale, which is a reasonable trust
boundary — only your own devices are on the tailnet. To undo it, use
`-D INPUT` in place of `-I INPUT 1`.

### After a reboot, run it again

**These rules do not survive a restart**, and that is a deliberate choice
rather than an oversight. TOS's own firewall UI does not work here — its
rules match physical interfaces and never see `tailscale0` — and both a
watchdog container and a boot script were tried and rejected as more moving
parts than the problem deserves.

So: if the NAS loses power, remote SSH stops working until the two commands
above are run again. That means one UltraViewer session into a home-office
computer, roughly two minutes.

**The symptom, so you recognise it instantly:** `ssh` to the Tailscale address
hangs and eventually times out, while `tailscale ping spcl-nas` still returns
pong perfectly. Tailscale is fine; the firewall rule is gone. Scroll up, paste
the two `iptables` lines, done.

Do not spend an evening debugging this. It is always the same thing.

---

## 5. Test it from your own laptop

Close UltraViewer. From Toronto:

```bash
ssh SPCNAS@100.98.108.77 -p 9222
```

Three things that are easy to get wrong here:

- **The username is `SPCNAS`**, not `admin` or `root`. If you are unsure, run
  `whoami` while logged into the NAS.
- **The port is 9222.** TOS does not use the usual 22.
- **The password does not echo as you type it.** No dots, no asterisks,
  nothing moves. That is normal.

If that lands you on the NAS, you are done with the hard part — permanently.

---

## 6. Set up the deploy command

Back in the project on your laptop:

```bash
cp deploy/deploy.conf.template deploy/deploy.conf
```

Edit `deploy/deploy.conf` and set:

```
SPCL_SSH=SPCNAS@100.98.108.77
SPCL_SSH_PORT=9222
SPCL_REMOTE_DIR=/Volume1/SPCL/deployment
SPCL_GIT_CREDENTIALS=/Volume1/SPCL/secrets/git-credentials
```

`SPCL_GIT_CREDENTIALS` is a path **on the NAS**, not on your laptop — the file
you created in step 4b. The token itself never leaves the NAS.

Use the **Tailscale** address, not the 192.168 one. Tailscale works both on
the office network and off it, so there is nothing to switch between.

Worth the two minutes — an SSH key, so you are not typing the NAS password on
every single deploy:

```bash
ssh-keygen -t ed25519                              # if you do not have one
ssh-copy-id -p 9222 SPCNAS@100.98.108.77
```

Then try it without changing anything:

```bash
./deploy/deploy.sh --check
```

`--check` connects, shows which commits would go out, and stops. It changes
nothing on the NAS.

---

## Deploying, from then on

```bash
./deploy/deploy.sh
```

That is the whole workflow. It will:

1. Warn you about uncommitted work, then push to GitHub
2. Pull on the NAS and show you which commits arrived
3. Show any pending migrations and **ask before applying them**
4. Rebuild and restart the containers
5. Wait for PostgreSQL and confirm the API came back healthy
6. Check that your backups are still in good shape

### Why migrations run before the restart

Step 3 comes before step 4 on purpose. If the containers restarted first, the
new code would run against the old schema until the migration finished —
seconds, but seconds in which someone mid-form gets an error about a column
that does not exist yet.

Migrating first inverts that: the *old* code runs briefly against the *new*
schema, which is harmless as long as migrations only add things. Old code
ignores a column it has never heard of.

That is the one rule this depends on: **add in one deploy, drop in a later
one.** Ship the new column and code that tolerates it being empty, backfill,
and only remove the old column once nothing references it. A migration that
drops something the running code still uses breaks the same window from the
other direction.

It also fails better. If a migration fails, nothing has been rebuilt yet, so
the app carries on serving the old code against the old schema and you can
fix the SQL without any pressure.

Useful variations:

| Command | What it does |
|---|---|
| `./deploy/deploy.sh --check` | Shows what would happen, changes nothing |
| `./deploy/deploy.sh --yes` | No prompts — for when you already know |
| `./deploy/deploy.sh --skip-migrations` | Code only, leaves the schema alone |

### Why it asks before migrating

Code can be redeployed. A migration that runs against live data cannot simply
be undone. `migrate.sh` takes a safety backup before touching anything, but
the pause is there so you see what is about to change while there is still a
choice. Everything else is automatic; that one step is deliberate.

If you genuinely want it unattended, `--yes` does that. Just be somewhere you
can react.

---

## When something goes wrong

**`cannot reach admin@100...`** — Check `spcl-nas` still shows as connected in
the Tailscale admin console. If it has expired, that is the key-expiry setting
from step 3, and it needs one more UltraViewer session to fix. Disable expiry
while you are in there.

**`could not read Username for 'https://github.com'`** — The NAS has no working
credentials for the private repo. Either `/Volume1/SPCL/secrets/git-credentials`
is missing or unreadable, `SPCL_GIT_CREDENTIALS` in `deploy.conf` points
somewhere else, or the token expired or was revoked. Write a new token into the
same file (step 4a–4b); nothing else changes.

**`the NAS has neither git nor docker`** — If you can see docker working when
you SSH in by hand, this is a PATH problem, not a missing docker: TOS only adds
docker to PATH for interactive logins, and `deploy.sh` runs non-interactively.
Find the real path with `ssh -p 9222 SPCNAS@100.98.108.77 'bash -lc "command -v
docker"'` and set `SPCL_DOCKER` in `deploy.conf` to it.

**`git pull failed on the NAS`** — Someone edited files directly on the NAS and
the pull refuses to overwrite them. SSH in and run `git status` to see what.

**The build fails** — The old containers are usually still running, so staff
are probably unaffected. Check with:

```bash
ssh admin@100.x.y.z 'cd /Volume1/SPCL/deployment && docker logs spcl-api --tail 50'
```

**A migration fails** — It rolled back, and a safety backup was taken before
anything ran. The database is as it was. Fix the migration and deploy again.

**The API never reports healthy** — The deploy exits non-zero and tells you
which log to read. Most often it is a migration that has not been applied yet,
so the new code is asking for a column that does not exist.

---

## Browsing the database from your laptop

You can point TablePlus or DBeaver at production and browse it like a
spreadsheet. It is a **live connection**, not a copy — every query runs
against the database in Jamaica, and what you see is what staff are looking
at that second. Nothing is downloaded or imported, and there is nothing to
refresh or re-import after a deploy.

PostgreSQL is published on the NAS's loopback address only
(`127.0.0.1:5432`), so it is reachable by something already logged into the
NAS and by nothing else. No office machine can connect to it, and neither can
the internet. Your client gets there by tunnelling over the same SSH
connection the deploy uses.

### One-time: give the read-only role a password

Migration `033_add_readonly_role.sql` creates `spcl_readonly`, which can
`SELECT` and nothing else. It has no password — a password in a migration
file would be a password in git — so grant it one on the NAS:

```bash
docker exec -it spcl-postgres psql -U spcl_user -d spcl_db \
  -c "ALTER ROLE spcl_readonly WITH LOGIN PASSWORD 'pick-something-long';"
```

Use the real `POSTGRES_USER` and `POSTGRES_DB` from `.env.production` if they
differ. To cut access off later, `ALTER ROLE spcl_readonly WITH NOLOGIN;` —
the grants stay intact for when you want it back.

### In TablePlus

Create a PostgreSQL connection and turn **Over SSH** on:

| | |
|---|---|
| SSH host | `100.98.108.77` |
| SSH port | `9222` |
| SSH user | `SPCNAS` |
| SSH password | the NAS password |
| Database host | `127.0.0.1` |
| Database port | `5432` |
| User | `spcl_readonly` |
| Password | the one you just set |
| Database | `spcl_db` |

The database host is `127.0.0.1` **as seen from the NAS**, which is why the
loopback binding is enough. If you prefer a manual tunnel, the equivalent is
`ssh -p 9222 -L 55432:127.0.0.1:5432 SPCNAS@100.98.108.77` and then
connecting to `localhost:55432`.

### Why read-only

Grid views make editing a cell feel like editing a spreadsheet, and an
`UPDATE` against live customer data has no undo. As `spcl_readonly`, a stray
edit fails with a permissions error instead of rewriting a row. When you
genuinely need to write, use `psql` deliberately:

```bash
docker exec -it spcl-backup psql
```

Schema changes never belong here in any case — those are migration files, so
that every database ends up with the same shape.

---

## What this does not do

- **It does not fire on every push.** Deploying is one command you type. That
  is deliberate — see above.
- **It does not touch `.env.production`.** That file holds the database
  password and session secret and lives only on the NAS, never in git.
- **It does not roll back.** If a deploy goes badly, you fix forward or you
  restore from a backup. For a system this size that is the right trade;
  automatic rollback is a lot of machinery for a rare event.
