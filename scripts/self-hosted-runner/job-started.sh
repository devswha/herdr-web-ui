#!/usr/bin/env bash
# Runner-side guard (ACTIONS_RUNNER_HOOK_JOB_STARTED): runs before every job, outside anything a
# workflow controls. A pull request's run executes its own workflow files and route script, so a
# fork could send its job here; this refuses every job whose code comes from another repository
# (a fork pull request, a deleted head repository, a workflow_run of a fork) before a step runs.
set -euo pipefail

: "${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

head="$(jq -r --arg repo "$GITHUB_REPOSITORY" '
  if has("pull_request") then (.pull_request.head.repo.full_name // "")
  elif has("workflow_run") then (.workflow_run.head_repository.full_name // "")
  else $repo end' "$GITHUB_EVENT_PATH")"

if [[ "$head" != "$GITHUB_REPOSITORY" ]]; then
  refusal="This self-hosted runner only runs code from $GITHUB_REPOSITORY; refusing ${GITHUB_EVENT_NAME:-this} job ${GITHUB_RUN_ID:-} from ${head:-an unknown repository}."
  echo "::error::$refusal"
  # the job's log never reaches GitHub once its worker is killed: say it in the container's own
  # output too, which the launcher's journal keeps
  echo "[job-started] $refusal" 2>/dev/null >/proc/1/fd/2 || true
  # A failing hook only fails its own step: runner v2.338 still runs the job's `if: always()` and
  # `if: failure()` steps and its actions' post steps. So end the job here: SIGKILL the
  # Runner.Worker that runs it (an ancestor of this hook), which leaves no step to run.
  pid=$PPID
  while [[ "$pid" -gt 1 ]]; do
    parent="$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/$pid/status" 2>/dev/null)" || break
    if [[ "$(cat "/proc/$pid/comm" 2>/dev/null)" == Runner.Worker ]]; then
      kill -KILL "$pid"
      break
    fi
    pid="${parent:-0}"
  done
  exit 1
fi
echo "Runner guard: ${GITHUB_EVENT_NAME:-job} from $GITHUB_REPOSITORY"
