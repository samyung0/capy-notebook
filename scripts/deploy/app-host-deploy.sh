#!/usr/bin/env bash
# The app host's deploy command, installed as /usr/local/sbin/capy-app-deploy
# by deploy/ansible/app-host (tag deploy). The CI deploy key's forced command
# runs it through sudo, which keeps only SSH_ORIGINAL_COMMAND; that must be
# exactly `deploy app|ops <full lowercase SHA>`. stdin carries a tar of exactly
# compose.yml, stack.env and ghcr-token (the registry user, then the deploy
# job's own token, one per line). The exit status is the result; the script
# prints one line per service and never prints logs or configuration values.
set -euo pipefail
umask 077
# Once started, a deploy finishes even if the runner goes away: a stack left
# between `stop` and `up` is worse than an unread summary.
trap '' HUP PIPE

fail() {
  printf 'capy-app-deploy: %s\n' "$1" >&2
  exit 1
}

if [[ ! "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ (app|ops)\ ([0-9a-f]{40})$ ]]; then
  printf 'usage: deploy app|ops <full lowercase SHA>\n' >&2
  exit 2
fi
stack="${BASH_REMATCH[1]}"
sha="${BASH_REMATCH[2]}"
if [[ "$stack" == app ]]; then
  project=capy
  services=(migrate server collaboration retrieval)
else
  project=capy-ops
  services=(ops)
fi

# The tests point these at a temporary directory; sudo never passes them.
home="${CAPY_DEPLOY_ROOT:-/opt/capy}/$stack"
mkdir -p "$home/releases"
exec 9>"$home/.lock"
flock -n 9 || fail "another $stack deploy is running"
incoming="$(mktemp -d "${CAPY_DEPLOY_RUN:-/run}/capy-deploy.XXXXXX")"
trap 'rm -rf -- "$incoming"' EXIT
files="$incoming/files"
mkdir "$files"

# The upload: at most 1 MiB, exactly the three names, regular files only.
head -c 1048577 >"$incoming/upload.tar"
(($(stat -c %s "$incoming/upload.tar") <= 1048576)) || fail "the upload is larger than 1 MiB"
members="$(tar -tf "$incoming/upload.tar" 2>/dev/null | LC_ALL=C sort | tr '\n' ' ')" || true
[[ "$members" == "compose.yml ghcr-token stack.env " ]] ||
  fail "the upload must hold exactly compose.yml, stack.env and ghcr-token"
tar -xf "$incoming/upload.tar" -C "$files" --no-same-owner --no-same-permissions \
  compose.yml stack.env ghcr-token 2>/dev/null || fail "the upload could not be unpacked"
for name in compose.yml stack.env ghcr-token; do
  [[ -f "$files/$name" && ! -L "$files/$name" && "$(stat -c %h "$files/$name")" == 1 ]] ||
    fail "$name must be a regular file"
done
grep -qxF "RELEASE_SHA='$sha'" "$files/stack.env" || fail "stack.env is not rendered for $sha"

# Compose's own output stays hidden: the resolved configuration holds secrets.
dc() { docker compose -p "$project" -f "$files/compose.yml" --env-file "$files/stack.env" "$@"; }
dc config --quiet >/dev/null 2>&1 || fail "compose.yml and stack.env do not make a valid configuration"
mapfile -t images < <(dc config --images 2>/dev/null | grep '^ghcr\.io/' | LC_ALL=C sort -u)
((${#images[@]} > 0)) || fail "compose.yml names no GHCR image"

# Pull with a throwaway registry login; the job token dies with the job.
mapfile -t login <"$files/ghcr-token"
[[ ${#login[@]} == 2 && "${login[0]}" =~ ^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$ && -n "${login[1]}" ]] ||
  fail "ghcr-token must hold the registry user and the token"
mkdir "$incoming/docker"
printf '%s' "${login[1]}" | DOCKER_CONFIG="$incoming/docker" docker login ghcr.io -u "${login[0]}" --password-stdin >/dev/null 2>&1 ||
  fail "logging in to ghcr.io failed"
# Only the app images: Postgres and Redis stay on their pinned local images.
DOCKER_CONFIG="$incoming/docker" dc pull --quiet "${services[@]}" >/dev/null 2>&1 || fail "pulling the $stack images failed"
rm -rf -- "$incoming/docker" "$files/ghcr-token"
unset login
for image in "${images[@]}"; do
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image" 2>/dev/null)" ||
    fail "$image is missing after the pull"
  [[ "$revision" == "$sha" ]] || fail "$image is labelled ${revision:-without a revision}, not $sha"
done

# One line per service: name, state, health, exit code, image revision.
service_lines() {
  local service id
  for service in "${services[@]}"; do
    id="$(docker ps -a -q --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=$service" | head -n 1)"
    if [[ -z "$id" ]]; then
      printf '%s missing - - -\n' "$service"
      continue
    fi
    docker inspect --format "$service"' {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} {{.State.ExitCode}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$id"
  done
}

# Nothing has changed until here. Collaboration flushes its rooms through the
# gateway when it stops, so it stops while the old gateway still serves
# (Compose would stop the gateway first). `up` then stops the old gateway and
# retrieval before migrate runs, and starts collaboration once the new gateway
# is healthy.
if [[ "$stack" == app ]]; then
  dc stop collaboration >/dev/null 2>&1 || fail "stopping collaboration failed"
fi
if ! dc up -d --wait --wait-timeout 600 --remove-orphans >/dev/null 2>&1; then
  service_lines >&2 || true
  fail "starting the $stack stack failed (service, state, health, exit code, revision above)"
fi
lines="$(service_lines)" || fail "could not read the service states"
while read -r service state health code revision; do
  if [[ "$service" == migrate ]]; then
    [[ "$state" == exited && "$code" == 0 ]] || fail "migrate did not finish cleanly: $state, exit code $code"
  else
    [[ "$state" == running && ("$health" == healthy || "$health" == -) ]] || fail "$service is $state ($health)"
  fi
  [[ "$revision" == "$sha" ]] || fail "$service runs ${revision:-an unlabelled image}, not $sha"
done <<<"$lines"

# Keep this release for a manual redeploy, then prune: the newest three
# releases (this one and two to roll back to) and their image tags stay.
release="$home/releases/$sha"
rm -rf -- "$release"
mkdir "$release"
cp -- "$files/compose.yml" "$files/stack.env" "$release/"
ln -sfn "releases/$sha" "$home/current"
mapfile -t releases < <(ls -1t -- "$home/releases")
for old in "${releases[@]:3}"; do
  if [[ "$old" =~ ^[0-9a-f]{40}$ ]]; then rm -rf -- "${home:?}/releases/$old"; fi
done
kept=" ${releases[*]:0:3} "
for image in "${images[@]}"; do
  repository="${image%:*}"
  while read -r tag; do
    if [[ "$kept" != *" ${tag:0:40} "* ]] && ! docker rmi -- "$repository:$tag" >/dev/null 2>&1; then
      printf 'capy-app-deploy: could not remove %s:%s\n' "$repository" "$tag" >&2
    fi
  done < <(docker image ls --format '{{.Tag}}' "$repository" | grep -E '^[0-9a-f]{40}' || true)
done
docker image prune -f >/dev/null 2>&1 || printf 'capy-app-deploy: docker image prune failed\n' >&2

printf '%s\n' "$lines"
printf 'capy-app-deploy: %s is running %s\n' "$stack" "$sha"
