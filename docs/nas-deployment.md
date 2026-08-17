# SPCL — NAS deployment guide

Target: TerraMaster NAS (TOS 6, RAID 1, Docker Engine + Docker Manager), LAN
address `192.168.1.8`. Staff computers are Windows, roughly 15 of them, across
the home office, Newport, Mandeville, May Pen and Hanover.

This guide covers **Phase 1 only: getting the system running on the NAS over the
local network.** Remote offices (Tailscale) and the Electron installer come
after Phase 1 is proven working.

---

## How the pieces fit

```
Staff computer  ──HTTP──▶  spcl-api  ──▶  spcl-postgres
                            (port 8090)      (private, not published)
                                              │
                                       spcl-backup ──▶ /SPCL/database-backups
                                                              │
                                                     USB Copy ──▶ external drive
```

Three containers. The API serves both `/api` and the React frontend, so there is
one address, no CORS, and session cookies behave identically everywhere —
browser, Electron, and later over HTTPS.

PostgreSQL has **no published port**. Only the API container can reach it. This
is deliberate: an exposed 5432 is how NAS databases get ransomwared.

---

## 1. Find the real folder path

The `SPCL` shared folder exists in TOS, but Docker needs its filesystem path.

In TOS, open **File Manager**, right-click the `SPCL` folder → **Properties**,
and read the location. It will look something like `/mnt/md0/SPCL` or
`/Volume1/SPCL`.

Write that path down — it goes into `SPCL_DATA_ROOT` in the next step.

Confirm these subfolders exist inside it:

```
app
postgres-data
database-backups
deployment
```

---

## 2. Create the production environment file

Copy `deploy/env-production.template` to `.env.production` in the project root
and fill it in:

```bash
cp deploy/env-production.template .env.production
```

Generate real secrets — do not invent them by hand:

```bash
openssl rand -base64 32   # POSTGRES_PASSWORD
openssl rand -hex 48      # SESSION_SECRET
```

Set `SPCL_DATA_ROOT` to the path from step 1.

Leave `SESSION_COOKIE_SECURE=false` for now. Phase 1 runs over plain HTTP on the
LAN, and a browser silently discards a `Secure` cookie sent over HTTP — the
symptom is a login that appears to succeed and then bounces straight back to the
login page. It flips to `true` when Tailscale HTTPS goes in front.

`.env.production` must never be committed. The `.gitignore` already blocks it.

---

## 3. Copy the project to the NAS

Put the repository in `/SPCL/deployment` on the NAS. Either:

- copy it over SMB from File Manager, or
- `git clone` it if the NAS has git available.

`.env.production` should be created **on the NAS**, not copied from a laptop.

---

## 4. Build and start the stack

Docker Manager's Compose UI can import `docker-compose.prod.yml`, but it does
not reliably build images from source. The dependable route is SSH.

Enable SSH in TOS (**Control Panel → Terminal & SNMP**), then from a computer on
the LAN:

```bash
ssh admin@192.168.1.8
cd /mnt/md0/SPCL/deployment          # your real path

docker compose -f docker-compose.prod.yml \
  --env-file .env.production \
  up -d --build
```

The first build takes several minutes — it compiles the frontend, the API, and
the native `bcrypt` module.

**Turn SSH back off when finished.** It is only needed for deployment.

If the image is built on an Apple Silicon Mac instead of on the NAS, it must be
built for the NAS's CPU or it will not start:

```bash
docker buildx build --platform linux/amd64 -t spcl-app:latest .
```

Building on the NAS avoids this entirely.

---

## 5. Check it is alive

```bash
docker compose -f docker-compose.prod.yml ps
docker logs spcl-api
docker logs spcl-backup
```

All three containers should show as running, and `spcl-postgres` as healthy.

Then from any computer on the LAN:

```
http://192.168.1.8:8090/health
```

Expected response:

```json
{ "status": "ok", "database": "connected", "databaseTime": "..." }
```

If that works, open `http://192.168.1.8:8090/` — the SPCL login page should
load.

---

## 6. Move the data across

Do **not** point the new stack at the existing database. Move a copy.

From the machine currently running PostgreSQL:

```bash
pg_dump --format=custom --file=spcl-migration.dump \
  --host=localhost --username=spcl_user spcl_db
```

Copy that file to the NAS, then:

```bash
docker cp spcl-migration.dump spcl-postgres:/tmp/
docker exec -it spcl-postgres pg_restore \
  --username=spcl_user --dbname=spcl_db --no-owner --no-privileges \
  /tmp/spcl-migration.dump
docker exec -it spcl-postgres rm /tmp/spcl-migration.dump
```

Then compare row counts between old and new for customers, payments, employees,
applications, service tickets, audit logs and account operations. They must
match exactly before anyone uses the new system.

Keep the old database untouched. It is the rollback.

---

## 7. Backups

`spcl-backup` takes the first dump as soon as it starts, then runs nightly at
02:00 Jamaica time. Output lands in `/SPCL/database-backups`:

```
daily/     spcl-YYYY-MM-DD-HHMMSS.dump  (+ .sha256)
monthly/   one dump promoted on the 1st
globals/   roles and permissions, weekly
backup.log
```

Retention: 30 daily, 12 monthly.

**Verify a restore before trusting any of it:**

```bash
docker exec -it spcl-backup sh /opt/spcl-deploy/restore-verify.sh
```

That checks the file's checksum, restores it into a scratch database, prints row
counts, and drops the scratch database. The live database is never touched. Run
it after the first deployment and roughly monthly after that.

RAID 1 is not a backup — a deletion is copied to both drives instantly. The
nightly dumps are the actual protection.

### External drive

In TOS, **USB Copy** handles the offsite copy:

```
Source:      /SPCL/database-backups
Destination: the external drive
Direction:   NAS → USB
Mode:        Multi-Version
```

Enable automatic backup on insertion and safe ejection afterwards. Plug the
drive in at least weekly, let it run, unplug it, and store it away from the NAS.
Two drives rotated between locations is meaningfully better than one drive
sitting beside the NAS, which does not survive theft, fire, or a bad surge.

---

## 8. Day-to-day commands

```bash
# Restart everything
docker compose -f docker-compose.prod.yml --env-file .env.production restart

# Rebuild after a code change
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build

# Watch the API
docker logs -f spcl-api

# Take a backup right now
docker exec -it spcl-backup sh /opt/spcl-deploy/backup.sh
```

All three containers use `restart: unless-stopped`, so they come back on their
own after a NAS reboot or power cut.

---

## What comes next (not in this phase)

1. **Remote access for the branch offices** via Cloudflare Tunnel — see
   `docs/remote-access-cloudflare.md`. This also gives HTTPS, at which point
   `SESSION_COOKIE_SECURE` flips to `true`.
2. **The Electron Windows installer**, so staff get a real desktop application
   instead of a browser tab.
3. **External drive backup** via TOS USB Copy, pulling from
   `/Volume1/SPCL/database-backups`.
4. **Final Access import and cutover.**

Phase 1 has to be working and backed up before any of those start.
