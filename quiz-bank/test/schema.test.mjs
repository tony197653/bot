/**
 * Schema／紅標：fake-batch、schema examples、JS ↔ validate_batch.py 同輸入對照（驗收 4）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateBatch, validateSchemaStructure } from '../js/schema.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const batchPath = path.join(root, 'test-data/fake-batch.json');
const dumpPy = path.join(root, 'plan/tools/dump_flags.py');

let failed = 0;
function pass(name) {
  console.log('PASS', name);
}
function fail(name, err) {
  failed++;
  console.error('FAIL', name, err);
}

function pyFlags(filePath) {
  const r = spawnSync('python3', [dumpPy, filePath], { encoding: 'utf8' });
  if (r.status !== 0 && !r.stdout) {
    throw new Error(`dump_flags failed: ${r.stderr || r.error}`);
  }
  return JSON.parse(r.stdout);
}

function assertFlagParity(label, data, fileForPy) {
  const js = validateBatch(data);
  let tmp = fileForPy;
  let cleanup = null;
  if (!tmp) {
    tmp = path.join(root, 'test-artifacts', `_parity-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    cleanup = tmp;
  }
  try {
    const py = pyFlags(tmp);
    if (js.exitCode !== py.exitCode) {
      throw new Error(`exitCode js=${js.exitCode} py=${py.exitCode}`);
    }
    if (js.exitCode === 2) return;
    const jsFlags = JSON.stringify(js.flags);
    const pyFlagsStr = JSON.stringify(py.flags);
    if (jsFlags !== pyFlagsStr) {
      throw new Error(`flags differ\nJS ${jsFlags}\nPY ${pyFlagsStr}`);
    }
    const jb = JSON.stringify([...(js.batchFlags || [])].sort());
    const pb = JSON.stringify([...(py.batchFlags || [])].sort());
    if (jb !== pb) throw new Error(`batchFlags differ\nJS ${jb}\nPY ${pb}`);
    pass(label);
  } finally {
    if (cleanup) try { fs.unlinkSync(cleanup); } catch { /* ignore */ }
  }
}

// --- structure ---
{
  const raw = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
  const struct = validateSchemaStructure(raw);
  if (!struct.ok) {
    fail('fake-batch structure', struct.errors);
  } else {
    pass('fake-batch structure');
  }
  const val = validateBatch(raw);
  if (val.schemaErrors?.length || !val.ok) {
    fail('fake-batch clean', val.flags || val.schemaErrors);
  } else {
    pass('fake-batch clean flags');
  }
  assertFlagParity('acceptance4 fake-batch JS==Python', raw, batchPath);

  const low = structuredClone(raw);
  low.questions[0].extract.confidence = 0.5;
  const lowVal = validateBatch(low);
  const qid0 = low.questions[0].id;
  if (!lowVal.flags[qid0]?.includes('LOW_CONFIDENCE')) {
    fail('LOW_CONFIDENCE', lowVal.flags[qid0]);
  } else {
    pass('acceptance3 LOW_CONFIDENCE');
  }
  assertFlagParity('acceptance4 LOW_CONFIDENCE JS==Python', low, null);

  const mismatch = structuredClone(raw);
  mismatch.batch.expectedCount = raw.questions.length + 3;
  assertFlagParity('acceptance4 COUNT_MISMATCH JS==Python', mismatch, null);

  const schema = JSON.parse(fs.readFileSync(path.join(root, 'plan/schema.json'), 'utf8'));
  const ex1 = schema.examples[0];
  const ex1v = validateBatch(ex1);
  if (ex1v.exitCode === 2) fail('example1 schema', ex1v.schemaErrors);
  else if (ex1v.exitCode !== 0) fail('example1 flags', ex1v.flags);
  else pass('schema example1 clean');
  assertFlagParity('acceptance4 example1 JS==Python', ex1, null);
}

console.log(`\nschema.test ${failed ? 'FAILED' : 'OK'}`);
process.exit(failed ? 1 : 0);
