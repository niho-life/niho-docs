#!/usr/bin/env bash
# Checks lib.sh without GCP (CI's editor-deploy job runs it): the deploy.env defaults and checks, and the web service's
# --set-secrets / --set-env-vars with and without an AI key version. `gcp` is replaced by a stub; nothing reaches gcloud.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

failed=0
check() {
  if [[ "$2" == "$3" ]]; then
    printf 'ok    %s\n' "$1"
  else
    printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$3" "$2"
    failed=1
  fi
}

# deploy.env.example without the optional AI lines: the defaults apply.
grep -v '^AI_' "$dir/deploy.env.example" > "$tmp/deploy.env"
export DEPLOY_ENV="$tmp/deploy.env"
# shellcheck source=scripts/editor-deploy/lib.sh
source "$dir/lib.sh"
load_deploy_env

# Stub: `secrets describe` succeeds when the secret exists, `secrets versions list` prints the state of the newest version.
secret_exists=1
newest_state=""
gcp() {
  case "$1 $2" in
    "secrets describe") [[ $secret_exists -eq 1 ]] ;;
    "secrets versions") printf '%s' "$newest_state" ;;
    *) printf 'unexpected gcloud call: %s\n' "$*" >&2; return 99 ;;
  esac
}

check "default AI_MODEL" "$AI_MODEL" "claude-sonnet-5-5"
check "default AI_MONTHLY_LIMIT_USD" "$AI_MONTHLY_LIMIT_USD" "10"
check "AI key secret name" "$SECRET_ANTHROPIC_KEY" "niho-editor-anthropic-key"

ready() { if ai_key_ready; then printf 1; else printf 0; fi; }
check "no AI key version: AI off" "$(ready)" 0
newest_state="enabled"
check "the newest AI key version enabled: AI on" "$(ready)" 1
newest_state="disabled"
check "the newest AI key version disabled (an older one may be enabled): AI off" "$(ready)" 0
newest_state="ENABLED"
check "the state is read in either case: AI on" "$(ready)" 1
secret_exists=0
check "no AI key secret (bootstrap not re-run): AI off" "$(ready)" 0

# Transcription (#36) reads the same rule from its own secret.
check "transcription key secret name" "$SECRET_DEEPGRAM_KEY" "niho-editor-deepgram-key"
secret_exists=1
newest_state=""
tr_ready() { if transcribe_key_ready; then printf 1; else printf 0; fi; }
check "no transcription key version: engine off" "$(tr_ready)" 0
newest_state="enabled"
check "the newest transcription key version enabled: engine on" "$(tr_ready)" 1
newest_state="disabled"
check "the newest transcription key version disabled: engine off" "$(tr_ready)" 0
secret_exists=0
check "no transcription key secret: engine off" "$(tr_ready)" 0

base_env="EDITOR_AUTH_MODE=niho,EDITOR_ORIGIN=https://editor.example.com,EDITOR_STORAGE=gcs,EDITOR_ASSETS_BUCKET=my-gcp-project-editor-assets"
check "secrets without AI: only the database URL" "$(service_secrets 0)" "DATABASE_URL=niho-editor-database-url:latest"
check "secrets with AI: the database URL stays" "$(service_secrets 1)" \
  "DATABASE_URL=niho-editor-database-url:latest,ANTHROPIC_API_KEY=niho-editor-anthropic-key:latest"
check "env without AI: no EDITOR_AI_*" "$(service_env_vars 0)" "$base_env"
check "env with AI" "$(service_env_vars 1)" \
  "$base_env,EDITOR_AI_MODE=anthropic,EDITOR_AI_MODEL=claude-sonnet-5-5,EDITOR_AI_MONTHLY_LIMIT_USD=10"

# The storage mode is not a switch: unset means `off` in production, so every deploy passes gcs.
case "$(service_env_vars 0)" in *EDITOR_STORAGE=gcs*) check "storage is always gcs" ok ok ;; *) check "storage is always gcs" missing ok ;; esac

check "secrets with the transcription key only" "$(service_secrets 0 1)" \
  "DATABASE_URL=niho-editor-database-url:latest,DEEPGRAM_API_KEY=niho-editor-deepgram-key:latest"
check "secrets with both keys" "$(service_secrets 1 1)" \
  "DATABASE_URL=niho-editor-database-url:latest,ANTHROPIC_API_KEY=niho-editor-anthropic-key:latest,DEEPGRAM_API_KEY=niho-editor-deepgram-key:latest"
