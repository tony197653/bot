import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBatch, validateSchemaStructure } from '../js/schema.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const batchPath = path.join(dir, '../test-data/fake-batch.json');
const raw = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
const struct = validateSchemaStructure(raw);
if (!struct.ok) {
  console.error('schema structure failed:', struct.errors);
  process.exit(1);
}
const val = validateBatch(raw);
if (val.schemaErrors?.length) {
  console.error('validateBatch schema:', val.schemaErrors);
  process.exit(1);
}
if (!val.ok) {
  console.error('validateBatch flags:', val.flaggedCount);
  process.exit(1);
}

// 驗收 3：把 confidence 改成 0.5 → LOW_CONFIDENCE
const low = structuredClone(raw);
low.questions[0].extract.confidence = 0.5;
const lowVal = validateBatch(low);
const qid0 = low.questions[0].id;
if (!lowVal.flags[qid0]?.includes('LOW_CONFIDENCE')) {
  console.error('expected LOW_CONFIDENCE on', qid0, lowVal.flags[qid0]);
  process.exit(1);
}

// schema.json 範例一（結構＋無紅標）
const schema = JSON.parse(fs.readFileSync(path.join(dir, '../plan/schema.json'), 'utf8'));
const ex1 = schema.examples[0];
const ex1v = validateBatch(ex1);
if (ex1v.exitCode === 2) {
  console.error('example1 schema errors', ex1v.schemaErrors);
  process.exit(1);
}
if (ex1v.exitCode !== 0) {
  console.error('example1 unexpected flags', ex1v.flags, ex1v.batchFlags);
  process.exit(1);
}

console.log('schema.test OK:', raw.questions.length, 'questions; LOW_CONFIDENCE ok; example1 ok');
