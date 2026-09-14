#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { printf 'UAT release verification: %s\n' "$1" >&2; exit 1; }
stage="${1:-}"
[[ "$stage" == before || "$stage" == after ]] || die 'expected before or after'
[[ "${UAT_RUN_ID:-}" =~ ^[a-z0-9][a-z0-9-]{5,100}$ ]] || die 'invalid UAT_RUN_ID'
[[ "${EXPECTED_REVISION:-}" =~ ^[a-f0-9]{40}$ ]] || die 'EXPECTED_REVISION must be a full lowercase SHA'
for name in INGEST_HOST INGEST_HOST_USER INGEST_HOST_SSH_PORT INGEST_HOST_SSH_PRIVATE_KEY INGEST_HOST_KNOWN_HOSTS; do
  [[ -n "${!name:-}" ]] || die "$name is required"
done
[[ "$INGEST_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || die 'invalid INGEST_HOST'
[[ "$INGEST_HOST_USER" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_-]*$ ]] || die 'invalid INGEST_HOST_USER'
if ! [[ "$INGEST_HOST_SSH_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$INGEST_HOST_SSH_PORT > 65535 )); then
  die 'invalid INGEST_HOST_SSH_PORT'
fi
directory="$(mktemp -d)"
trap 'rm -rf "$directory"' EXIT
printf '%s\n' "$INGEST_HOST_SSH_PRIVATE_KEY" > "$directory/key"
printf '%s\n' "$INGEST_HOST_KNOWN_HOSTS" > "$directory/known_hosts"
evidence="e2e/uat/journey-runs/$UAT_RUN_ID/ingest-release-$stage.json"
mkdir -p "$(dirname "$evidence")"
if ! ssh -F /dev/null -i "$directory/key" -p "$INGEST_HOST_SSH_PORT" \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$directory/known_hosts" -o GlobalKnownHostsFile=/dev/null \
  -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 \
  "$INGEST_HOST_USER@$INGEST_HOST" "python3 - $EXPECTED_REVISION" > "$evidence" <<'PY'
import datetime
import json
from pathlib import Path
import re
import subprocess
import sys

revision = sys.argv[1]
state = Path('/opt/capy-ingest/releases/nonprod')
project = 'capy-ingest-nonprod'

def require(condition, message):
    if not condition:
        raise ValueError(message)

def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=20, check=False)
    require(result.returncode == 0, 'read-only host inspection failed')
    return result.stdout.strip()

try:
    active = (state / 'active').read_text().strip()
    require(active == revision, 'nonprod active revision mismatch')
    require(not (state / 'pending').exists(), 'nonprod release is pending')
    current = (state / 'current').resolve(strict=True)
    require(current.parent == state and current.name.startswith('config-'), 'invalid current snapshot')
    require((current / 'nonprod.env').is_file() and (current / 'uat.queue.env').is_file(), 'missing current configuration')
    require(command('git', '-C', '/opt/capy-ingest/app-nonprod', 'rev-parse', 'HEAD') == revision, 'ingest checkout revision mismatch')
    containers = []
    for service in ('parser', 'parse-coordinator-uat', 'worker-uat', 'import-worker-uat', 'host-sampler-uat'):
        ids = command('docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={project}', '--filter', f'label=com.docker.compose.service={service}').splitlines()
        require(len(ids) == 1, f'{service} must have exactly one container')
        identity = json.loads(command('docker', 'inspect', '--format', '{{json .Id}}', ids[0]))
        image = json.loads(command('docker', 'inspect', '--format', '{{json .Image}}', ids[0]))
        actual = command('docker', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', ids[0])
        image_revision = command('docker', 'image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', image)
        running = command('docker', 'inspect', '--format', '{{.State.Running}}', ids[0])
        require(re.fullmatch('[a-f0-9]{64}', identity) and re.fullmatch('sha256:[a-f0-9]{64}', image), 'invalid container identity')
        require(actual == revision and image_revision == revision and running == 'true', f'{service} is not running the candidate image')
        if service == 'parser':
            require(command('docker', 'inspect', '--format', '{{.State.Health.Status}}', ids[0]) == 'healthy', 'parser is not healthy')
        containers.append({'service': service, 'containerId': identity, 'imageId': image, 'revision': actual})
    print(json.dumps({'environment': 'uat', 'activeRevision': active, 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'containers': containers}, indent=2))
except (OSError, ValueError, subprocess.TimeoutExpired) as error:
    message = str(error) if type(error) is ValueError else 'host inspection unavailable'
    print('UAT ingest release verification failed: ' + message, file=sys.stderr)
    sys.exit(1)
PY
then
  printf '{"status":"failed","stage":"%s"}\n' "$stage" > "$evidence"
  die 'ingest release mismatch or unavailable verification; deploy UAT ingest separately for this candidate'
fi
echo "Verified UAT ingest release ($stage); image identities saved in run evidence."
