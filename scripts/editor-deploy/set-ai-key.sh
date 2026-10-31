#!/usr/bin/env bash
# Adds the Anthropic API key as a new version of the secret niho-editor-anthropic-key (docs/ops/editor-deploy.md §10).
#
#   scripts/editor-deploy/set-ai-key.sh                      # on a terminal: asks for the key without showing it
#   <command that prints the key> | scripts/editor-deploy/set-ai-key.sh   # or reads it from standard input
#
# The key is never printed, written to a file or put on a command line (it goes to gcloud through a pipe), and it is never
# taken as an argument. The newest version is the one the service reads (`:latest`). An empty input adds nothing.
# Then: scripts/editor-deploy/deploy.sh --no-build (AI turns on). Needs scripts/editor-deploy/gcp-bootstrap.sh resources first.
# shellcheck source=scripts/editor-deploy/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env
[[ $# -eq 0 ]] || die "usage: $0 (the key is read from standard input, never from an argument)"

gcp secrets describe "$SECRET_ANTHROPIC_KEY" > /dev/null 2>&1 \
  || die "$SECRET_ANTHROPIC_KEY does not exist: run scripts/editor-deploy/gcp-bootstrap.sh resources first"

key=""
if [[ -t 0 ]]; then
  printf 'Anthropic API key (the input is not shown): ' >&2
  IFS= read -r -s key || true
  printf '\n' >&2
else
  IFS= read -r key || true
fi
# A pasted key often carries spaces or a line break around it.
key="${key#"${key%%[![:space:]]*}"}"
key="${key%"${key##*[![:space:]]}"}"
[[ -n "$key" ]] || die "no key was given: nothing was added"
# Keys are letters, digits, '-' and '_'. Anything else is a wrong paste (the message never repeats what was given).
if [[ ! "$key" =~ ^[A-Za-z0-9_-]+$ ]]; then
  unset key
  die "that does not look like an API key: nothing was added"
fi

log "add a new version of $SECRET_ANTHROPIC_KEY"
# printf is a shell builtin: the key is not on any process's command line.
printf '%s' "$key" | gcp secrets versions add "$SECRET_ANTHROPIC_KEY" --data-file=- > /dev/null
unset key
log "done. Next: scripts/editor-deploy/deploy.sh --no-build (then disable older versions if this replaced a key)"
