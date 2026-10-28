import { resolve } from 'node:path';
import {
  backupDatabase,
  openDatabase,
  restoreDatabase,
} from '../packages/db/src/index.js';

const command = process.argv[2];
if (command === 'restore') {
  if (!process.argv[3] || !process.env.DATA_DIR) {
    console.error(
      'Usage: DATA_DIR=/new/empty/directory pnpm db:restore /path/to/snapshot.sqlite',
    );
    process.exitCode = 1;
  } else {
    try {
      await restoreDatabase(process.argv[3], process.env.DATA_DIR);
      console.log(
        'Snapshot restored into the new data directory. Start PortFolio using this directory.',
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Recovery failed');
      process.exitCode = 1;
    }
  }
} else if (command !== 'migrate' && command !== 'backup') {
  console.error(
    'Usage: pnpm db:migrate | pnpm db:backup [destination.sqlite] | DATA_DIR=/new/directory pnpm db:restore snapshot.sqlite',
  );
  process.exitCode = 1;
} else {
  const dataDir = resolve(process.env.DATA_DIR ?? './data');
  const db = openDatabase({ dataDir });
  try {
    if (command === 'backup') {
      const destination = resolve(
        process.argv[3] ??
          `${dataDir}/backups/portfolio-${new Date().toISOString().replaceAll(':', '-')}.sqlite`,
      );
      await backupDatabase(db, destination);
      console.log(`Backup created: ${destination}`);
      console.log('Backups contain private application data; store securely.');
    } else {
      console.log('Database migrations applied.');
    }
  } finally {
    db.close();
  }
}
