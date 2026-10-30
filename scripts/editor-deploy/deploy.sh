#!/usr/bin/env bash
# Deploys the current HEAD to Cloud Run (docs/ops/editor-deploy.md §4):
#   1. Cloud Build builds the web and migrate images (cloudbuild.yaml), tagged with the git SHA
#   2. the migrate job applies the migrations and the app role's privileges with the new image (stops on failure)
#   3. the web service is deployed with the new image
#   4. smoke checks: every response is noindex, and the API refuses a caller with no session
# Usage: scripts/editor-deploy/deploy.sh [--no-build] [--allow-dirty]
#   --no-build  redeploys the image that is serving now (picks up new secret versions; no build)
# Needs scripts/editor-deploy/deploy.env (see deploy.env.example) and a gcloud login with access to the project.
# Public CI never runs this: the production origin is this script, run by the owner (docs/ops/editor-deploy.md §7).
# shellcheck source=scripts/editor-deploy/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env
cd "$REPO_ROOT" || exit 1

build=1
allow_dirty=0
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    --allow-dirty) allow_dirty=1 ;;
    *) die "unknown option: $arg" ;;
  esac
done

if [[ $build -eq 1 ]]; then
  TAG="$(git rev-parse --short=12 HEAD)"
  if [[ -n "$(git status --porcelain)" ]]; then
    [[ $allow_dirty -eq 1 ]] || die "the worktree has uncommitted changes (deploy what is committed, or pass --allow-dirty)"
    TAG="$TAG-dirty"
  fi
else
  serving="$(gcp run services describe "$SERVICE" --region "$GCP_REGION" \
    --format='value(spec.template.spec.containers[0].image)')"
  [[ "$serving" == "$IMAGE:"* ]] || die "$SERVICE is not serving an image of $IMAGE (first deploy needs a build)"
  TAG="${serving#"$IMAGE:"}"
fi
CONNECTION="$(cloudsql_connection_name)"
SERVICE_URL="$(service_url "$SERVICE")"

if [[ $build -eq 1 ]]; then
  log "build $IMAGE:$TAG (Cloud Build)"
  gcp builds submit --config scripts/editor-deploy/cloudbuild.yaml --substitutions="_IMAGE=$IMAGE,_TAG=$TAG" .
else
  log "no build: redeploying the serving image $IMAGE:$TAG"
fi

log "migrate: run job $MIGRATE_JOB with $IMAGE-migrate:$TAG"
gcp run jobs deploy "$MIGRATE_JOB" \
  --region "$GCP_REGION" \
  --image "$IMAGE-migrate:$TAG" \
  --service-account "$MIGRATE_SA_EMAIL" \
  --set-cloudsql-instances "$CONNECTION" \
  --network "$VPC_NETWORK" --subnet "$VPC_SUBNET" --vpc-egress private-ranges-only \
  --set-secrets "DATABASE_URL=$SECRET_MIGRATE_DATABASE_URL:latest,EDITOR_APP_DATABASE_URL=$SECRET_DATABASE_URL:latest" \
  --max-retries 0 --task-timeout 10m --memory 512Mi --labels "$COST_LABEL" \
  --execute-now --wait

log "deploy $SERVICE with $IMAGE:$TAG"
# The service is reachable by anyone (people sign in inside the app); the app refuses every caller with no session.
gcp run deploy "$SERVICE" \
  --region "$GCP_REGION" \
  --image "$IMAGE:$TAG" \
  --service-account "$RUNNER_SA_EMAIL" \
  --no-invoker-iam-check --ingress all \
  --port 8080 --min-instances 0 --max-instances 2 \
  --cpu 1 --memory 512Mi --cpu-boost --concurrency 40 --timeout 60 \
  --add-cloudsql-instances "$CONNECTION" \
  --network "$VPC_NETWORK" --subnet "$VPC_SUBNET" --vpc-egress private-ranges-only \
  --set-secrets "DATABASE_URL=$SECRET_DATABASE_URL:latest" \
  --set-env-vars "$(service_env_vars)" \
  --labels "$COST_LABEL,commit=${TAG:0:12}"

# 一度でも特定の revision へ traffic を割り当てる（docs/ops/editor-deploy.md §9 の戻し方）と、Cloud Run は以降のデプロイもその割り当てを
# 引き継ぎ、新しい revision へ traffic を送らない。smoke が古い revision に通らないよう、毎回、最新の revision へ明示的に向ける。
log "route all traffic to the latest revision of $SERVICE"
gcp run services update-traffic "$SERVICE" --region "$GCP_REGION" --to-latest

log "smoke: $SERVICE_URL"
# `-D -` prints the headers; the checks read the headers and status only, never a body.
smoke_headers() { curl -sS -o /dev/null -D - --retry 5 --retry-all-errors --max-time 20 "$SERVICE_URL$1"; }
for path in / /api/pages /robots.txt; do
  headers="$(smoke_headers "$path")"
  grep -qi '^x-robots-tag: noindex, nofollow' <<< "$headers" || die "$path: X-Robots-Tag noindex, nofollow is missing"
  log "ok noindex  $path"
done
status="$(curl -sS -o /dev/null -w '%{http_code}' --retry 5 --retry-all-errors --max-time 20 "$SERVICE_URL/api/pages")"
[[ "$status" == 401 ]] || die "/api/pages answered $status to a caller with no session (expected 401)"
log "ok 401      /api/pages with no session"
log "done: $TAG  $(app_origin)"
