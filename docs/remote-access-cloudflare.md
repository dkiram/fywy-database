# SPCL — remote access for people working offsite

**This is not how the offices connect.** Blenheim, Newport, Mandeville and
Kingston are all on the same network as the NAS and reach it directly at its
`192.168.x` address — confirmed by testing from Mandeville in August 2026. If
the tunnel went down tomorrow, every office would carry on working.

The tunnel is for people who are genuinely elsewhere: Toronto, someone's home,
a phone on mobile data. That is a short named list, not the staff body, and
the Access policy should stay that short.

(An earlier version of this document said the branch offices depended on the
tunnel. They never did.)

Nothing is installed on staff computers. Nothing is exposed on the router. The
NAS makes an outbound connection to Cloudflare and everything travels back down
that connection.

```
Staff browser, any office
        │  https://spcl.yourdomain.com
        ▼
  Cloudflare Access          ← is this email on the approved list?
        │
        │  private outbound tunnel
        ▼
  spcl-cloudflared  ──▶  spcl-api  ──▶  spcl-postgres
        (on the NAS)
```

Two doors: Cloudflare Access proves the person is staff, then SPCL's own login
proves who they are and what role they have.

---

## Before you start

- The company domain is already on Cloudflare — no nameserver changes needed,
  and the Google Workspace email records are untouched. You are only adding one
  subdomain record.
- Decide the subdomain. `spcl.yourdomain.com` is fine. Nobody outside the
  company ever sees it.
- Have the list of staff email addresses that should be allowed in.

---

## 1. Create the tunnel

In the Cloudflare dashboard:

1. **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel**
2. Choose **Cloudflared** as the connector type
3. Name it `spcl-nas`
4. On the install screen, pick **Docker**. Cloudflare shows a command containing
   a long token — you only need the token itself, not the whole command.
5. Copy that token.

---

## 2. Put the token on the NAS

SSH into the NAS and add it to the environment file:

```bash
cd /Volume1/SPCL/deployment
nano .env.production
```

Set the line:

```
CLOUDFLARE_TUNNEL_TOKEN=<the long token you copied>
```

Save and exit. The file is already `chmod 600` — the token is a credential and
belongs there, not in the repository.

---

## 3. Start the tunnel

```bash
docker-compose -f docker-compose.prod.yml --env-file .env.production \
  --profile remote up -d
```

The `--profile remote` flag is what starts `cloudflared`. Without it the stack
runs LAN-only, exactly as it does now.

Check it connected:

```bash
docker logs spcl-cloudflared --tail 20
```

You want to see registered connections. The Cloudflare dashboard should show
the tunnel as **Healthy** within about a minute.

---

## 4. Point the subdomain at the app

Back in the tunnel's settings, open **Public Hostnames** → **Add a public
hostname**:

| Field | Value |
|---|---|
| Subdomain | `spcl` |
| Domain | your company domain |
| Path | leave empty |
| Type | `HTTP` |
| URL | `api:3000` |

`api:3000` is the API container's name on the private Docker network. It is not
reachable from anywhere else — only `cloudflared`, sitting on the same network,
can see it.

Cloudflare creates the DNS record and issues the HTTPS certificate
automatically. No other DNS record changes, so email is unaffected.

At this point `https://spcl.yourdomain.com` works — **and so does anyone else
on the internet who guesses it.** The next step fixes that, so do it now rather
than later.

---

## 5. Lock it to your staff

**Zero Trust** → **Access** → **Applications** → **Add an application** →
**Self-hosted**:

1. Name it `SPCL`
2. Application domain: `spcl.yourdomain.com`
3. Session duration: **1 month** — long enough that staff are not logging in
   through Cloudflare every day, short enough to matter
4. Next, then add a policy:

| Field | Value |
|---|---|
| Policy name | `SPCL staff` |
| Action | Allow |
| Include | **Emails** → the staff addresses, one per line |

If everyone is on the company Google Workspace domain, use **Emails ending in**
`@yourcompany.com` instead of listing addresses individually. That way new
staff work automatically and ex-staff lose access the moment their email is
disabled.

Save. Now an unapproved visitor hits a Cloudflare login and stops there — they
never reach the SPCL login page at all.

---

## 6. Secure cookies

The session cookie is the login. Whoever holds a copy of it is signed in as
that employee, without ever needing the password. `SESSION_COOKIE_SECURE`
controls whether browsers are told to keep it off unencrypted connections.

