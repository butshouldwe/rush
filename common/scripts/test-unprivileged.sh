#!/usr/bin/env bash
# Run a project's unit tests as an unprivileged user.
#
# CI containers run as root, and root ignores file modes, so any test that proves a
# permission refusal passes vacuously there. This script drops to a dedicated uid before
# running the project's test runner (vitest) so those tests are real. Locally, where the
# caller is already unprivileged, it runs the tests directly.
#
# Usage: common/scripts/test-unprivileged.sh <projectFolder>
# The project's test runner may write only under <projectFolder>/temp,
# <projectFolder>/node_modules/.vite-temp and $TMPDIR; those are handed to the test user.
set -euo pipefail
project="${1:?usage: test-unprivileged.sh <projectFolder>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root/$project"
# Run the package's own test phase; `rush install` has already provisioned node_modules.
runner=(node_modules/.bin/vitest run)
if [ "$(id -u)" != 0 ]; then
  exec "${runner[@]}"
fi
user=rush-tests
if ! id "$user" >/dev/null 2>&1; then
  useradd --system --create-home --uid 10001 --shell /usr/sbin/nologin "$user"
fi
home="$(getent passwd "$user" | cut -d: -f6)"
[ -n "$home" ] && [ "$home" != "/" ] || { echo "test-unprivileged: $user has no usable home directory" >&2; exit 1; }
tmp="$home/tmp"
mkdir -p temp node_modules/.vite-temp "$tmp"
chown -R "$user" temp node_modules/.vite-temp "$tmp"
exec setpriv --reuid="$user" --regid="$user" --init-groups \
  env HOME="$home" TMPDIR="$tmp" PATH="$PATH" "${runner[@]}"
