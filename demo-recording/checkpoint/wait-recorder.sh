#!/usr/bin/env bash
set -euo pipefail
for _ in $(seq 1 900); do
  if [ -f tests/.tmp/demo-recorder-exit ]; then
    code="$(cat tests/.tmp/demo-recorder-exit)"
    case "$code" in 0) echo 'Recorder completed successfully'; exit 0;; *) echo 'Recorder failed; inspect its sanitized video and public checkpoint'; exit 1;; esac
  fi
  sleep 1
done
echo 'Recorder completion deadline exceeded'
exit 1
