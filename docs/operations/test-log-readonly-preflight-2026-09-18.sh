#!/usr/bin/env bash
set -Eeuo pipefail
test "$(curl --noproxy '*' --fail --silent --max-time 3 http://metadata.tencentyun.com/latest/meta-data/instance-id)" = ins-nm8jebfh
cd /opt/cmhub-api-test/services/cloud-api
node --input-type=module <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
const env=dotenv.parse(fs.readFileSync('.env'));
assert.equal(env.MYSQL_DATABASE,'tyg_integration_test');
assert.equal(env.API_KEY_ENVIRONMENT,'test');
assert.equal(env.COS_PREFIX,'test');
assert.equal(env.OUTBOUND_WEBHOOK_ENABLED,'false');
const sha=p=>fs.existsSync(p)?createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;
const files=['src/auth.ts','src/db.ts','src/index.ts','src/integrationLogs.ts','src/warehouseAccess.ts','src/tygV11.ts','src/warehouseHttp.ts','dist/auth.js','dist/db.js','dist/index.js','dist/integrationLogs.js','dist/warehouseAccess.js','dist/tygV11.js','dist/warehouseHttp.js','package.json','package-lock.json'];
const c=await mysql.createConnection({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT||3306),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,database:env.MYSQL_DATABASE});
try {
  await c.query('SET SESSION MAX_EXECUTION_TIME=5000');
  await c.query('START TRANSACTION READ ONLY');
  const [migrations]=await c.query('SELECT * FROM schema_migrations ORDER BY 1');
  const [tables]=await c.query("SHOW TABLES LIKE 'integration_push%'");
  const [permissions]=await c.query("SELECT permission_code FROM warehouse_permissions WHERE permission_code='integration_logs.view'");
  await c.rollback();
  const health=await fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(5000)});
  const deployedFile='/opt/cmhub-api-test/.deployed-sha';
  console.log('TEST_LOG_PREFLIGHT='+JSON.stringify({at:new Date().toISOString(),node:process.version,testIsolation:true,gitHead:execFileSync('git',['-C','/opt/cmhub-api-test','rev-parse','HEAD'],{encoding:'utf8'}).trim(),deployedSha:fs.existsSync(deployedFile)?fs.readFileSync(deployedFile,'utf8').trim():null,source:Object.fromEntries(files.map(p=>[p,sha(p)])),migrations,logTableCount:tables.length,logPermissionCount:permissions.length,healthStatus:health.status,origins:env.WAREHOUSE_ALLOWED_ORIGINS}));
} finally {await c.end();}
NODE