**`auto` is the setting to use, and it is already the default.** Confirm the
line in `.env.production` reads:

```
SESSION_COOKIE_SECURE=auto
```

On `auto` the app decides per request. A branch office arriving over HTTPS
through the tunnel gets a protected cookie. The home office on
`http://192.168.1.8:8090` gets the ordinary one and keeps working. Both at
once, from the same running container, no coordination required.

### Why not just `true`

`true` is the textbook answer and it is wrong for this deployment while the
home office is still on the LAN address. Browsers discard a Secure cookie
arriving over plain HTTP, so those staff are locked out entirely — and the
symptom is confusing rather than obvious: the login appears to succeed and
immediately bounces back to the login form, over and over.

Two things have to be true before `true` is safe:

1. Every office, home office included, reaches the app over the HTTPS
   hostname rather than the LAN address.
2. You have accepted that a Cloudflare outage now takes the home office
   offline too. Today the LAN address is the fallback that keeps the business
   running when the tunnel is down. `true` removes it.

Point 2 is the one that gets forgotten. `auto` costs nothing and keeps the
fallback, so there is no hurry.

### If you do move to `true` later

```bash
cd /Volume1/SPCL/deployment
nano .env.production          # set SESSION_COOKIE_SECURE=true
docker-compose -f docker-compose.prod.yml --env-file .env.production \
  --profile remote up -d
```

Do it when staff are not working, and have someone at the home office confirm
they can still log in before you walk away.

### If `auto` does not seem to protect anything

`auto` reads the connection protocol from the `X-Forwarded-Proto` header that
`cloudflared` adds, and Express only trusts that header when `trust proxy` is
set — which the app does automatically when `NODE_ENV=production`. If the
container is somehow not running in production mode, `auto` silently behaves
like `false` rather than erroring. The API logs its decision on startup:

```bash
docker logs spcl-api | grep "Session cookie"
```

---

## 7. Test properly

1. Open `https://spcl.yourdomain.com` from a computer that has never touched
   this system. You should get the Cloudflare login, then the SPCL login.
2. Try from an email address that is **not** on the policy. You should be
   refused by Cloudflare before ever seeing SPCL.
3. Log in as a branch user and confirm role permissions still behave.
4. Record a payment and print a receipt from a remote office.

---

## Running it

**Adding a staff member:** add their email to the Access policy. Nothing to
install on their machine. They type their own address, receive a six-digit
code at it, and are through the outer door; the SPCL login still decides who
they actually are.

**Removing someone:** remove their email from the Access policy, and disable
their SPCL employee account. Do both — the first stops them reaching the app,
the second stops the account being useful if they ever get back in.

### Why individual emails rather than one shared account

A single shared mailbox for everyone offsite looks tidier and is the more
expensive option in practice. Removing one person means changing the shared
password and redistributing it to everyone else, which nobody does, so the
account slowly accumulates former staff. Individual addresses make removal one
deleted line that affects nobody else.

It is also no harder for the person logging in — arguably easier. With their
own address they type it and read a code. With a shared account they need that
account's password *and* have to open someone else's inbox.

### Checking the door is actually shut

The failure that matters here is silent: a policy with the action set to
**Bypass** rather than **Allow**, or an application domain that does not quite
match the hostname, lets everybody through while working perfectly for you.

Twice a year, and after any change to the policy, open the hostname in a
private window and enter an email that is not on the list. Cloudflare should
refuse you *before* the SPCL login page appears. Reaching the SPCL login means
the app is on the open internet.

**If remote access breaks but the home office is fine:** the tunnel is down, not
the app.

```bash
docker logs spcl-cloudflared --tail 50
docker restart spcl-cloudflared
```

**If everything is down:** it is the stack, not the tunnel.

```bash
docker-compose -f docker-compose.prod.yml --env-file .env.production ps
docker logs spcl-api --tail 50
```

---

## Worth knowing

- Cloudflare terminates the HTTPS connection, so their infrastructure can
  technically see traffic passing through. This is the same trust model as a
  large share of the internet, but it is your father's customers' data and he
  should know it rather than discover it.
- A Cloudflare outage takes remote offices offline. The home office keeps
  working on the LAN address, so the business is not fully stopped.
- The Access list is not self-maintaining. Someone has to remove people when
  they leave. Using **Emails ending in** your Workspace domain makes this mostly
  automatic.