check "env with the transcription engine" "$(service_env_vars 0 1)" "$base_env,EDITOR_TRANSCRIBE_ENGINE=deepgram"
check "env without the transcription engine" "$(service_env_vars 0 0)" "$base_env"

# The example's own AI lines, and overrides.
DEPLOY_ENV="$dir/deploy.env.example" load_deploy_env
check "example AI_MODEL" "$AI_MODEL" "claude-sonnet-5-5"
printf 'AI_MODEL=claude-opus-5-5\nAI_MONTHLY_LIMIT_USD=2.5\n' >> "$tmp/deploy.env"
load_deploy_env
check "env with overridden AI settings" "$(service_env_vars 1)" \
  "$base_env,EDITOR_AI_MODE=anthropic,EDITOR_AI_MODEL=claude-opus-5-5,EDITOR_AI_MONTHLY_LIMIT_USD=2.5"

# Values that would add another variable to --set-env-vars (or are not what they claim) stop load_deploy_env.
refused() {
  grep -v '^AI_' "$dir/deploy.env.example" > "$tmp/bad.env"
  printf '%s\n' "$1" >> "$tmp/bad.env"
  if (DEPLOY_ENV="$tmp/bad.env" load_deploy_env) 2> /dev/null; then printf 0; else printf 1; fi
}
check "AI_MODEL with a comma is refused" "$(refused 'AI_MODEL=claude,EDITOR_AUTH_MODE=stub')" 1
check "AI_MODEL in capitals is refused" "$(refused 'AI_MODEL=Claude')" 1
check "a negative limit is refused" "$(refused 'AI_MONTHLY_LIMIT_USD=-1')" 1
check "a limit that is not a number is refused" "$(refused 'AI_MONTHLY_LIMIT_USD=10,EDITOR_AI_MODE=fake')" 1
check "a transcription timeout that is not a number is refused" "$(refused 'TRANSCRIBE_TIMEOUT_SEC=20m')" 1
check "a transcription timeout with a comma is refused" "$(refused 'TRANSCRIBE_TIMEOUT_SEC=600,EDITOR_AUTH_MODE=stub')" 1
# Outside the app's range the service would not start, so load_deploy_env refuses it here.
check "a transcription timeout below 60 is refused" "$(refused 'TRANSCRIBE_TIMEOUT_SEC=59')" 1
check "a transcription timeout above 3300 is refused" "$(refused 'TRANSCRIBE_TIMEOUT_SEC=3600')" 1
check "the lowest accepted timeout" "$(refused 'TRANSCRIBE_TIMEOUT_SEC=60')" 0
check "the highest accepted timeout" "$(refused 'TRANSCRIBE_TIMEOUT_SEC=3300')" 0

# The timeout is optional: empty leaves the app default out of --set-env-vars, a number is passed through.
grep -v '^AI_' "$dir/deploy.env.example" > "$tmp/timeout.env"
printf 'TRANSCRIBE_TIMEOUT_SEC=600\n' >> "$tmp/timeout.env"
DEPLOY_ENV="$tmp/timeout.env" load_deploy_env
check "env with the transcription timeout" "$(service_env_vars 0 1)" \
  "$base_env,EDITOR_TRANSCRIBE_ENGINE=deepgram,EDITOR_TRANSCRIBE_TIMEOUT_SEC=600"

# The transcription key's shape (set-transcribe-key.sh). A repetition count above 255 makes bash's regexes invalid,
# so the length is checked apart from the pattern; `{1,512}` used to reject every key on macOS.
shape() { if is_transcribe_key "$1"; then printf 1; else printf 0; fi; }
check "an ordinary key is accepted" "$(shape 'synthetic-not-a-real-key-0123456789')" 1
check "punctuation is accepted" "$(shape 'abc.DEF_ghi-123:xyz/+==')" 1
check "512 characters are accepted" "$(shape "$(printf 'a%.0s' $(seq 1 512))")" 1
check "513 characters are refused" "$(shape "$(printf 'a%.0s' $(seq 1 513))")" 0
check "a space is refused" "$(shape 'has space')" 0
check "a tab is refused" "$(shape "$(printf 'a\tb')")" 0
check "an empty key is refused" "$(shape '')" 0
check "a control character is refused" "$(shape "$(printf 'a\001b')")" 0
check "non-ASCII is refused" "$(shape 'かぎ')" 0

[[ $failed -eq 0 ]] || { printf 'lib-test: failed\n' >&2; exit 1; }
printf 'lib-test: all passed\n'
