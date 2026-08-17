#!/usr/bin/env bash
#
# Deploys SPCL to the NAS from wherever you happen to be.
#
#   ./deploy/deploy.sh              push, migrate, rebuild, restart, verify
#   ./deploy/deploy.sh --check      say what would happen, change nothing
#   ./deploy/deploy.sh --yes        no confirmation prompts (for automation)
#   ./deploy/deploy.sh --skip-migrations
#
# This runs on YOUR computer. It does not need to be run at the NAS, and it
# does not need anyone in Jamaica. It opens one SSH connection, does all the
# remote work over it, and tells you whether the app came back up.
#
# Settings live in deploy/deploy.conf, which is not committed. Copy
# deploy/deploy.conf.template to get started.
#
# The order is deliberate twice over. Code is pushed to GitHub first and the
# NAS pulls from there, so what runs in production is always a commit that
# exists somewhere other than one laptop. And migrations are applied before
# the containers restart, so the new code never starts against a schema that
# has not caught up with it yet.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MODE="deploy"
ASSUME_YES="false"
SKIP_MIGRATIONS="false"

for arg in "$@"; do
  case "$arg" in
    --check)            MODE="check" ;;
    --yes|-y)           ASSUME_YES="true" ;;
    --skip-migrations)  SKIP_MIGRATIONS="true" ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Use --check, --yes, --skip-migrations, or no option to deploy." >&2
      exit 2
      ;;
  esac
done

# --- output ------------------------------------------------------------------

if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"
  DIM="$(printf '\033[2m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; RESET=""
fi

step()  { printf "\n%s==>%s %s%s%s\n" "$BOLD" "$RESET" "$BOLD" "$*" "$RESET"; }
info()  { printf "    %s\n" "$*"; }
muted() { printf "    %s%s%s\n" "$DIM" "$*" "$RESET"; }
warn()  { printf "    %s!%s  %s\n" "$YELLOW" "$RESET" "$*"; }
ok()    { printf "    %s+%s  %s\n" "$GREEN" "$RESET" "$*"; }

fail() {
  printf "\n%sDeploy stopped:%s %s\n\n" "$RED" "$RESET" "$*" >&2
  exit 1
}

