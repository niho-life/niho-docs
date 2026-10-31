#!/usr/bin/env bash
# Adds the Google OAuth client secret as a new version of the secret niho-editor-google-oauth-secret
# (the google login, docs/ops/editor-deploy.md §13).
#
#   scripts/editor-deploy/set-google-oauth-secret.sh                      # on a terminal: asks for it without showing it
#   <command that prints the secret> | scripts/editor-deploy/set-google-oauth-secret.sh   # or reads it from standard input
#
# The secret is never printed, written to a file or put on a command line (it goes to gcloud through a pipe), and it is never
# taken as an argument. The newest version is the one the service reads (`:latest`). An empty input adds nothing.
# Then: scripts/editor-deploy/deploy.sh --no-build (the google login turns on, if EDITOR_AUTH_MODE=google in deploy.env).
# Needs scripts/editor-deploy/gcp-bootstrap.sh resources first.
# shellcheck source=scripts/editor-deploy/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env
[[ $# -eq 0 ]] || die "usage: $0 (the secret is read from standard input, never from an argument)"

gcp secrets describe "$SECRET_GOOGLE_OAUTH" > /dev/null 2>&1 \
  || die "$SECRET_GOOGLE_OAUTH does not exist: run scripts/editor-deploy/gcp-bootstrap.sh resources first"

secret=""
if [[ -t 0 ]]; then
  printf 'Google OAuth client secret (the input is not shown): ' >&2
  IFS= read -r -s secret || true
  printf '\n' >&2
else
  IFS= read -r secret || true
fi
# A pasted secret often carries spaces or a line break around it.
secret="${secret#"${secret%%[![:space:]]*}"}"
secret="${secret%"${secret##*[![:space:]]}"}"
[[ -n "$secret" ]] || die "no secret was given: nothing was added"
# Google's client secrets are letters, digits, '-' and '_' (they start with GOCSPX-). Anything else is a wrong paste
# (the message never repeats what was given).
if [[ ! "$secret" =~ ^[A-Za-z0-9_-]+$ ]]; then
  unset secret
  die "that does not look like a client secret: nothing was added"
fi

log "add a new version of $SECRET_GOOGLE_OAUTH"
# printf is a shell builtin: the secret is not on any process's command line.
printf '%s' "$secret" | gcp secrets versions add "$SECRET_GOOGLE_OAUTH" --data-file=- > /dev/null
unset secret
log "done. Next: scripts/editor-deploy/deploy.sh --no-build (then disable older versions if this replaced a secret)"
