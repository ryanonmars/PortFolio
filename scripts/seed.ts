import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from '../packages/db/src/index.js';
import { seedDemo } from '../packages/db/src/demo.js';

if (
  !['development', 'test'].includes(process.env.NODE_ENV ?? '') ||
  !process.env.DATA_DIR
) {
  throw new Error(
    'Set NODE_ENV=development (or test) and an explicit DATA_DIR to seed a demo',
  );
}
const fixture: unknown = JSON.parse(
  readFileSync(resolve('examples/sample-site.json'), 'utf8'),
);
const db = openDatabase({ dataDir: process.env.DATA_DIR });
try {
  const summary = seedDemo(db, fixture);
  console.log(JSON.stringify(summary));
  console.log(
    'Synthetic network records and reciprocal connections created. No administrator credentials were created.',
  );
} finally {
  db.close();
}
