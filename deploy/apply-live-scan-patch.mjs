import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const app = '/www/wwwroot/releases/cloud-api-b1c897a-20260920T170700Z';
const node = '/opt/node22/bin/node';
const pm2 = '/www/server/nodejs/v20.10.0/lib/node_modules/pm2/bin/pm2';
const env = { ...process.env, PM2_HOME: '/root/.pm2', PATH: '/opt/node22/bin:' + process.env.PATH };
const hash = s => createHash('sha256').update(s).digest('hex');
const bundle = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'live-scan-patch.json')));
assert.equal(execFileSync('curl', ['--noproxy', '*', '--fail', '--silent', '--max-time', '3', 'http://metadata.tencentyun.com/latest/meta-data/instance-id'], {encoding:'utf8'}).trim(), 'ins-dmx8z3xt');
const processes = JSON.parse(execFileSync(node,[pm2,'jlist'],{env,encoding:'utf8'})).filter(p=>p.name==='cloud-api');
assert.equal(processes.length,1); assert.equal(processes[0].pm2_env.pm_cwd,app); assert.equal(processes[0].pm2_env.status,'online');
process.chdir(app);
const entries = bundle.patches.map(p => {
  assert.ok(['src/index.ts','src/warehouseOperations.ts','dist/index.js','dist/warehouseOperations.js'].includes(p.file));
  const target=path.join(app,p.file), original=fs.readFileSync(target,'utf8'), stat=fs.statSync(target);
  assert.equal(hash(original),p.before,`Live file changed: ${p.file}`);
  assert.equal(original.split(p.anchor).length,2);
  const updated=original.replace(p.anchor,p.insert+p.anchor); assert.equal(hash(updated),p.after);
  return {...p,target,original,updated,stat};
});
const health = async () => { const r=await fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(3000)}); assert.equal(r.status,200); assert.equal((await r.json()).ok,true); };
await health();
console.log('PATCH_PREFLIGHT=PASS');
if(!process.argv.includes('--apply')) process.exit(0);

const require = createRequire(path.join(app,'package.json'));
const mysql = require('mysql2/promise');
const {config}=await import(pathToFileURL(path.join(app,'dist/config.js')));
assert.ok(process.env.DBA_PASSWORD,'DBA credential is required locally; never printed');
const db=await mysql.createConnection({...config.mysql,user:'root',password:process.env.DBA_PASSWORD,timezone:'Z'});
delete process.env.DBA_PASSWORD; delete env.DBA_PASSWORD;
try {
  await db.query('SET SESSION lock_wait_timeout=5');
  const [indexes]=await db.query('SHOW INDEX FROM shipments');
  const wanted=[['idx_shipments_first_leg_lookup','first_leg_tracking_no'],['idx_shipments_courier_lookup','courier_tracking_no']];
  for (const [name,col] of wanted) {
    const existing=indexes.filter(x=>x.Key_name===name);
    if(existing.length) {assert.equal(existing.length,1);assert.equal(existing[0].Column_name,col);}
    else await db.query(`ALTER TABLE shipments ADD INDEX ${name} (${col}), ALGORITHM=INPLACE, LOCK=NONE`);
  }
  const [tables]=await db.query("SHOW TABLES LIKE 'schema_migrations'");
  if(tables.length) {
    const filename='021_add_global_tracking_lookup_indexes.sql';
    const [rows]=await db.execute('SELECT sha256 FROM schema_migrations WHERE filename=?',[filename]);
    if(rows.length) assert.equal(rows[0].sha256,bundle.migrationHash);
    else await db.execute('INSERT INTO schema_migrations (filename,sha256) VALUES (?,?)',[filename,bundle.migrationHash]);
  }
  console.log('LOOKUP_INDEXES=READY');
} finally {await db.end();}

const backup=fs.mkdtempSync('/root/tyg-live-scan-backup-'); fs.chmodSync(backup,0o700);
for(const entry of entries) fs.writeFileSync(path.join(backup,entry.file.replace('/','-')),entry.original,{mode:0o600,flag:'wx'});
fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify(bundle.patches.map(({file,before,after})=>({file,before,after}))),{mode:0o600});
const atomic=(e,body)=> { const temp=e.target+'.live-scan-'+process.pid; fs.writeFileSync(temp,body,{flag:'wx',mode:e.stat.mode & 0o777}); fs.chownSync(temp,e.stat.uid,e.stat.gid); fs.renameSync(temp,e.target); };
try {
  for(const entry of entries) atomic(entry,entry.updated);
  for(const file of ['dist/index.js','dist/warehouseOperations.js']) execFileSync(node,['--check',path.join(app,file)]);
  const {createWarehouseOperations}=await import(pathToFileURL(path.join(app,'dist/warehouseOperations.js')));
  const pool=mysql.createPool({...config.mysql,timezone:'Z'});
  try {
    let plan;
    const operations=createWarehouseOperations({mysql:{execute:async(sql,args)=>{plan=(await pool.execute('EXPLAIN '+sql,args))[0];return pool.execute(sql,args);}},storage:{},outboundWebhooks:{}});
    const first=await operations.lookupShipment({},'ZS20860104699'); assert.ok(first?.labelAsset);
    assert.equal((await operations.lookupShipment({},first.courierTrackingNo)).id,first.id);
    assert.equal(await operations.lookupShipment({},'LIVE-SCAN-NONEXISTENT-20260925'),null);
    console.log('LOOKUP_PLAN='+JSON.stringify(plan.map(x=>({table:x.table,type:x.type,key:x.key,rows:x.rows}))));
    assert.ok(plan.some(x=>x.key==='idx_shipments_first_leg_lookup'));
    assert.ok(plan.some(x=>x.key==='idx_shipments_courier_lookup'));
    assert.ok(!plan.some(x=>x.table==='s' && x.type==='ALL'));
    console.log('LIVE_DATABASE_LOOKUP=PASS');
  } finally {await pool.end();}
  execFileSync(node,[pm2,'reload','cloud-api'],{env,stdio:'pipe',timeout:30000});
  let healthy=false;
  for(let i=0;i<15;i++){try{await health();healthy=true;break;}catch{await new Promise(r=>setTimeout(r,1000));}}
  assert.ok(healthy);
  const r=await fetch('http://127.0.0.1:8080/warehouse/v1/shipments/lookup?trackingNo=ZS20860104699',{headers:{Origin:'https://cmhubtool.com'}});
  assert.equal(r.status,401,'Route must require authentication');
  for(const entry of entries) assert.equal(hash(fs.readFileSync(entry.target)),entry.after);
  console.log('LIVE_SCAN_DEPLOY='+JSON.stringify({status:'PASS',backup,health:true,unauthenticatedStatus:r.status,files:entries.map(e=>({file:e.file,sha256:e.after}))}));
} catch(error) {
  for(const entry of entries) atomic(entry,entry.original);
  execFileSync(node,[pm2,'reload','cloud-api'],{env,stdio:'pipe',timeout:30000});
  console.error(JSON.stringify({status:'ROLLED_BACK',backup,message:error.message})); process.exitCode=1;
}
