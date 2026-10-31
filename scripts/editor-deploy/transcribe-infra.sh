#!/usr/bin/env bash
# The execution infrastructure of the transcription (#36, docs/ops/editor-deploy.md §12). Idempotent: what exists is updated.
# Run by `gcp-bootstrap.sh resources`; can also be run alone:
#
#   scripts/editor-deploy/transcribe-infra.sh
#
#   - APIs: Cloud Tasks, Cloud Scheduler
#   - service account $TASKS_SA: only the identity in the OIDC tokens of the tasks and of the sweep, and it is the same
#     account the steps (#37) use. It gets no role on any resource; the worker routes of the service check that the token's
#     email is exactly this account. steps-infra.sh creates the same account, so either script may run first or alone.
#   - Cloud Tasks queue $TRANSCRIBE_QUEUE, apart from the steps queue: one transcription takes up to 20 minutes, where a
#     step is quick, so the retries (3 attempts, 60s..300s) and the number that run at once (3) are its own. One task's
#     deadline is set by the app when it enqueues (the engine timeout plus 2 minutes, at most the 30 minutes Cloud Tasks
#     allows), so a long run is not cut by the queue.
#   - the runtime ($RUNNER_SA) may enqueue into that queue, and may put the tasks account on a task's OIDC token
#   - Cloud Scheduler job $TRANSCRIBE_SWEEP_JOB: every 5 minutes, POST <service URL>/api/internal/transcription/sweep with
#     the OIDC token of the tasks account (audience: the service URL), no retry
#
# Queues, service accounts and Scheduler jobs take no labels; their cost stays in the free tier (§12).
# GCLOUD=<binary> replaces gcloud (transcribe-infra.test.sh checks the arguments with a fake one; it never reaches GCP).
# shellcheck source=scripts/editor-deploy/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env

transcribe_infra() {
  local worker_url
  worker_url="$(service_url "$SERVICE")"

  log "transcribe: APIs (Cloud Tasks, Cloud Scheduler)"
  gcp services enable cloudtasks.googleapis.com cloudscheduler.googleapis.com

  log "transcribe: service account $TASKS_SA (the OIDC identity of the tasks and the sweep; no roles)"
  gcp iam service-accounts describe "$TASKS_SA_EMAIL" > /dev/null 2>&1 \
    || gcp iam service-accounts create "$TASKS_SA" --display-name "NIHO editor steps (Cloud Tasks / Scheduler OIDC)"

  log "transcribe: Cloud Tasks queue $TRANSCRIBE_QUEUE"
  local queue_flags=(--location "$GCP_REGION" --max-attempts=3 --min-backoff=60s --max-backoff=300s --max-concurrent-dispatches=3)
  if gcp tasks queues describe "$TRANSCRIBE_QUEUE" --location "$GCP_REGION" > /dev/null 2>&1; then
    gcp tasks queues update "$TRANSCRIBE_QUEUE" "${queue_flags[@]}" > /dev/null
  else
    gcp tasks queues create "$TRANSCRIBE_QUEUE" "${queue_flags[@]}"
  fi

  log "transcribe: the runtime enqueues into the queue and signs the tasks' OIDC token as the tasks account"
  gcp tasks queues add-iam-policy-binding "$TRANSCRIBE_QUEUE" --location "$GCP_REGION" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/cloudtasks.enqueuer > /dev/null
  gcp iam service-accounts add-iam-policy-binding "$TASKS_SA_EMAIL" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/iam.serviceAccountUser > /dev/null

  log "transcribe: Cloud Scheduler job $TRANSCRIBE_SWEEP_JOB (every 5 minutes)"
  local job_flags=(
    --location "$GCP_REGION"
    --schedule "*/5 * * * *" --time-zone Asia/Tokyo
    --uri "$worker_url/api/internal/transcription/sweep" --http-method post
    --oidc-service-account-email "$TASKS_SA_EMAIL" --oidc-token-audience "$worker_url"
    --attempt-deadline 300s --max-retry-attempts 0
    --description "NIHO editor transcription (#36): requeue lost tasks and fail stranded runs"
  )
  # update keeps the job's state (a paused job stays paused: docs/ops/editor-deploy.md §12)
  if gcp scheduler jobs describe "$TRANSCRIBE_SWEEP_JOB" --location "$GCP_REGION" > /dev/null 2>&1; then
    gcp scheduler jobs update http "$TRANSCRIBE_SWEEP_JOB" "${job_flags[@]}" > /dev/null
  else
    gcp scheduler jobs create http "$TRANSCRIBE_SWEEP_JOB" "${job_flags[@]}"
  fi

  if [[ "$TRANSCRIBE_MODE" == cloud-tasks ]]; then
    log "transcribe: done. Next: scripts/editor-deploy/deploy.sh (TRANSCRIBE_MODE=cloud-tasks; the engine also needs the key, §12)"
  else
    log "transcribe: done. Transcribing audio stays off until TRANSCRIBE_MODE=cloud-tasks in $DEPLOY_ENV and scripts/editor-deploy/deploy.sh"
  fi
}

transcribe_infra
