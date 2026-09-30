#!/usr/bin/env bash
set -euo pipefail
mkdir -p tests/.tmp demo-recording/evidence
rm -f tests/.tmp/demo-recorder-exit tests/.tmp/demo-recorder-exit.tmp tests/.tmp/demo-checkpoint-ready
if [ "${DEMO_MODE:-}" = live ]; then
  [ "${GITHUB_RUN_ATTEMPT:-}" = 1 ] || { echo 'Live reruns are refused'; exit 1; }
  node --input-type=module -e "import {sessionDeadline} from './demo-recording/session-window.mjs'; sessionDeadline('live',process.env.DEMO_EXPIRES_AT); for(const name of ['OPENAI_API_KEY','ANTHROPIC_API_KEY']){const key=process.env[name];if(!key||!key.trim()||key.trim()==='test')throw Error('Both temporary provider keys are required');}"
  node demo-recording/checkpoint/seed-original-budget.mjs
else
  # A single fixed timestamp for this no-key rehearsal, inherited by the child.
  export DEMO_EXPIRES_AT="$(date -u -d '+15 minutes' +%Y-%m-%dT%H:%M:%SZ)"
fi
setsid bash demo-recording/checkpoint/record-background.sh </dev/null >/dev/null 2>&1 &
node demo-recording/checkpoint/register-recorder.mjs "$!"
for _ in $(seq 1 360); do
  if [ -f tests/.tmp/demo-checkpoint-ready ]; then echo 'Public synthetic question checkpoint is ready'; exit 0; fi
  if [ -f tests/.tmp/demo-recorder-exit ]; then echo 'Recorder stopped before its public question checkpoint'; exit 1; fi
  sleep 1
done
echo 'Recorder did not reach its public question checkpoint in six minutes'
exit 1
