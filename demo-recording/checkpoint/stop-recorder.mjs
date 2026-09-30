import fs from 'node:fs';
import path from 'node:path';
import { stopOwned } from './process-records.mjs';
const files = ['tests/.tmp/demo-recorder-process.json'];
const ledger = 'tests/.tmp/demo-budget';
if (fs.existsSync(ledger))
  for (const name of fs.readdirSync(ledger))
    if (/^server-process-\d+\.json$/.test(name)) files.push(path.join(ledger, name));
const records = [];
for (const file of files)
  if (fs.existsSync(file)) {
    try {
      records.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      throw Error('demo_process_record_invalid');
    }
  }
await stopOwned(records);
console.log('Recorded app/recorder process identities are stopped.');
