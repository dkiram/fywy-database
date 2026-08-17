#!/usr/bin/env bash
#
# Deploys SPCL to the NAS from wherever you happen to be.
#
#   ./deploy/deploy.sh              push, rebuild, migrate, restart, verify
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
# The order is deliberate: code is pushed to GitHub first and the NAS pulls
# from there, so what runs in production is always a commit that exists
# somewhere other than one laptop.

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

SSH_CONTROL_DIR="${TMPDIR:-/tmp}/spcl-deploy-$$"
mkdir -p "$SSH_CONTROL_DIR"
chmod 700 "$SSH_CONTROL_DIR"

SSH_OPTS=(
  -p "$SPCL_SSH_PORT"
  -o ControlMaster=auto
  -o "ControlPath=$SSH_CONTROL_DIR/%r@%h:%p"
  -o ControlPersist=60
  -o ConnectTimeout=10
)

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

compose_cmd() {
  local profiles=""
  [ -n "$SPCL_COMPOSE_PROFILES" ] && profiles="--profile $SPCL_COMPOSE_PROFILES"
  echo "docker compose -f '$SPCL_COMPOSE_FILE' --env-file '$SPCL_ENV_FILE' $profiles"
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

remote true 2>/dev/null || fail "cannot reach $SPCL_SSH.

       If you are away from the office network, this is expected until
       Tailscale is set up - see docs/remote-deploy-setup.md.

       If you are on the network, check that SSH is enabled on the NAS
       (TOS Control Panel -> Terminal & SNMP)."

ok "connected to $SPCL_SSH"

remote_in_repo "test -f '$SPCL_COMPOSE_FILE'" \
  || fail "no $SPCL_COMPOSE_FILE in $SPCL_REMOTE_DIR on the NAS.
       Is SPCL_REMOTE_DIR right?"

remote_in_repo "test -f '$SPCL_ENV_FILE'" \
  || fail "no $SPCL_ENV_FILE in $SPCL_REMOTE_DIR on the NAS.
       That file holds the database password and session secret and is
       created on the NAS, never copied from a laptop."

# --- 4. what is about to change ----------------------------------------------

step "Fetching on the NAS"

remote_in_repo "git fetch origin '$SPCL_BRANCH' 2>&1" | sed 's/^/    /' || true

REMOTE_HEAD="$(remote_in_repo "git rev-parse HEAD" | tr -d '\r\n')"

if [ "$REMOTE_HEAD" = "$LOCAL_HEAD" ]; then
  muted "the NAS is already on this commit"
else
  info "incoming commits:"
  remote_in_repo "git log --oneline HEAD..origin/'$SPCL_BRANCH' 2>/dev/null | head -20" \
    | sed 's/^/        /' || true
fi

if [ "$MODE" = "check" ]; then
  step "Check mode - stopping here"
  muted "nothing on the NAS was changed"
  exit 0
fi

# --- 5. pull and rebuild -----------------------------------------------------

step "Pulling and rebuilding"

remote_in_repo "git pull --ff-only origin '$SPCL_BRANCH' 2>&1" | sed 's/^/    /' \
  || fail "git pull failed on the NAS. If someone edited files there directly,
       the pull will refuse rather than overwrite them."

info "building - this takes a few minutes on first run"

remote_in_repo "$(compose_cmd) up -d --build 2>&1" | sed 's/^/    /' \
  || fail "the build or start failed. The previous containers may still be running.
       Check with: ssh $SPCL_SSH 'cd $SPCL_REMOTE_DIR && $(compose_cmd) ps'"

ok "containers are up"

# --- 6. wait for the database ------------------------------------------------

step "Waiting for PostgreSQL"

DB_READY="false"
DB_ATTEMPTS=$(( SPCL_DB_WAIT_SECONDS / 2 ))
[ "$DB_ATTEMPTS" -lt 1 ] && DB_ATTEMPTS=1

for _ in $(seq 1 "$DB_ATTEMPTS"); do
  if remote "docker exec spcl-postgres pg_isready -q" 2>/dev/null; then
    DB_READY="true"
    break
  fi
  sleep 2
done

[ "$DB_READY" = "true" ] || fail "PostgreSQL did not become ready within ${SPCL_DB_WAIT_SECONDS} seconds.
       Check with: ssh $SPCL_SSH 'docker logs spcl-postgres --tail 50'"

ok "database is accepting connections"

# --- 7. migrations -----------------------------------------------------------

if [ "$SKIP_MIGRATIONS" = "true" ]; then
  step "Skipping migrations (--skip-migrations)"
else
  step "Checking for pending migrations"

  PENDING_OUTPUT="$(remote "docker exec spcl-backup sh /opt/spcl-deploy/migrate.sh --dry-run 2>&1" || true)"
  echo "$PENDING_OUTPUT" | sed 's/^/    /'

  if echo "$PENDING_OUTPUT" | grep -q "nothing to apply"; then
    ok "schema is already up to date"

  elif echo "$PENDING_OUTPUT" | grep -q "would apply"; then
    info ""
    warn "the above migrations will change the live database"
    muted "a safety backup is taken automatically before any of it runs"

    if confirm "Apply them now?"; then
      remote "docker exec spcl-backup sh /opt/spcl-deploy/migrate.sh 2>&1" | sed 's/^/    /' \
        || fail "a migration failed. The database was rolled back to before that
       migration started, and a safety backup was taken before anything ran."
      ok "migrations applied"
    else
      warn "migrations skipped - the new code may expect columns that do not exist yet"
    fi

  else
    warn "could not read the migration status - check the output above"
    confirm "Continue without migrating?" || fail "nothing further was changed."
  fi
fi

# --- 8. did it actually come back up -----------------------------------------

step "Verifying the app"

HEALTH=""
HEALTH_ATTEMPTS=$(( SPCL_HEALTH_WAIT_SECONDS / 3 ))
[ "$HEALTH_ATTEMPTS" -lt 1 ] && HEALTH_ATTEMPTS=1

for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
  HEALTH="$(remote "docker exec spcl-api node -e \"
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

if remote "docker exec spcl-backup sh /opt/spcl-deploy/backup-check.sh 2>&1" | sed 's/^/    /'; then
  ok "backups look healthy"
else
  warn "the backup check reported a problem - see above"
  warn "the deploy itself succeeded; this is about your restore points"
fi

# --- done --------------------------------------------------------------------

DEPLOYED="$(remote_in_repo "git log -1 --format='%h  %s'" | tr -d '\r')"

printf "\n%s==>%s %sDeployed%s\n" "$BOLD" "$RESET" "$GREEN" "$RESET"
info "$DEPLOYED"
printf "\n"
