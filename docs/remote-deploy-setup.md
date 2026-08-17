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

```bash
docker run -d \
  --name tailscale \
  --hostname spcl-nas \
  --restart unless-stopped \
  --network host \
  --cap-add NET_ADMIN \
  --cap-add NET_RAW \
  -v /Volume1/SPCL/tailscale-state:/var/lib/tailscale \
  -e TS_AUTHKEY=tskey-auth-PASTE-YOURS-HERE \
  -e TS_STATE_DIR=/var/lib/tailscale \
  -e TS_HOSTNAME=spcl-nas \
  tailscale/tailscale:latest
```

Adjust `/Volume1/SPCL/tailscale-state` to match your real path. That volume is
what lets the NAS stay logged in across reboots — without it, a power cut
means re-authenticating, which means another UltraViewer session.

Check it connected:

```bash
docker logs tailscale --tail 20
```

Then look at your Tailscale admin console in a browser. `spcl-nas` should
appear in the machine list with an address starting `100.`.

**Write that address down.** That is how you reach the NAS from now on.

While you are in the admin console, open the `spcl-nas` machine and **disable
key expiry**. Otherwise it drops off the network in a few months and you need
UltraViewer again to fix it. This is the single most common way this setup
breaks months later.

---

## 4. Make sure the NAS can pull from GitHub

Still on the NAS, in the deployment directory:

```bash
cd /Volume1/SPCL/deployment
git remote -v
git pull
```

If `git` is not installed, you can install it through TOS's App Center, or
fall back to copying files over SMB — but then `deploy.sh` cannot do its job,
so it is worth getting git working.

If the repository is private, GitHub will ask for credentials. Use a personal
access token rather than your password: GitHub → **Settings → Developer
settings → Personal access tokens**, scope `repo`, read-only is enough. Then:

```bash
git config --global credential.helper store
git pull      # paste the token when asked for a password, once
```

---

## 5. Test it from your own laptop

Close UltraViewer. From Toronto:

```bash
ssh admin@100.x.y.z          # the Tailscale address
```

If that lands you on the NAS, you are done with the hard part — permanently.

---

## 6. Set up the deploy command

Back in the project on your laptop:

```bash
cp deploy/deploy.conf.template deploy/deploy.conf
```

Edit `deploy/deploy.conf` and set:

```
SPCL_SSH=admin@100.x.y.z
SPCL_REMOTE_DIR=/Volume1/SPCL/deployment
```

Use the **Tailscale** address, not the 192.168 one. Tailscale works both on
the office network and off it, so there is nothing to switch between.

Optional but worth the two minutes — set up an SSH key so you are not typing
the NAS password on every deploy:

```bash
ssh-keygen -t ed25519            # if you do not already have one
ssh-copy-id admin@100.x.y.z
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
3. Rebuild and restart the containers
4. Wait for PostgreSQL
5. Show any pending migrations and **ask before applying them**
6. Confirm the API came back healthy
7. Check that your backups are still in good shape

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

## What this does not do

- **It does not fire on every push.** Deploying is one command you type. That
  is deliberate — see above.
- **It does not touch `.env.production`.** That file holds the database
  password and session secret and lives only on the NAS, never in git.
- **It does not roll back.** If a deploy goes badly, you fix forward or you
  restore from a backup. For a system this size that is the right trade;
  automatic rollback is a lot of machinery for a rare event.