confirm() {
  [ "$ASSUME_YES" = "true" ] && return 0
  [ -t 0 ] || fail "needs a yes/no answer but nothing is attached to the terminal. Re-run with --yes if you meant to run this unattended."

  printf "    %s [y/N] " "$1"
  read -r reply
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# --- settings ----------------------------------------------------------------

CONFIG_FILE="${SPCL_DEPLOY_CONFIG:-$SCRIPT_DIR/deploy.conf}"

if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

SPCL_SSH="${SPCL_SSH:-}"

# TerraMaster's TOS runs SSH on 9222 by default, not 22.
SPCL_SSH_PORT="${SPCL_SSH_PORT:-9222}"

SPCL_REMOTE_DIR="${SPCL_REMOTE_DIR:-}"
SPCL_BRANCH="${SPCL_BRANCH:-main}"
SPCL_COMPOSE_FILE="${SPCL_COMPOSE_FILE:-docker-compose.prod.yml}"
SPCL_ENV_FILE="${SPCL_ENV_FILE:-.env.production}"
SPCL_COMPOSE_PROFILES="${SPCL_COMPOSE_PROFILES:-}"

# Absolute path to docker on the NAS. Leave empty to detect automatically.
SPCL_DOCKER="${SPCL_DOCKER:-}"

# How to run compose on the NAS. Leave empty to detect automatically: the
# v2 plugin first, then a standalone docker-compose binary.
SPCL_COMPOSE="${SPCL_COMPOSE:-}"

# Set to true to run compose itself in a container when the NAS has neither.
SPCL_COMPOSE_IN_DOCKER="${SPCL_COMPOSE_IN_DOCKER:-}"

# Path ON THE NAS to a git credentials file, so the NAS can read the private
# repo from GitHub. One line, mode 600:
#
#   https://<user>:<token>@github.com
#
# Put it in a directory of its own - that whole directory is mounted into
# the git container. Leave empty only if the repository is public.
# See deploy.conf.template.
SPCL_GIT_CREDENTIALS="${SPCL_GIT_CREDENTIALS:-}"

# How long to wait for things to come up, in seconds. Raise these if the NAS
# is slow or the database has grown large enough that startup recovery takes
# a while.
SPCL_DB_WAIT_SECONDS="${SPCL_DB_WAIT_SECONDS:-60}"
SPCL_HEALTH_WAIT_SECONDS="${SPCL_HEALTH_WAIT_SECONDS:-60}"

if [ -z "$SPCL_SSH" ] || [ -z "$SPCL_REMOTE_DIR" ]; then
  fail "SPCL_SSH and SPCL_REMOTE_DIR are not set.
       Copy deploy/deploy.conf.template to deploy/deploy.conf and fill it in.
       Looked in: $CONFIG_FILE"
fi

# --- one SSH connection, reused ----------------------------------------------
#
# Without this, every remote command would prompt for the NAS password
# separately. ControlMaster opens the connection once and the rest ride along.

# The socket path must stay under about 104 characters or ssh dies with
# "unix_listener: path too long". macOS's TMPDIR is a ~50-character
# /var/folders/... path on its own, so anchor at /tmp and use %C - ssh's
# short hash of the connection - instead of spelling out user@host:port.
SSH_CONTROL_DIR="/tmp/spcl-deploy-$$"
mkdir -p "$SSH_CONTROL_DIR"
chmod 700 "$SSH_CONTROL_DIR"

SSH_CONTROL_PATH="$SSH_CONTROL_DIR/%C"

SSH_OPTS=(
  -p "$SPCL_SSH_PORT"
  -o ControlMaster=auto
  -o "ControlPath=$SSH_CONTROL_PATH"
  -o ControlPersist=60
  -o ConnectTimeout=10
)

# %C expands to 40 hex characters. Fail loudly rather than leaving someone
# to decode "unix_listener: path too long" for themselves.
CONTROL_PATH_LENGTH=$(( ${#SSH_CONTROL_DIR} + 1 + 40 ))

if [ "$CONTROL_PATH_LENGTH" -gt 100 ]; then
  fail "the SSH control socket path would be $CONTROL_PATH_LENGTH characters,
       which is over the limit for a Unix socket."
fi

cleanup() {
  ssh "${SSH_OPTS[@]}" -O exit "$SPCL_SSH" 2>/dev/null || true
  rm -rf "$SSH_CONTROL_DIR"
}
trap cleanup EXIT

# Runs a command on the NAS. Output comes straight back.
remote() {
  ssh "${SSH_OPTS[@]}" "$SPCL_SSH" "$@"
}

# Runs a command on the NAS from inside the deployment directory.
remote_in_repo() {
  remote "cd '$SPCL_REMOTE_DIR' && $*"
}

# A non-interactive `ssh host "command"` gets a minimal PATH, and TOS only
# adds docker to PATH for interactive logins. Everything this script runs is
# non-interactive, so resolve docker's absolute path once - through a login
# shell, which does read the profile - and use that everywhere.
REMOTE_DOCKER="docker"

detect_remote_docker() {
  local found=""

  # `|| true` matters: under `set -o pipefail` a grep that matches nothing
  # fails the whole pipeline, and `set -e` would then abort the script with
  # no message at all rather than reaching the clear error below.
  found="$(remote 'bash -lc "command -v docker 2>/dev/null"' 2>/dev/null \
           | tr -d '\r' | grep '^/' | head -1)" || true

  if [ -z "$found" ]; then
    for candidate in \
      /usr/local/bin/docker /opt/bin/docker /usr/bin/docker \
      /usr/sbin/docker /usr/local/sbin/docker
    do
      if remote "test -x $candidate" 2>/dev/null; then
        found="$candidate"
        break
      fi
    done
  fi

  if [ -z "$found" ]; then
    fail "docker was not found on the NAS over a non-interactive session.

       It probably works when you log in by hand, because TOS only adds it
       to PATH for interactive shells. Find it with:

         ssh -p $SPCL_SSH_PORT $SPCL_SSH 'bash -lc \"command -v docker\"'

       then set SPCL_DOCKER to that path in deploy/deploy.conf."
  fi

  REMOTE_DOCKER="$found"
  muted "docker: $REMOTE_DOCKER"
}

# TOS ships without git. Docker is the one thing on this NAS that is
# reliably present, so when there is no git binary we run one in a container
# against the same directory. Detected once and reused, because each probe
# is a round trip over a lossy link.
#
# safe.directory is needed because the checkout is owned by a different uid
# than the one inside the container, which modern git refuses to touch.
#
# The repository is private, so the container also needs credentials. They
# live in a file on the NAS which is mounted into the container, where git's
# "store" helper reads it. The token is never passed on a command line, so it
# does not show up in `ps`, and it never lands in .git/config.
#
# The file's DIRECTORY is what gets mounted, not the file: after a successful
# fetch git rewrites the credential file through a lock file and a rename,
# and renaming onto a bind-mounted file fails. Give it the whole directory
# and the rename stays inside one mount. Keep that directory dedicated to
# secrets - everything in it is visible to the container.
REMOTE_GIT=""

detect_remote_git() {
  local found=""

  # Same PATH trap as docker: a non-interactive ssh session gets a minimal
  # PATH, so ask a login shell. `|| true` keeps set -e from killing us when
  # git genuinely is not there.
  found="$(remote 'bash -lc "command -v git 2>/dev/null"' 2>/dev/null \
           | tr -d '\r' | grep '^/' | head -1)" || true

  if [ -n "$found" ]; then
    REMOTE_GIT="$found"
    muted "using the NAS's own git: $found"
    return
  fi

  # $REMOTE_DOCKER is already an absolute path by this point - do NOT probe
  # with `command -v docker`, which fails over a non-interactive session even
  # when docker is installed and working.
  if [ -z "$REMOTE_DOCKER" ] || ! remote "test -x '$REMOTE_DOCKER'"; then
    fail "the NAS has neither git nor a usable docker at
       '$REMOTE_DOCKER', so there is no way to update the code.
       Install git through the TOS App Center, or set SPCL_DOCKER in
       deploy/deploy.conf to docker's absolute path."
  fi

  local cred_mount="" cred_opt=""

  if [ -n "$SPCL_GIT_CREDENTIALS" ]; then
    case "$SPCL_GIT_CREDENTIALS" in
      /*/?*) ;;
      *) fail "SPCL_GIT_CREDENTIALS must be an absolute path to a file on the
       NAS, inside a directory of its own. Got: '$SPCL_GIT_CREDENTIALS'" ;;
    esac

    local cred_dir="${SPCL_GIT_CREDENTIALS%/*}"
    local cred_file="${SPCL_GIT_CREDENTIALS##*/}"

    remote "test -r '$SPCL_GIT_CREDENTIALS'" \
      || fail "SPCL_GIT_CREDENTIALS points at '$SPCL_GIT_CREDENTIALS',
       which the NAS cannot read. Create it there with:

         mkdir -p '$cred_dir' && chmod 700 '$cred_dir'
         printf 'https://USER:TOKEN@github.com\\n' > '$SPCL_GIT_CREDENTIALS'
         chmod 600 '$SPCL_GIT_CREDENTIALS'

       USER is the GitHub account the token belongs to; TOKEN is a
       fine-grained personal access token with Contents: Read-only on this
       repository and nothing else."

    cred_mount="-v '$cred_dir':/creds"
    cred_opt="-c 'credential.helper=store --file=/creds/$cred_file'"
  fi

  REMOTE_GIT="$REMOTE_DOCKER run --rm -v '$SPCL_REMOTE_DIR':/repo -w /repo -e HOME=/tmp $cred_mount alpine/git -c safe.directory=/repo $cred_opt"
  muted "no git on the NAS - running it in a container instead"

  [ -n "$cred_mount" ] || warn "no SPCL_GIT_CREDENTIALS set - fetching a private repo will fail"
}

# The NAS repository has to be a real checkout before any of this means
# anything. A half-initialised repo (git init with no commits) would
# otherwise die inside a command substitution with no message at all.
check_remote_repo() {
  remote_in_repo "test -d .git" \
    || fail "$SPCL_REMOTE_DIR on the NAS is not a git repository yet.
       See 'First-time setup on the NAS' in docs/remote-deploy-setup.md."

  remote_git "rev-parse --verify HEAD >/dev/null 2>&1" \
    || fail "the git repository in $SPCL_REMOTE_DIR has no commits - it was
       initialised but never fetched, usually because the fetch could not
       authenticate to GitHub.

       See 'First-time setup on the NAS' in docs/remote-deploy-setup.md."
}

# Runs a git subcommand on the NAS, whichever way git is available.
remote_git() {
  remote "cd '$SPCL_REMOTE_DIR' && $REMOTE_GIT $*"
}

# Compose comes in two shapes and this NAS has the older one. Docker Engine
# only gained the `docker compose` subcommand with the Compose v2 plugin;
# before that it was a separate `docker-compose` binary. Asking the wrong one
# gives you "unknown shorthand flag: 'f' in -f", because docker parses global
# flags before it discovers there is no such subcommand.
REMOTE_COMPOSE=""
REMOTE_COMPOSE_KIND=""

detect_remote_compose() {
  if [ -n "$SPCL_COMPOSE" ]; then
    REMOTE_COMPOSE="$SPCL_COMPOSE"
    REMOTE_COMPOSE_KIND="from deploy.conf"
    muted "compose: $REMOTE_COMPOSE ($REMOTE_COMPOSE_KIND)"
    return
  fi

  if remote "$REMOTE_DOCKER compose version >/dev/null 2>&1"; then
    REMOTE_COMPOSE="$REMOTE_DOCKER compose"
    REMOTE_COMPOSE_KIND="v2 plugin"
    muted "compose: docker compose ($REMOTE_COMPOSE_KIND)"
    return
  fi

  local found=""

  # The standalone binary usually sits beside docker itself on TOS.
  for candidate in \
    "${REMOTE_DOCKER%/*}/docker-compose" \
    /usr/local/bin/docker-compose /opt/bin/docker-compose \
    /usr/bin/docker-compose /usr/sbin/docker-compose
  do
    if remote "test -x '$candidate'"; then
      found="$candidate"
      break
    fi
  done

  if [ -z "$found" ]; then
    found="$(remote 'bash -lc "command -v docker-compose 2>/dev/null"' 2>/dev/null \
             | tr -d '\r' | grep '^/' | head -1)" || true
  fi

  if [ -n "$found" ]; then
    REMOTE_COMPOSE="$found"
    REMOTE_COMPOSE_KIND="standalone"
    muted "compose: $found ($REMOTE_COMPOSE_KIND)"

    if [ -n "$SPCL_COMPOSE_PROFILES" ]; then
      warn "profiles need docker-compose 1.28 or newer - if the tunnel container"
      warn "is ignored or errors, that is why"
    fi
    return
  fi

  # Last resort, and the same trick this script already uses for git: run
  # compose itself in a container against the host's docker daemon. The repo
  # is mounted at the SAME absolute path it has on the NAS, because relative
  # bind mounts in the compose file are resolved by the daemon on the host,
  # not inside this container.
  if [ -n "$SPCL_COMPOSE_IN_DOCKER" ] && [ "$SPCL_COMPOSE_IN_DOCKER" != "false" ]; then
    REMOTE_COMPOSE="$REMOTE_DOCKER run --rm -v /var/run/docker.sock:/var/run/docker.sock -v '$SPCL_REMOTE_DIR':'$SPCL_REMOTE_DIR' -w '$SPCL_REMOTE_DIR' docker/compose:1.29.2"
    REMOTE_COMPOSE_KIND="containerised"
    muted "compose: none on the NAS - running it in a container instead"
    return
  fi

  fail "the NAS has docker but no compose.

       'docker compose version' fails and there is no docker-compose binary,
       which means Docker Engine here predates the Compose v2 plugin.

       Find out what you have:

         ssh -p $SPCL_SSH_PORT $SPCL_SSH 'bash -lc \"command -v docker-compose; ls ${REMOTE_DOCKER%/*}\"'

       Then either set SPCL_COMPOSE in deploy/deploy.conf to that path, or
       set SPCL_COMPOSE_IN_DOCKER=true to run compose in a container."
}

compose_cmd() {
  local profiles=""
  [ -n "$SPCL_COMPOSE_PROFILES" ] && profiles="--profile $SPCL_COMPOSE_PROFILES"
  echo "$REMOTE_COMPOSE -f '$SPCL_COMPOSE_FILE' --env-file '$SPCL_ENV_FILE' $profiles"
}

# --- 1. local repository -----------------------------------------------------

step "Checking your local repository"

cd "$REPO_ROOT"

command -v git >/dev/null 2>&1 || fail "git is not installed on this computer."

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [ "$CURRENT_BRANCH" != "$SPCL_BRANCH" ]; then
  warn "you are on '$CURRENT_BRANCH' but deploying '$SPCL_BRANCH'"
  confirm "Continue anyway?" || fail "nothing was changed."
fi

if [ -n "$(git status --porcelain)" ]; then
  warn "you have uncommitted changes:"
  git status --short | sed 's/^/        /'
  info ""
  info "Uncommitted work will NOT be deployed - the NAS pulls from GitHub."
  confirm "Deploy the last commit anyway?" || fail "commit your changes first, then re-run."
fi

LOCAL_HEAD="$(git rev-parse HEAD)"
muted "local HEAD  $(git log -1 --format='%h  %s' HEAD)"

# --- 2. push -----------------------------------------------------------------

step "Pushing to GitHub"

if [ "$MODE" = "check" ]; then
  muted "would run: git push origin $SPCL_BRANCH"
else
  if git push origin "$SPCL_BRANCH" 2>&1 | sed 's/^/    /'; then
    ok "pushed"
  else
    fail "the push failed, so the NAS would have pulled stale code."
  fi
fi

# --- 3. reach the NAS --------------------------------------------------------

step "Connecting to the NAS"

# The link to the NAS runs over Tailscale to Jamaica and drops packets from
# time to time, so a single failed attempt means very little. Retry before
# concluding anything, and keep whatever ssh actually said - a generic
# "cannot reach" sends you debugging the wrong layer.
CONNECTED="false"
CONNECT_ERROR=""

for attempt in 1 2 3; do
  if CONNECT_ERROR="$(remote true 2>&1)"; then
    CONNECTED="true"
    break
  fi

  if [ "$attempt" -lt 3 ]; then
    muted "attempt $attempt did not get through, retrying..."
    sleep 3
  fi
done

if [ "$CONNECTED" != "true" ]; then
  fail "cannot reach $SPCL_SSH after 3 attempts on port $SPCL_SSH_PORT.

       ssh said: ${CONNECT_ERROR:-(nothing)}

       'Operation timed out' with tailscale ping still working means the
       NAS firewall rule was lost, usually after a reboot. See the
       'After a reboot' section of docs/remote-deploy-setup.md.

       'Permission denied' means the password or username is wrong. The
       user is SPCNAS, not admin or root.

       'Connection refused' means sshd is not on port $SPCL_SSH_PORT."
fi

ok "connected to $SPCL_SSH"

if [ -n "$SPCL_DOCKER" ]; then
  REMOTE_DOCKER="$SPCL_DOCKER"
  muted "docker: $REMOTE_DOCKER (from deploy.conf)"
else
  detect_remote_docker
fi

detect_remote_git
detect_remote_compose

remote_in_repo "test -f '$SPCL_COMPOSE_FILE'" \
  || fail "no $SPCL_COMPOSE_FILE in $SPCL_REMOTE_DIR on the NAS.
       Is SPCL_REMOTE_DIR right?"

remote_in_repo "test -f '$SPCL_ENV_FILE'" \
  || fail "no $SPCL_ENV_FILE in $SPCL_REMOTE_DIR on the NAS.
       That file holds the database password and session secret and is
       created on the NAS, never copied from a laptop."

check_remote_repo

# --- 4. what is about to change ----------------------------------------------

step "Fetching on the NAS"

# A failed fetch used to be swallowed here, which meant a deploy could look
# like it worked while the NAS quietly stayed on old code. The most common
# cause is authentication: "could not read Username for 'https://github.com'"
# means the credentials file is missing, unreadable or holds a dead token.
FETCH_OUTPUT="$(remote_git "fetch origin '$SPCL_BRANCH' 2>&1" || echo "__SPCL_FETCH_FAILED__")"
echo "$FETCH_OUTPUT" | sed 's/^/    /'

if echo "$FETCH_OUTPUT" | grep -q '__SPCL_FETCH_FAILED__\|could not read Username\|Authentication failed'; then
  fail "the NAS could not fetch from GitHub.

       'could not read Username' means it has no credentials for the private
       repository. Check that SPCL_GIT_CREDENTIALS in deploy/deploy.conf
       points at a readable file on the NAS containing one line:

         https://<user>:<token>@github.com

       and that the token has not expired or been revoked."
fi

REMOTE_HEAD="$(remote_git "rev-parse HEAD" | tr -d '\r\n')"

if [ "$REMOTE_HEAD" = "$LOCAL_HEAD" ]; then
  muted "the NAS is already on this commit"
else
  info "incoming commits:"
  remote_git "log --oneline HEAD..origin/'$SPCL_BRANCH' 2>/dev/null" | head -20 \
    | sed 's/^/        /' || true
fi

if [ "$MODE" = "check" ]; then
  step "Check mode - stopping here"
  muted "nothing on the NAS was changed"
  exit 0
fi

# --- 5. pull -----------------------------------------------------------------

step "Pulling on the NAS"

remote_git "pull --ff-only origin '$SPCL_BRANCH' 2>&1" | sed 's/^/    /' \
  || fail "git pull failed on the NAS. If someone edited files there directly,
       the pull will refuse rather than overwrite them."

ok "the NAS has the new code on disk"

# --- migrations and the restart, in that order -------------------------------
#
# Migrations run BEFORE the containers are rebuilt, so the schema is already
# in place by the time the new code starts. The alternative - restart first,
# migrate second - leaves the new code running against the old schema for as
# long as the migration takes, throwing errors at whoever is mid-form.
#
# This depends on migrations being additive. Old code ignores a column it has
# never heard of, so it keeps working between the migration and the restart.
# A migration that DROPS something the running code still uses breaks the
# same window from the other end: add and backfill in one deploy, drop in a
# later one, once nothing references it.
#
# It also fails better. If a migration fails here, nothing has been rebuilt,
# and the app carries on serving the old code against the old schema.
#
# The exception is a cold start: on a NAS where the stack has never run there
# is no database to migrate yet, so migrations wait until after it comes up.

wait_for_database() {
  local ready="false"
  local attempts=$(( SPCL_DB_WAIT_SECONDS / 2 ))
  [ "$attempts" -lt 1 ] && attempts=1

  for _ in $(seq 1 "$attempts"); do
    if remote "$REMOTE_DOCKER exec spcl-postgres pg_isready -q" 2>/dev/null; then
      ready="true"
      break
    fi
    sleep 2
  done

  [ "$ready" = "true" ] || fail "PostgreSQL did not become ready within ${SPCL_DB_WAIT_SECONDS} seconds.
       Check with: ssh $SPCL_SSH 'docker logs spcl-postgres --tail 50'"

  ok "database is accepting connections"
}

run_migrations() {
  if [ "$SKIP_MIGRATIONS" = "true" ]; then
    step "Skipping migrations (--skip-migrations)"
    return 0
  fi

  step "Checking for pending migrations"

  local pending_output
  pending_output="$(remote "$REMOTE_DOCKER exec spcl-backup sh /opt/spcl-deploy/migrate.sh --dry-run 2>&1" || true)"
  echo "$pending_output" | sed 's/^/    /'

  if echo "$pending_output" | grep -q "nothing to apply"; then
    ok "schema is already up to date"

  elif echo "$pending_output" | grep -q "would apply"; then
    info ""
    warn "the above migrations will change the live database"
    muted "a safety backup is taken automatically before any of it runs"
    muted "the app is still serving the previous version while you decide"

    if confirm "Apply them now?"; then
      remote "$REMOTE_DOCKER exec spcl-backup sh /opt/spcl-deploy/migrate.sh 2>&1" | sed 's/^/    /' \
        || fail "a migration failed. The database was rolled back to before that
       migration started, and a safety backup was taken before anything ran.
       Nothing has been rebuilt, so the app is still serving the old code."
      ok "migrations applied"
    else
      warn "migrations skipped - the new code may expect columns that do not exist yet"
    fi

  else
    warn "could not read the migration status - check the output above"
    confirm "Continue without migrating?" || fail "nothing further was changed."
  fi
}

# Is there a database to migrate against yet?
STACK_WAS_RUNNING="false"

if remote "$REMOTE_DOCKER inspect -f '{{.State.Running}}' spcl-postgres 2>/dev/null" \
   | tr -d '\r' | grep -q '^true$'
then
  STACK_WAS_RUNNING="true"
fi

if [ "$STACK_WAS_RUNNING" = "true" ]; then
  wait_for_database
  run_migrations
else
  step "First start on this NAS"
  muted "no database running yet - migrations will run once it is up"
fi

# --- 6. build and restart ----------------------------------------------------

step "Rebuilding and restarting"

info "building - this takes a few minutes on first run"

remote_in_repo "$(compose_cmd) up -d --build 2>&1" | sed 's/^/    /' \
  || fail "the build or start failed. The previous containers are usually still
       running, so staff are probably unaffected.

       'unknown shorthand flag' or 'no such option: --env-file' means the
       compose on the NAS is too old for the flags used here, not that the
       build itself is broken.

       Check with: ssh $SPCL_SSH 'cd $SPCL_REMOTE_DIR && $(compose_cmd) ps'"

ok "containers are up"

# --- 7. wait for the database ------------------------------------------------

step "Waiting for PostgreSQL"

wait_for_database

# On a cold start the migrations could not run earlier - there was nothing to
# run them against. Everywhere else this is a no-op.
if [ "$STACK_WAS_RUNNING" != "true" ]; then
  run_migrations
fi

# --- 8. did it actually come back up -----------------------------------------

step "Verifying the app"

HEALTH=""
HEALTH_ATTEMPTS=$(( SPCL_HEALTH_WAIT_SECONDS / 3 ))
[ "$HEALTH_ATTEMPTS" -lt 1 ] && HEALTH_ATTEMPTS=1

for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
  HEALTH="$(remote "$REMOTE_DOCKER exec spcl-api node -e \"
    fetch('http://127.0.0.1:3000/health')
      .then(r => r.text())
      .then(t => { console.log(t); process.exit(0); })
      .catch(() => process.exit(1));
  \" 2>/dev/null" || true)"

  [ -n "$HEALTH" ] && break
  sleep 3
done

if echo "$HEALTH" | grep -q '"status":"ok"'; then
  ok "the API is up and talking to the database"
  muted "$HEALTH"
else
  warn "the API did not report healthy"
  muted "${HEALTH:-no response}"
  info ""
  info "Look at the logs:"
  info "  ssh $SPCL_SSH 'docker logs spcl-api --tail 50'"
  exit 1
fi

# --- 9. backup sanity --------------------------------------------------------

step "Checking backups"

if remote "$REMOTE_DOCKER exec spcl-backup sh /opt/spcl-deploy/backup-check.sh 2>&1" | sed 's/^/    /'; then
  ok "backups look healthy"
else
  warn "the backup check reported a problem - see above"
  warn "the deploy itself succeeded; this is about your restore points"
fi

# --- done --------------------------------------------------------------------

DEPLOYED="$(remote_git "log -1 --format='%h  %s'" | tr -d '\r')"

printf "\n%s==>%s %sDeployed%s\n" "$BOLD" "$RESET" "$GREEN" "$RESET"
info "$DEPLOYED"
printf "\n"
