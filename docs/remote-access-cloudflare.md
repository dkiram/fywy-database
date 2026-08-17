# SPCL — remote access for the branch offices

Newport, Mandeville, May Pen and Hanover reach the system through a Cloudflare
tunnel. The home office keeps using the LAN address either way.

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

## 6. Turn on secure cookies

The app is now behind HTTPS, so the session cookie should refuse to travel over
plain HTTP:

```bash
cd /Volume1/SPCL/deployment
nano .env.production          # set SESSION_COOKIE_SECURE=true
docker-compose -f docker-compose.prod.yml --env-file .env.production \
  --profile remote up -d
```

**This is a trade-off, so decide deliberately.** With `true`, logging in over
the LAN address `http://192.168.1.8:8090` stops working, because browsers
discard secure cookies sent over plain HTTP. Everyone, including the home
office, would use the HTTPS address instead.

That is the correct end state. Just do not flip it and then wonder why the home
office can suddenly no longer log in — the symptom is a login that appears to
succeed and immediately bounces back to the login page.

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
install on their machine.

**Removing someone:** remove their email from the Access policy, and disable
their SPCL employee account. Do both — the first stops them reaching the app,
the second stops the account being useful if they ever get back in.

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
