#!/usr/bin/env bash
# Dry-run check of steps-infra.sh and of steps_env_vars (lib.sh) with a fake gcloud and the example env file.
# Nothing reaches GCP: the fake only records its arguments. Run by the editor-deploy job of editor-web-ci.yml.
#
#   scripts/editor-deploy/steps-infra.test.sh
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

fail() { printf 'steps-infra.test: %s\n' "$*" >&2; exit 1; }
expect_line() {
  grep -qxF -- "$2" "$1" || fail "missing gcloud call: $2"
}
refuse_line() {
  if grep -qF -- "$2" "$1"; then fail "unexpected gcloud call: $2"; fi
}

run_infra() {
  : > "$work/calls"
  FAKE_LOG="$work/calls" FAKE_EXISTS="$1" GCLOUD="$work/gcloud" DEPLOY_ENV="$work/deploy.env" \
    "$here/steps-infra.sh" > /dev/null
}

project=my-gcp-project
region=asia-northeast1
url="https://niho-editor-000000000000.$region.run.app"
tasks_sa="niho-editor-tasks@$project.iam.gserviceaccount.com"
runner_sa="niho-editor-runner@$project.iam.gserviceaccount.com"
queue_flags="--location $region --max-attempts=5 --min-backoff=10s --max-backoff=300s --max-concurrent-dispatches=5"
job_flags="--location $region --schedule */5 * * * * --time-zone Asia/Tokyo --uri $url/api/internal/steps/sweep --http-method post --oidc-service-account-email $tasks_sa --oidc-token-audience $url --attempt-deadline 300s --max-retry-attempts 0 --description NIHO editor steps (#37): requeue lost tasks and expired leases"
g="--project $project --quiet"

# Nothing exists yet: everything is created.
run_infra 0
calls="$work/calls"
expect_line "$calls" "$g services enable cloudtasks.googleapis.com cloudscheduler.googleapis.com"
expect_line "$calls" "$g iam service-accounts create niho-editor-tasks --display-name NIHO editor steps (Cloud Tasks / Scheduler OIDC)"
expect_line "$calls" "$g tasks queues create niho-editor-steps $queue_flags"
expect_line "$calls" "$g tasks queues add-iam-policy-binding niho-editor-steps --location $region --member serviceAccount:$runner_sa --role roles/cloudtasks.enqueuer"
expect_line "$calls" "$g iam service-accounts add-iam-policy-binding $tasks_sa --member serviceAccount:$runner_sa --role roles/iam.serviceAccountUser"
expect_line "$calls" "$g scheduler jobs create http niho-editor-steps-sweep $job_flags"
# The tasks account is only an identity: no role is granted to it anywhere.
refuse_line "$calls" "--member serviceAccount:$tasks_sa"

# Everything exists: updated in place, nothing created.
run_infra 1
expect_line "$calls" "$g tasks queues update niho-editor-steps $queue_flags"
expect_line "$calls" "$g scheduler jobs update http niho-editor-steps-sweep $job_flags"
refuse_line "$calls" " create"
refuse_line "$calls" "--member serviceAccount:$tasks_sa"

# The service env: nothing while STEPS_MODE is empty; the four variables with STEPS_MODE=cloud-tasks.
env_of() {
  FAKE_LOG="$work/calls" GCLOUD="$work/gcloud" DEPLOY_ENV="$work/deploy.env" \
    bash -c 'source "$1/lib.sh" && load_deploy_env && printf "%s" "$(service_env_vars)$(steps_env_vars)"' _ "$here"
}
off="$(env_of)"
[[ "$off" != *EDITOR_STEPS_* ]] || fail "steps env is set while STEPS_MODE is empty: $off"
printf '\nSTEPS_MODE=cloud-tasks\n' >> "$work/deploy.env"
on="$(env_of)"
want=",EDITOR_STEPS_MODE=cloud-tasks,EDITOR_STEPS_QUEUE=projects/$project/locations/$region/queues/niho-editor-steps,EDITOR_STEPS_WORKER_URL=$url,EDITOR_STEPS_INVOKER_SA=$tasks_sa"
[[ "$on" == "$off$want" ]] || fail "unexpected service env with STEPS_MODE=cloud-tasks: $on"
printf '\nSTEPS_MODE=inline\n' >> "$work/deploy.env"
if env_of > /dev/null 2>&1; then fail "STEPS_MODE=inline must be refused"; fi

printf 'steps-infra.test: ok\n'
