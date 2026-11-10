export async function readSQLite(file, read) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=1');
    return read(db);
  } finally { db.close(); }
}
