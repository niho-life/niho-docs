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
  # Steps (#37): off unless STEPS_MODE=cloud-tasks (docs/ops/editor-deploy.md §11).
  STEPS_MODE="${STEPS_MODE:-}"
  [[ -z "$STEPS_MODE" || "$STEPS_MODE" == cloud-tasks ]] || die "STEPS_MODE must be empty or cloud-tasks in $DEPLOY_ENV"
  # Transcription (#36): the engine is on only when the Deepgram key secret has an enabled newest version
  # (docs/ops/editor-deploy.md §12). The timeout is optional; empty leaves the app default (1200 seconds).
  # The range is the one the app accepts (timeoutSec() in apps/editor-web/src/transcription/config.ts): a value outside
  # it would pass here and then stop the new revision from starting (checkStartupConfig exits), so refuse it now.
  TRANSCRIBE_TIMEOUT_SEC="${TRANSCRIBE_TIMEOUT_SEC:-}"
  if [[ -n "$TRANSCRIBE_TIMEOUT_SEC" ]]; then
    [[ "$TRANSCRIBE_TIMEOUT_SEC" =~ ^[0-9]+$ ]] \
      || die "TRANSCRIBE_TIMEOUT_SEC must be empty or a whole number of seconds in $DEPLOY_ENV"
    (( TRANSCRIBE_TIMEOUT_SEC >= 60 && TRANSCRIBE_TIMEOUT_SEC <= 3300 )) \
      || die "TRANSCRIBE_TIMEOUT_SEC must be between 60 and 3300 seconds in $DEPLOY_ENV"
  fi
  # The dispatcher that runs a transcription apart from the request: off unless TRANSCRIBE_MODE=cloud-tasks (§12).
  # Without it the engine cannot be reached in production at all (the start answers 503), key or no key.
  TRANSCRIBE_MODE="${TRANSCRIBE_MODE:-}"
  [[ -z "$TRANSCRIBE_MODE" || "$TRANSCRIBE_MODE" == cloud-tasks ]] || die "TRANSCRIBE_MODE must be empty or cloud-tasks in $DEPLOY_ENV"
  TASKS_SA="${TASKS_SA:-niho-editor-tasks}"
  TASKS_SA_EMAIL="$TASKS_SA@$GCP_PROJECT.iam.gserviceaccount.com"
  STEPS_QUEUE=niho-editor-steps
  STEPS_SWEEP_JOB=niho-editor-steps-sweep
  # The transcription has its own queue: one run takes up to 20 minutes, where a step is quick, so the retries, the number
  # that run at once and the deadline of one task are all different (docs/ops/editor-deploy.md §12).
  TRANSCRIBE_QUEUE=niho-editor-transcribe
  TRANSCRIBE_SWEEP_JOB=niho-editor-transcribe-sweep
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
  SECRET_DEEPGRAM_KEY=niho-editor-deepgram-key
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

secret_has_version() {
  [[ -n "$(gcp secrets versions list "$1" --filter='state:ENABLED' --format='value(name)' --limit 1)" ]]
}
# AI (#38) is on only when the key secret exists and its newest version is enabled (the owner adds one with set-ai-key.sh).
# The service reads `:latest`, which is the most recently created version whatever its state, so an older enabled version
# does not count: a disabled newest one would make the revision fail to start. Otherwise deploy.sh adds nothing for AI and
# the app answers 503 ai_unavailable.
newest_version_enabled() {
  gcp secrets describe "$1" > /dev/null 2>&1 || return 1
  local state
  state="$(gcp secrets versions list "$1" --sort-by=~createTime --limit 1 --format='value(state)')"
  [[ "$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')" == enabled ]]
}
ai_key_ready() { newest_version_enabled "$SECRET_ANTHROPIC_KEY"; }
# Transcription (#36) is on under the same rule as AI: the owner adds the key with set-transcribe-key.sh. Without it the
# engine stays off and the app answers 503 (the VTT import still works; only the engine needs the key).
transcribe_key_ready() { newest_version_enabled "$SECRET_DEEPGRAM_KEY"; }

# The functions below take the AI switch as $1 and the transcription switch as $2 (1 = the matching *_key_ready said yes,
# 0 = no) and never call gcloud for them, so lib-test.sh checks them without GCP.

# Secrets of the web service. `--set-secrets` replaces the whole list on every deploy: the database URL is always in it.
service_secrets() {
  local secrets="DATABASE_URL=$SECRET_DATABASE_URL:latest"
  if [[ "${1:-0}" == 1 ]]; then secrets+=",ANTHROPIC_API_KEY=$SECRET_ANTHROPIC_KEY:latest"; fi
  if [[ "${2:-0}" == 1 ]]; then secrets+=",DEEPGRAM_API_KEY=$SECRET_DEEPGRAM_KEY:latest"; fi
  printf '%s' "$secrets"
}

