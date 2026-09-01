import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executableStatements, splitStatements } from './applyMigrations.mjs';

assert.deepEqual(splitStatements("SELECT 'a;b'; -- c;\nSELECT 2;"), ["SELECT 'a;b'", '-- c;\nSELECT 2']);
assert.deepEqual(executableStatements('CREATE DATABASE cmhub; USE cmhub; SELECT 1;'), ['SELECT 1']);

const directory = resolve('../../database');
const migrations = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name)).sort();
assert.equal(migrations.length, 12);
for (const filename of migrations) {
  const statements = executableStatements(await readFile(resolve(directory, filename), 'utf8'));
  assert.ok(statements.length > 0, `${filename} must contain executable application-schema SQL`);
  assert.ok(statements.every(statement => !/^(?:CREATE\s+DATABASE|USE\s+|CREATE\s+USER|GRANT\s+|FLUSH\s+PRIVILEGES)/i.test(statement.trim())));
}
console.log(`validated ${migrations.length} portable migrations`);
