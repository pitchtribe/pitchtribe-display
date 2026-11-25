#!/usr/bin/env bash
# Bundle an immutable Git revision, never local data or untracked files.
set -euo pipefail
repo=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
output=${1:?Usage: home-assistant/package.sh OUTPUT_DIRECTORY [GIT_REVISION]}
revision=$(git -C "$repo" rev-parse "${2:-HEAD}^{commit}")
mkdir -p "$output"
output=$(cd "$output" && pwd)
stage=$(mktemp -d "$output/.pitchtribe-package.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/pitchtribe/source"
cp "$repo/home-assistant/pitchtribe/"* "$stage/pitchtribe/"
git -C "$repo" archive "$revision" app signage-server | tar -x -C "$stage/pitchtribe/source"
printf '%s\n' "$revision" > "$stage/pitchtribe/SOURCE_REVISION"
tar -czf "$output/pitchtribe-home-assistant.tar.gz" -C "$stage" pitchtribe
printf '%s\n' "$output/pitchtribe-home-assistant.tar.gz"
