import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const preload = new URL('./budget-preload.mjs', import.meta.url).href;
function run(body, mode = 'live') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examify-budget-test-'));
  try {
    return JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', body], {
        env: {
          PATH: process.env.PATH,
          DEMO_MODE: mode,
          DEMO_BUDGET_DIR: dir,
          DEMO_EXPIRES_AT: new Date(Date.now() + 60 * 60 * 1000)
            .toISOString()
            .replace(/\.\d{3}Z$/, 'Z'),
        },
        encoding: 'utf8',
      }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const intro = `let calls=0; let redirects=[]; globalThis.fetch=async(_, init)=> { calls++; redirects.push(init.redirect); return new Response(JSON.stringify({usage:{prompt_tokens:20,completion_tokens:10}}),{status:200}); }; await import(${JSON.stringify(preload)}); const url='https://api.openai.com/v1/chat/completions'; const init={method:'POST',body:JSON.stringify({model:'gpt-4o',messages:[{role:'user',content:'synthetic'}]})};`;
test('preload permits exactly eight real forwarding calls and disables redirects', () => {
  const r = run(
    intro +
      `let refused=0; for(let i=0;i<10;i++){try{await fetch(url,init);}catch{refused++;}} console.log(JSON.stringify({calls,refused,redirects}));`,
  );
  assert.equal(r.calls, 8);
  assert.equal(r.refused, 2);
  assert.ok(r.redirects.every((x) => x === 'error'));
});
test('rehearsal forwards zero provider requests', () => {
  const r = run(
    intro +
      `let refused=false;try{await fetch(url,init);}catch{refused=true;} console.log(JSON.stringify({calls,refused}));`,
    'stub',
  );
  assert.deepEqual(r, { calls: 0, refused: true });
});
test('missing usage halts further calls without retrying', () => {
  const r = run(
    intro.replace('prompt_tokens:20,completion_tokens:10', '') +
      `let refused=0; for(let i=0;i<2;i++){try{await fetch(url,init);}catch{refused++;}} console.log(JSON.stringify({calls,refused}));`,
  );
  assert.deepEqual(r, { calls: 1, refused: 2 });
});

test('transport failure halts future calls; consumed slot is never refunded', () => {
  const source = intro.replace(
    'return new Response(JSON.stringify({usage:{prompt_tokens:20,completion_tokens:10}}),{status:200});',
    "throw new Error('synthetic timeout');",
  );
  const r = run(
    source +
      `let refused=0; for(let i=0;i<2;i++){try{await fetch(url,init);}catch{refused++;}} console.log(JSON.stringify({calls,refused}));`,
  );
  assert.deepEqual(r, { calls: 1, refused: 2 });
});

test('loopback forwarding also refuses redirects', () => {
  const r = run(
    intro +
      `await fetch('http://127.0.0.1:3115/api/health', {}); console.log(JSON.stringify({calls,redirects}));`,
  );
  assert.deepEqual(r, { calls: 1, redirects: ['error'] });
});

test('synthetic credential canary is absent from stdout and budget/process records', () => {
  const marker = 'SYNTHETIC_SECRET_CANARY_DO_NOT_LOG';
  const source =
    `process.env.OPENAI_API_KEY=${JSON.stringify(marker)};` +
    intro +
    `
    init.headers={authorization:'Bearer '+process.env.OPENAI_API_KEY};
    await fetch(url,init);
    const fs=await import('node:fs'); const path=await import('node:path');
    const files=fs.readdirSync(process.env.DEMO_BUDGET_DIR).map(name=>fs.readFileSync(path.join(process.env.DEMO_BUDGET_DIR,name),'utf8'));
    console.log(JSON.stringify({calls,safe:files.every(text=>!text.includes(process.env.OPENAI_API_KEY))}));`;
  const result = run(source);
  assert.deepEqual(result, { calls: 1, safe: true });
  assert.ok(!JSON.stringify(result).includes(marker));
});
