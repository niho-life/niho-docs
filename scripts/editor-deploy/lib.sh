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
  # Steps (#37): off unless STEPS_MODE=cloud-tasks (docs/ops/editor-deploy.md §10).
  STEPS_MODE="${STEPS_MODE:-}"
  [[ -z "$STEPS_MODE" || "$STEPS_MODE" == cloud-tasks ]] || die "STEPS_MODE must be empty or cloud-tasks in $DEPLOY_ENV"
  TASKS_SA="${TASKS_SA:-niho-editor-tasks}"
  TASKS_SA_EMAIL="$TASKS_SA@$GCP_PROJECT.iam.gserviceaccount.com"
  STEPS_QUEUE=niho-editor-steps
  STEPS_SWEEP_JOB=niho-editor-steps-sweep
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
}

# GCLOUD replaces the binary in the dry-run checks (scripts/editor-deploy/steps-infra.test.sh); the default is gcloud.
gcp() { "${GCLOUD:-gcloud}" --project "$GCP_PROJECT" --quiet "$@"; }

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

# Environment of the web service. Auth is always `niho`: the app refuses to start in production otherwise.
service_env_vars() {
  printf 'EDITOR_AUTH_MODE=niho,EDITOR_ORIGIN=%s,EDITOR_ASSETS_BUCKET=%s' "$(app_origin)" "$ASSETS_BUCKET"
}

# Steps (#37): the worker route is a path of the same service; its run.app URL is also the OIDC audience.
# Prints the extra env (with a leading comma) only when STEPS_MODE=cloud-tasks; otherwise nothing (the steps stay off).
steps_env_vars() {
  [[ "$STEPS_MODE" == cloud-tasks ]] || return 0
  printf ',EDITOR_STEPS_MODE=cloud-tasks,EDITOR_STEPS_QUEUE=projects/%s/locations/%s/queues/%s,EDITOR_STEPS_WORKER_URL=%s,EDITOR_STEPS_INVOKER_SA=%s' \
    "$GCP_PROJECT" "$GCP_REGION" "$STEPS_QUEUE" "$(service_url "$SERVICE")" "$TASKS_SA_EMAIL"
}
