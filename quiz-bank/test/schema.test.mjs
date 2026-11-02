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
console.log('schema.test OK:', raw.questions.length, 'questions');
