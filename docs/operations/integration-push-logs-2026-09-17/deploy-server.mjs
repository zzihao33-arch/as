// Run in the guarded staging directory, with DBA_PASSWORD supplied in memory by
// the existing panel credential provider. Never prints configuration or secrets.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const stage=process.cwd(), app='/www/wwwroot/cloud-api';
assert.match(stage,/^\/root\/cmhub-push-logs-20260917-[a-f0-9]{7}$/);
const require=createRequire(app+'/package.json');
const mysql=require('mysql2/promise');
const env=require('dotenv').parse(fs.readFileSync(app+'/.env'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const normalized=p=>hash(fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n'));
const manifest=JSON.parse(fs.readFileSync(stage+'/release-manifest.json','utf8'));
assert.equal(manifest.commit,'ca05db3b5a6473c158121047a04d8dea50abc594');
assert.deepEqual(manifest.files.map(x=>x.file),['src/auth.ts','src/db.ts','src/index.ts','src/integrationLogs.ts','src/warehouseAccess.ts']);
const source=stage+'/services/cloud-api';
const hotfix='f9b3a0c324817a35ba262f997b4074acaebcc30154ce08ddfa621bc021e4b663';
const envHash=hash(fs.readFileSync(app+'/.env'));
const node='/www/server/nodejs/v20.10.0/bin/node';
const pm2='/www/server/nodejs/v20.10.0/lib/node_modules/pm2/bin/pm2';
const pmEnv={...process.env,PM2_HOME:'/root/.pm2'}; delete pmEnv.DBA_PASSWORD;
const instance=execFileSync('curl',['-q','--noproxy','*','-fsS','--max-time','5','http://metadata.tencentyun.com/latest/meta-data/instance-id'],{encoding:'utf8'}).trim();
assert.equal(instance,'ins-dmx8z3xt');
assert.equal(hash(fs.readFileSync(app+'/dist/tygV11.js')),hotfix);
assert.equal(hash(fs.readFileSync(source+'/dist/tygV11.js')),hotfix);
for(const item of manifest.files){
  assert.match(item.file,/^src\/[A-Za-z0-9]+\.ts$/);
  assert.equal(normalized(source+'/'+item.file),item.after,`Staged source ${item.file}`);
  if(item.before) assert.equal(normalized(app+'/'+item.file),item.before,`Production changed ${item.file}`);
  else assert.equal(fs.existsSync(app+'/'+item.file),false,`New file already exists ${item.file}`);
  execFileSync(node,['--check',source+'/'+item.file.replace(/^src\//,'dist/').replace(/\.ts$/,'.js')],{stdio:'pipe'});
}
const backup=stage+'/backup-'+new Date().toISOString().replace(/[:.]/g,'-');
fs.mkdirSync(backup,{recursive:false,mode:0o700});
const copyFiles=manifest.files.flatMap(x=>[x.file,x.file.replace(/^src\//,'dist/').replace(/\.ts$/,'.js')]);
const originals=[];
for(const file of copyFiles){if(fs.existsSync(app+'/'+file)){
  fs.mkdirSync(path.dirname(backup+'/'+file),{recursive:true,mode:0o700});
  fs.copyFileSync(app+'/'+file,backup+'/'+file); originals.push(file);
}}
fs.writeFileSync(backup+'/release-manifest.json',JSON.stringify(manifest,null,2),{mode:0o600});
const db=await mysql.createConnection({host:'127.0.0.1',user:'root',password:process.env.DBA_PASSWORD,database:'cmhub',timezone:'Z'});
delete process.env.DBA_PASSWORD;
let swapped=false;
try{
  const [[identity]]=await db.query('SELECT @@server_uuid AS uuid');
  assert.equal(identity.uuid,'46247a0c-a280-11f1-9abc-5254005ebf9c');
  const [history]=await db.query('SELECT * FROM schema_migrations ORDER BY filename');
  assert.equal(history.length,17);
  const [newTables]=await db.query("SHOW TABLES LIKE 'integration_push%'"); assert.equal(newTables.length,0);
  const [permissions]=await db.query('SELECT * FROM warehouse_permissions');
  const [rolePermissions]=await db.query('SELECT * FROM warehouse_role_permissions');
  const [grants]=await db.query("SHOW GRANTS FOR 'cmhub_api'@'127.0.0.1'");
  fs.writeFileSync(backup+'/database-before.json',JSON.stringify({history,permissions,rolePermissions,grants},null,2),{mode:0o600});
  const {executableStatements,splitStatements}=await import(pathToFileURL(source+'/scripts/applyMigrations.mjs'));
  const filename='018_add_integration_push_logs.sql';
  const sql=fs.readFileSync(stage+'/database/'+filename,'utf8');
  assert.equal(hash(sql),manifest.migrationSha256);
  const statements=executableStatements(sql);
  for(const statement of statements) await db.query(statement);
  for(const statement of splitStatements(sql)){
    const command=statement.replace(/^(?:\s*--[^\n]*(?:\n|$))+/,'').trim();
    if(/^GRANT /i.test(command)) await db.query(command);
  }
  await db.execute('INSERT INTO schema_migrations (filename,sha256,execution_sql_sha256,application_mode,note) VALUES (?,?,?,\'EXECUTED\',?)',[filename,hash(sql),hash(statements.join(';\n')+';\n'),'Additive customer push logs; exact table-scoped application grants.']);
  console.log('PASS migration 018; existing role capabilities seeded; scoped grants applied');
  // Only reviewed module files are installed. Environment, dependencies and
  // unrelated handlers (including TYG lock fix) stay at their running versions.
  swapped=true;
  for(const file of copyFiles){fs.copyFileSync(source+'/'+file,app+'/'+file+'.push-logs-next');fs.renameSync(app+'/'+file+'.push-logs-next',app+'/'+file);}
  assert.equal(hash(fs.readFileSync(app+'/.env')),envHash);
  execFileSync(node,[pm2,'reload','cloud-api'],{env:pmEnv,stdio:'pipe',timeout:30000});
  let healthy=false;
  for(let i=0;i<15;i++){try{const r=await fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(2500)});healthy=r.ok&&(await r.json()).ok===true;}catch{}if(healthy)break;await new Promise(r=>setTimeout(r,1000));}
  assert.ok(healthy,'Production health after reload');
  const marker='push-log-release-'+Date.now();
  const denied=await fetch('http://127.0.0.1:8080/api/v1/shipments',{method:'POST',headers:{'Content-Type':'application/json','X-Request-ID':marker},body:'{}',signal:AbortSignal.timeout(5000)});
  assert.equal(denied.status,401);
  const malformed=await fetch('http://127.0.0.1:8080/api/v1/air-shipments',{method:'POST',headers:{'Content-Type':'application/json','X-Request-ID':marker+'-json'},body:'{',signal:AbortSignal.timeout(5000)});
  assert.equal(malformed.status,400);
  let rows=[];
  for(let i=0;i<20;i++){[rows]=await db.execute('SELECT request_id,http_status,request_summary,response_summary FROM integration_push_logs WHERE request_id IN (?,?) ORDER BY request_id',[marker,marker+'-json']);if(rows.length===2)break;await new Promise(r=>setTimeout(r,250));}
  assert.equal(rows.length,2,'Real inbound failures audited');
  const deniedRead=await fetch('http://127.0.0.1:8080/warehouse/v1/integration-logs',{headers:{Origin:'https://cmhubtool.com'},signal:AbortSignal.timeout(5000)});assert.equal(deniedRead.status,401);
  const appDb=await mysql.createPool({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT||3306),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,database:env.MYSQL_DATABASE,timezone:'Z'});
  try{
    const {createIntegrationLogs}=await import(pathToFileURL(source+'/dist/integrationLogs.js'));
    // Existing app credentials exercise real SELECT/JOIN grants without creating
    // any account or read watermark in the production database.
    const [ids]=await appDb.execute('SELECT CAST(id AS CHAR) AS id FROM integration_push_logs WHERE request_id=?',[marker]);
    const detail=await createIntegrationLogs({mysql:appDb}).detail(ids[0].id);assert.equal(detail.httpStatus,401);
  }finally{await appDb.end();}
  assert.equal(hash(fs.readFileSync(app+'/.env')),envHash);
  assert.equal(hash(fs.readFileSync(app+'/dist/tygV11.js')),hotfix);
  const result={status:'PASS',commit:manifest.commit,backup,health:true,migration:18,auth401:true,malformed400:true,auditCaptured:true,appReadGrants:true,envUnchanged:true,tygHotfixPreserved:true,files:copyFiles};
  fs.writeFileSync(stage+'/release-result.json',JSON.stringify(result,null,2),{mode:0o600});console.log('PUSH_LOGS_RELEASE='+JSON.stringify(result));
}catch(error){
  if(swapped){for(const file of originals)fs.copyFileSync(backup+'/'+file,app+'/'+file);for(const file of copyFiles.filter(x=>!originals.includes(x)))fs.rmSync(app+'/'+file,{force:true});execFileSync(node,[pm2,'reload','cloud-api'],{env:pmEnv,stdio:'pipe',timeout:30000});console.error('ROLLED_BACK_APPLICATION; additive migration/log rows retained');}
  throw error;
}finally{await db.end();}
