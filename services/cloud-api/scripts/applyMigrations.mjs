import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    current += char;
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') {
        current += next ?? '';
        index += 1;
      } else if (char === quote) {
        if (next === quote && quote !== '`') {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === '-' && next === '-' && /\s/.test(sql[index + 2] ?? '')) {
      current += next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === '#') {
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      current += next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === ';') {
      const statement = current.slice(0, -1).trim();
      if (statement) statements.push(statement);
      current = '';
    }
  }
  if (quote || blockComment) throw new Error('Migration SQL ended inside a string or block comment.');
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function withoutLeadingComments(statement) {
  return statement
    .replace(/^(?:\s*--[^\n]*(?:\n|$)|\s*#[^\n]*(?:\n|$)|\s*\/\*[\s\S]*?\*\/)+/, '')
    .trim();
}

export function executableStatements(sql) {
  return splitStatements(sql).filter(statement => {
    const command = withoutLeadingComments(statement);
    return command && !/^(?:CREATE\s+DATABASE|USE\s+|CREATE\s+USER|GRANT\s+|FLUSH\s+PRIVILEGES)/i.test(command);
  });
}

async function main() {
  const migrationDirectory = resolve(process.argv[2] || '../../database');
  const filenames = (await readdir(migrationDirectory))
    .filter(name => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (filenames.length === 0) throw new Error(`No numbered SQL migrations found in ${migrationDirectory}`);

  const connection = await mysql.createConnection({
    host: required('MYSQL_HOST'),
    port: Number(process.env.MYSQL_PORT || 3306),
    database: required('MYSQL_DATABASE'),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
    ssl: process.env.MYSQL_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  });

  try {
    await connection.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) NOT NULL,
      sha256 CHAR(64) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (filename)
    ) ENGINE=InnoDB
    `);
    const [rows] = await connection.execute('SELECT filename, sha256 FROM schema_migrations');
    const applied = new Map(rows.map(row => [row.filename, row.sha256]));

    for (const filename of filenames) {
      const sql = await readFile(resolve(migrationDirectory, filename), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(filename);
      if (previous) {
        if (previous !== sha256) throw new Error(`Applied migration checksum changed: ${filename}`);
        console.log(`already applied ${filename}`);
        continue;
      }
      console.log(`applying ${filename}`);
      for (const statement of executableStatements(sql)) await connection.query(statement);
      await connection.execute(
        'INSERT INTO schema_migrations (filename, sha256) VALUES (?, ?)',
        [filename, sha256],
      );
      console.log(`applied ${filename}`);
    }
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