# Environment of the web service (`--set-env-vars` also replaces the whole list). Auth is always `niho`: the app refuses to
# start in production otherwise.
service_env_vars() {
  # EDITOR_STORAGE is always gcs here: unset means `off` in production (src/storage/config.ts), which answers 503 for
  # every image and audio request. The bucket goes with it, and the runner may only create and read objects in it.
  printf 'EDITOR_AUTH_MODE=niho,EDITOR_ORIGIN=%s,EDITOR_STORAGE=gcs,EDITOR_ASSETS_BUCKET=%s' "$(app_origin)" "$ASSETS_BUCKET"
  if [[ "${1:-0}" == 1 ]]; then
    printf ',EDITOR_AI_MODE=anthropic,EDITOR_AI_MODEL=%s,EDITOR_AI_MONTHLY_LIMIT_USD=%s' "$AI_MODEL" "$AI_MONTHLY_LIMIT_USD"
  fi
  if [[ "${2:-0}" == 1 ]]; then
    printf ',EDITOR_TRANSCRIBE_ENGINE=deepgram'
    if [[ -n "$TRANSCRIBE_TIMEOUT_SEC" ]]; then printf ',EDITOR_TRANSCRIBE_TIMEOUT_SEC=%s' "$TRANSCRIBE_TIMEOUT_SEC"; fi
  fi
}

# Steps (#37): the worker route is a path of the same service; its run.app URL is also the OIDC audience.
# Prints the extra env (with a leading comma) only when STEPS_MODE=cloud-tasks; otherwise nothing (the steps stay off).
steps_env_vars() {
  [[ "$STEPS_MODE" == cloud-tasks ]] || return 0
  printf ',EDITOR_STEPS_MODE=cloud-tasks,EDITOR_STEPS_QUEUE=projects/%s/locations/%s/queues/%s,EDITOR_STEPS_WORKER_URL=%s,EDITOR_STEPS_INVOKER_SA=%s' \
    "$GCP_PROJECT" "$GCP_REGION" "$STEPS_QUEUE" "$(service_url "$SERVICE")" "$TASKS_SA_EMAIL"
}

# Transcription (#36): same shape as steps_env_vars, with the transcription's own queue and worker routes
# (/api/internal/transcription/**). Prints nothing while TRANSCRIBE_MODE is empty, and then the app has no dispatcher in
# production, so starting a transcription answers 503 (the VTT import, which needs neither engine nor dispatcher, still works).
transcribe_env_vars() {
  [[ "$TRANSCRIBE_MODE" == cloud-tasks ]] || return 0
  printf ',EDITOR_TRANSCRIBE_MODE=cloud-tasks,EDITOR_TRANSCRIBE_QUEUE=projects/%s/locations/%s/queues/%s,EDITOR_TRANSCRIBE_WORKER_URL=%s,EDITOR_TRANSCRIBE_INVOKER_SA=%s' \
    "$GCP_PROJECT" "$GCP_REGION" "$TRANSCRIBE_QUEUE" "$(service_url "$SERVICE")" "$TASKS_SA_EMAIL"
}

# Cloud Run's limit on one request. A whole transcription runs inside one request of the worker route, so the limit has to
# be longer than the engine's own timeout: the engine stops first and the run ends as engine_timeout, instead of Cloud Run
# cutting the request while the run stays `running` until the sweep. The margin is the one the task's dispatchDeadline uses
# (DISPATCH_MARGIN_SECONDS in apps/editor-web/src/transcription/cloud-tasks.ts).
SERVICE_TIMEOUT_BASE_SEC=300
TRANSCRIBE_TIMEOUT_DEFAULT_SEC=1200
TRANSCRIBE_TIMEOUT_MARGIN_SEC=120
CLOUD_RUN_TIMEOUT_MAX_SEC=3600
service_request_timeout() {
  local seconds=$SERVICE_TIMEOUT_BASE_SEC
  if [[ "$TRANSCRIBE_MODE" == cloud-tasks ]]; then
    local wanted=$(( ${TRANSCRIBE_TIMEOUT_SEC:-$TRANSCRIBE_TIMEOUT_DEFAULT_SEC} + TRANSCRIBE_TIMEOUT_MARGIN_SEC ))
    if (( wanted > seconds )); then seconds=$wanted; fi
  fi
  if (( seconds > CLOUD_RUN_TIMEOUT_MAX_SEC )); then seconds=$CLOUD_RUN_TIMEOUT_MAX_SEC; fi
  printf '%s' "$seconds"
}
