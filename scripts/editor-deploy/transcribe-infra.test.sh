#!/usr/bin/env bash
# Dry-run check of transcribe-infra.sh, of transcribe_env_vars and of service_request_timeout (lib.sh) with a fake gcloud
# and the example env file. Nothing reaches GCP: the fake only records its arguments. Run by the editor-deploy job of
# editor-web-ci.yml.
#
#   scripts/editor-deploy/transcribe-infra.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$here/deploy.env.example" "$work/deploy.env"
cat > "$work/gcloud" << 'FAKE'
#!/usr/bin/env bash
# Fake gcloud: appends its arguments to $FAKE_LOG. `describe` fails (nothing exists) unless FAKE_EXISTS=1.
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *" projects describe "*) printf '000000000000\n' ;;
  *" describe "*) [[ "${FAKE_EXISTS:-0}" == 1 ]] || exit 1 ;;
esac
exit 0
FAKE
chmod +x "$work/gcloud"

fail() { printf 'transcribe-infra.test: %s\n' "$*" >&2; exit 1; }
expect_line() {
  grep -qxF -- "$2" "$1" || fail "missing gcloud call: $2"
}
refuse_line() {
  if grep -qF -- "$2" "$1"; then fail "unexpected gcloud call: $2"; fi
}

run_infra() {
  : > "$work/calls"
  FAKE_LOG="$work/calls" FAKE_EXISTS="$1" GCLOUD="$work/gcloud" DEPLOY_ENV="$work/deploy.env" \
    "$here/transcribe-infra.sh" > /dev/null
}

project=my-gcp-project
region=asia-northeast1
url="https://niho-editor-000000000000.$region.run.app"
tasks_sa="niho-editor-tasks@$project.iam.gserviceaccount.com"
runner_sa="niho-editor-runner@$project.iam.gserviceaccount.com"
# One transcription takes up to 20 minutes: fewer attempts, a longer backoff and fewer at once than the steps queue.
queue_flags="--location $region --max-attempts=3 --min-backoff=60s --max-backoff=300s --max-concurrent-dispatches=3"
job_flags="--location $region --schedule */5 * * * * --time-zone Asia/Tokyo --uri $url/api/internal/transcription/sweep --http-method post --oidc-service-account-email $tasks_sa --oidc-token-audience $url --attempt-deadline 300s --max-retry-attempts 0 --description NIHO editor transcription (#36): requeue lost tasks and fail stranded runs"
g="--project $project --quiet"

# Nothing exists yet: everything is created.
run_infra 0
calls="$work/calls"
expect_line "$calls" "$g services enable cloudtasks.googleapis.com cloudscheduler.googleapis.com"
expect_line "$calls" "$g iam service-accounts create niho-editor-tasks --display-name NIHO editor steps (Cloud Tasks / Scheduler OIDC)"
expect_line "$calls" "$g tasks queues create niho-editor-transcribe $queue_flags"
expect_line "$calls" "$g tasks queues add-iam-policy-binding niho-editor-transcribe --location $region --member serviceAccount:$runner_sa --role roles/cloudtasks.enqueuer"
expect_line "$calls" "$g iam service-accounts add-iam-policy-binding $tasks_sa --member serviceAccount:$runner_sa --role roles/iam.serviceAccountUser"
expect_line "$calls" "$g scheduler jobs create http niho-editor-transcribe-sweep $job_flags"
# The tasks account is only an identity: no role is granted to it anywhere.
refuse_line "$calls" "--member serviceAccount:$tasks_sa"
# The steps queue and its sweep belong to steps-infra.sh; this script does not touch them.
refuse_line "$calls" "niho-editor-steps "
refuse_line "$calls" "/api/internal/steps/"

# Everything exists: updated in place, nothing created.
run_infra 1
expect_line "$calls" "$g tasks queues update niho-editor-transcribe $queue_flags"
expect_line "$calls" "$g scheduler jobs update http niho-editor-transcribe-sweep $job_flags"
refuse_line "$calls" " create"
refuse_line "$calls" "--member serviceAccount:$tasks_sa"

# The service env and the request timeout.
env_of() {
  FAKE_LOG="$work/calls" GCLOUD="$work/gcloud" DEPLOY_ENV="$work/deploy.env" \
    bash -c 'source "$1/lib.sh" && load_deploy_env && printf "%s" "$(transcribe_env_vars)"' _ "$here"
}
timeout_of() {
  FAKE_LOG="$work/calls" GCLOUD="$work/gcloud" DEPLOY_ENV="$work/deploy.env" \
    bash -c 'source "$1/lib.sh" && load_deploy_env && printf "%s" "$(service_request_timeout)"' _ "$here"
}
off="$(env_of)"
[[ -z "$off" ]] || fail "transcription env is set while TRANSCRIBE_MODE is empty: $off"
# Without the dispatcher the request limit is the usual one (no long request to allow for).
[[ "$(timeout_of)" == 300 ]] || fail "unexpected request timeout while TRANSCRIBE_MODE is empty: $(timeout_of)"

printf '\nTRANSCRIBE_MODE=cloud-tasks\n' >> "$work/deploy.env"
on="$(env_of)"
want=",EDITOR_TRANSCRIBE_MODE=cloud-tasks,EDITOR_TRANSCRIBE_QUEUE=projects/$project/locations/$region/queues/niho-editor-transcribe,EDITOR_TRANSCRIBE_WORKER_URL=$url,EDITOR_TRANSCRIBE_INVOKER_SA=$tasks_sa"
[[ "$on" == "$want" ]] || fail "unexpected service env with TRANSCRIBE_MODE=cloud-tasks: $on"
# The whole transcription runs inside one request of the worker route: the limit is the app default (1200) plus the margin.
[[ "$(timeout_of)" == 1320 ]] || fail "unexpected request timeout with the app default engine timeout: $(timeout_of)"

printf '\nTRANSCRIBE_TIMEOUT_SEC=600\n' >> "$work/deploy.env"
[[ "$(timeout_of)" == 720 ]] || fail "unexpected request timeout with TRANSCRIBE_TIMEOUT_SEC=600: $(timeout_of)"
printf '\nTRANSCRIBE_TIMEOUT_SEC=60\n' >> "$work/deploy.env"
# A short engine timeout never shortens the service below its usual limit.
[[ "$(timeout_of)" == 300 ]] || fail "unexpected request timeout with TRANSCRIBE_TIMEOUT_SEC=60: $(timeout_of)"
printf '\nTRANSCRIBE_TIMEOUT_SEC=3300\n' >> "$work/deploy.env"
# The app's highest timeout plus the margin still fits Cloud Run's own limit of 3600 seconds.
[[ "$(timeout_of)" == 3420 ]] || fail "unexpected request timeout with TRANSCRIBE_TIMEOUT_SEC=3300: $(timeout_of)"

printf '\nTRANSCRIBE_MODE=inline\n' >> "$work/deploy.env"
if env_of > /dev/null 2>&1; then fail "TRANSCRIBE_MODE=inline must be refused"; fi

printf 'transcribe-infra.test: ok\n'
