#!/usr/bin/env bash
# The execution infrastructure of the steps (#37, docs/ops/editor-deploy.md §11). Idempotent: what exists is updated.
# Run by `gcp-bootstrap.sh resources`; can also be run alone:
#
#   scripts/editor-deploy/steps-infra.sh
#
#   - APIs: Cloud Tasks, Cloud Scheduler
#   - service account $TASKS_SA: only the identity in the OIDC tokens of the tasks and of the sweep. It gets no role on any
#     resource; the worker routes of the service check that the token's email is exactly this account.
#   - Cloud Tasks queue $STEPS_QUEUE (5 attempts, 10s..300s backoff, 5 at a time)
#   - the runtime ($RUNNER_SA) may enqueue into that queue, and may put the tasks account on a task's OIDC token
#   - Cloud Scheduler job $STEPS_SWEEP_JOB: every 5 minutes, POST <service URL>/api/internal/steps/sweep with the OIDC token
#     of the tasks account (audience: the service URL), no retry
#
# Queues, service accounts and Scheduler jobs take no labels; their cost stays in the free tier (§11).
# GCLOUD=<binary> replaces gcloud (steps-infra.test.sh checks the arguments with a fake one; it never reaches GCP).
# shellcheck source=scripts/editor-deploy/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env

steps_infra() {
  local worker_url
  worker_url="$(service_url "$SERVICE")"

  log "steps: APIs (Cloud Tasks, Cloud Scheduler)"
  gcp services enable cloudtasks.googleapis.com cloudscheduler.googleapis.com

  log "steps: service account $TASKS_SA (the OIDC identity of the tasks and the sweep; no roles)"
  gcp iam service-accounts describe "$TASKS_SA_EMAIL" > /dev/null 2>&1 \
    || gcp iam service-accounts create "$TASKS_SA" --display-name "NIHO editor steps (Cloud Tasks / Scheduler OIDC)"

  log "steps: Cloud Tasks queue $STEPS_QUEUE"
  local queue_flags=(--location "$GCP_REGION" --max-attempts=5 --min-backoff=10s --max-backoff=300s --max-concurrent-dispatches=5)
  if gcp tasks queues describe "$STEPS_QUEUE" --location "$GCP_REGION" > /dev/null 2>&1; then
    gcp tasks queues update "$STEPS_QUEUE" "${queue_flags[@]}" > /dev/null
  else
    gcp tasks queues create "$STEPS_QUEUE" "${queue_flags[@]}"
  fi

  log "steps: the runtime enqueues into the queue and signs the tasks' OIDC token as the tasks account"
  gcp tasks queues add-iam-policy-binding "$STEPS_QUEUE" --location "$GCP_REGION" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/cloudtasks.enqueuer > /dev/null
  gcp iam service-accounts add-iam-policy-binding "$TASKS_SA_EMAIL" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/iam.serviceAccountUser > /dev/null

  log "steps: Cloud Scheduler job $STEPS_SWEEP_JOB (every 5 minutes)"
  local job_flags=(
    --location "$GCP_REGION"
    --schedule "*/5 * * * *" --time-zone Asia/Tokyo
    --uri "$worker_url/api/internal/steps/sweep" --http-method post
    --oidc-service-account-email "$TASKS_SA_EMAIL" --oidc-token-audience "$worker_url"
    --attempt-deadline 300s --max-retry-attempts 0
    --description "NIHO editor steps (#37): requeue lost tasks and expired leases"
  )
  # update keeps the job's state (a paused job stays paused: docs/ops/editor-deploy.md §11)
  if gcp scheduler jobs describe "$STEPS_SWEEP_JOB" --location "$GCP_REGION" > /dev/null 2>&1; then
    gcp scheduler jobs update http "$STEPS_SWEEP_JOB" "${job_flags[@]}" > /dev/null
  else
    gcp scheduler jobs create http "$STEPS_SWEEP_JOB" "${job_flags[@]}"
  fi

  if [[ "$STEPS_MODE" == cloud-tasks ]]; then
    log "steps: done. Next: scripts/editor-deploy/deploy.sh (STEPS_MODE=cloud-tasks)"
  else
    log "steps: done. The steps stay off until STEPS_MODE=cloud-tasks in $DEPLOY_ENV and scripts/editor-deploy/deploy.sh"
  fi
}

steps_infra
