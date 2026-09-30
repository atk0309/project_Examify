#!/usr/bin/env bash
set +e
pnpm exec playwright test -c demo-recording/playwright.config.ts > tests/.tmp/demo-private-runtime.log 2>&1
code=$?
printf '%s\n' "$code" > tests/.tmp/demo-recorder-exit.tmp
mv tests/.tmp/demo-recorder-exit.tmp tests/.tmp/demo-recorder-exit
exit "$code"
