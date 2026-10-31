# shellcheck shell=bash disable=SC2034  # the variables are read by the scripts that source this file
# Shared by gcp-bootstrap.sh and deploy.sh. Source, do not run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_ENV="${DEPLOY_ENV:-$SCRIPT_DIR/deploy.env}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

load_deploy_env() {
  [[ -f "$DEPLOY_ENV" ]] || die "$DEPLOY_ENV is missing: copy scripts/editor-deploy/deploy.env.example and fill it in"
  set -a
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV"
  set +a
  local name
  for name in GCP_PROJECT GCP_REGION CLOUDSQL_INSTANCE VPC_NETWORK VPC_SUBNET ARTIFACT_REPO \
    SERVICE MIGRATE_JOB RUNNER_SA MIGRATE_SA ASSETS_BUCKET; do
    [[ -n "${!name:-}" ]] || die "$name is not set in $DEPLOY_ENV"
  done
  APP_DOMAIN="${APP_DOMAIN:-}"
  # AI (#38). Optional: the model and the monthly limit per person (estimated USD). The key itself is a secret (set-ai-key.sh).
  AI_MODEL="${AI_MODEL:-claude-sonnet-5-5}"
  AI_MONTHLY_LIMIT_USD="${AI_MONTHLY_LIMIT_USD:-10}"
  # Both go into --set-env-vars (comma-separated): refuse anything that could add another variable.
  [[ "$AI_MODEL" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || die "AI_MODEL in $DEPLOY_ENV is not a model name"
  [[ "$AI_MONTHLY_LIMIT_USD" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "AI_MONTHLY_LIMIT_USD in $DEPLOY_ENV is not a non-negative number"
  # Every resource that takes labels carries this one: Cloud Billing reports filter on it.
  COST_LABEL="app=niho-editor"
  RUNNER_SA_EMAIL="$RUNNER_SA@$GCP_PROJECT.iam.gserviceaccount.com"
  MIGRATE_SA_EMAIL="$MIGRATE_SA@$GCP_PROJECT.iam.gserviceaccount.com"
  IMAGE="$GCP_REGION-docker.pkg.dev/$GCP_PROJECT/$ARTIFACT_REPO/web"
  DB_NAME=niho_editor
  DB_MIGRATE_ROLE=niho_editor_migrate
  DB_APP_ROLE=niho_editor_app
  SECRET_DATABASE_URL=niho-editor-database-url
  SECRET_MIGRATE_DATABASE_URL=niho-editor-migrate-database-url
  SECRET_ANTHROPIC_KEY=niho-editor-anthropic-key
}

gcp() { gcloud --project "$GCP_PROJECT" --quiet "$@"; }

project_number() { gcp projects describe "$GCP_PROJECT" --format='value(projectNumber)'; }
cloudsql_connection_name() {
  gcp sql instances describe "$CLOUDSQL_INSTANCE" --format='value(connectionName)'
}
# Cloud Run's deterministic URL (no describe needed before the first deploy).
service_url() { printf 'https://%s-%s.%s.run.app' "$1" "$(project_number)" "$GCP_REGION"; }
# The origin people use. The app checks it on every write (EDITOR_ORIGIN), so it is the custom domain once there is one.
app_origin() {
  if [[ -n "$APP_DOMAIN" ]]; then printf 'https://%s' "$APP_DOMAIN"; else service_url "$SERVICE"; fi
}

secret_has_version() {
  [[ -n "$(gcp secrets versions list "$1" --filter='state:ENABLED' --format='value(name)' --limit 1)" ]]
}
# AI (#38) is on only when the key secret exists and its newest version is enabled (the owner adds one with set-ai-key.sh).
# The service reads `:latest`, which is the most recently created version whatever its state, so an older enabled version
# does not count: a disabled newest one would make the revision fail to start. Otherwise deploy.sh adds nothing for AI and
# the app answers 503 ai_unavailable.
ai_key_ready() {
  gcp secrets describe "$SECRET_ANTHROPIC_KEY" > /dev/null 2>&1 || return 1
  local state
  state="$(gcp secrets versions list "$SECRET_ANTHROPIC_KEY" --sort-by=~createTime --limit 1 --format='value(state)')"
  [[ "$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')" == enabled ]]
}

# The functions below take the AI switch as $1 (1 = ai_key_ready said yes, 0 = no) and never call gcloud for it,
# so lib-test.sh checks them without GCP.

# Secrets of the web service. `--set-secrets` replaces the whole list on every deploy: the database URL is always in it.
service_secrets() {
  local secrets="DATABASE_URL=$SECRET_DATABASE_URL:latest"
  if [[ "${1:-0}" == 1 ]]; then secrets+=",ANTHROPIC_API_KEY=$SECRET_ANTHROPIC_KEY:latest"; fi
  printf '%s' "$secrets"
}

# Environment of the web service (`--set-env-vars` also replaces the whole list). Auth is always `niho`: the app refuses to
# start in production otherwise.
service_env_vars() {
  printf 'EDITOR_AUTH_MODE=niho,EDITOR_ORIGIN=%s,EDITOR_ASSETS_BUCKET=%s' "$(app_origin)" "$ASSETS_BUCKET"
  if [[ "${1:-0}" == 1 ]]; then
    printf ',EDITOR_AI_MODE=anthropic,EDITOR_AI_MODEL=%s,EDITOR_AI_MONTHLY_LIMIT_USD=%s' "$AI_MODEL" "$AI_MONTHLY_LIMIT_USD"
  fi
}
