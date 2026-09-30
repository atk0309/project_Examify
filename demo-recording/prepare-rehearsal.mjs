// This adapts only a disposable no-key runner's deterministic test fixtures.
// Never used for live provider generation/grading; not a product patch.
import fs from 'node:fs';
if (process.env.DEMO_MODE !== 'stub') throw Error('rehearsal_mode_required');
for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
  if (process.env[name] && process.env[name] !== 'test')
    throw Error('real_keys_forbidden_in_rehearsal');
}
const bank = JSON.parse(fs.readFileSync('demo-recording/fixtures/bank.json', 'utf8'));
fs.writeFileSync(
  'tools/examify-ingest/src/providers/test.ts',
  `
import { bankIrSchema } from '../schema';
import { throwIfAborted, type GenerateProvider, type ProviderRequest } from './types';
export function buildTestBank(request: ProviderRequest) {
  if (request.subject.id !== 'demo') throw Error('demo_subject_only');
  return bankIrSchema.parse({version:1, subject:request.subject, difficulties:${JSON.stringify(bank)},meta:{provider:'test',promptVersion:request.promptVersion,seed:request.seed}});
}
export const testProvider: GenerateProvider = {
 id:'test', defaultModel:'scripted-cell-biology', keyEnv:null, seedHonored:true,
 requireReady:()=>undefined,
 generate:(request,deps)=>{throwIfAborted(deps.signal);return Promise.resolve(buildTestBank(request));}
};
`,
);
const file = 'src/lib/grading/shared.ts';
const original = fs.readFileSync(file, 'utf8');
const old = /export function stubGrade\(args: GradeArgs\): GradeResult \{[\s\S]*?\n\}\n/;
if (!old.test(original)) throw Error('stub_grade_fixture_target_changed');
fs.writeFileSync(
  file,
  original.replace(
    old,
    `export function stubGrade(args: GradeArgs): GradeResult {
  const answer = args.studentAnswer.toLowerCase();
  const chloroplasts = /chloroplast/.test(answer) && /light/.test(answer) && /sugar/.test(answer);
  const mitochondria = /mitochondri/.test(answer) && /energy/.test(answer) && /food/.test(answer);
  const score = (Number(chloroplasts) + Number(mitochondria)) * args.maxScore / 2;
  return { status:'graded', verdict:{
    score, verdict:'Scripted rehearsal feedback',
    gotRight:[...(chloroplasts ? ['Chloroplasts use light to make sugar.'] : []), ...(mitochondria ? ['Mitochondria release energy from food.'] : [])],
    toReview:[...(!chloroplasts ? ['Explain how chloroplasts use light to make sugar.'] : []), ...(!mitochondria ? ['Explain how mitochondria release energy from food.'] : [])],
    spelling:[]
  }};
}
`,
  ),
);
fs.writeFileSync('.demo-fixture-active', 'scripted-cell-biology\n');
console.log(
  'Prepared explicitly scripted cell-biology generation and rubric-based rehearsal marking.',
);
