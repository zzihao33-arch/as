import fs from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const hash = s => createHash('sha256').update(s).digest('hex');
const specs = [
  ['src/index.ts', "warehouseRouter.get('/shipments/lookup'", "warehouseRouter.get('/shipments',", 'e396becbd02697fc55a174923299b397114f96e3c600d83f5d97cd2463a78ad1'],
  ['src/warehouseOperations.ts', '    async lookupShipment(', '    async listShipments(', 'b04b83109e7282f3c1be83e28da3f1f53b7c8804626965718cdc10c047faaae2'],
  ['dist/index.js', "warehouseRouter.get('/shipments/lookup'", "warehouseRouter.get('/shipments',", '9113d86936683c8ed5ab0e633a9726e94eaf20fd895f2a5bf338e76cbd81b1e0'],
  ['dist/warehouseOperations.js', '        async lookupShipment(', '        async listShipments(', '7a82c224c93af4b15bf81f3fb03a8a23d5a1f577c4a01176da167981824b55ec'],
];
const patches = specs.map(([file, start, anchor, before]) => {
  const updated = fs.readFileSync(`services/cloud-api/${file}`, 'utf8').replaceAll('\r\n', '\n');
  const insert = updated.slice(updated.indexOf(start), updated.indexOf(anchor));
  assert.ok(insert.length > 100);
  assert.equal(hash(updated.replace(insert, '')), before, `Unexpected extra changes: ${file}`);
  return { file, before, after: hash(updated), anchor, insert };
});
const migration = fs.readFileSync('database/021_add_global_tracking_lookup_indexes.sql', 'utf8').replaceAll('\r\n', '\n');
fs.writeFileSync('deploy/live-scan-patch.json', JSON.stringify({ patches, migration, migrationHash: hash(migration) }, null, 2) + '\n');
console.log(patches.map(({file,after}) => ({ file, after })));
