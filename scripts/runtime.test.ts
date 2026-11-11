import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const evaluate = (env: NodeJS.ProcessEnv, source: string) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {settings} from './scripts/runtime.ts'; ${source}`], {env:{...process.env,...env},encoding:'utf8'}));
test('first run generates a private token and profile-specific paths in the selected data directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'likes-config-'));
  try {
    const env={APP_DATA_MODE:'custom',APP_DATA_DIR:dir,APP_PROFILE:'demo'};
    const r=evaluate(env,'const s=settings();console.log(JSON.stringify({config:s.config,db:s.env.SQLITE_PATH,uploads:s.env.UPLOAD_DIR,tokenLength:s.env.ACCESS_TOKEN.length}));');
    assert.equal(r.config,path.join(dir,'config/demo.env'));
    assert.equal(r.db,path.join(dir,'db/demo.sqlite'));
    assert.equal(r.uploads,path.join(dir,'uploads/demo'));
    assert.ok(r.tokenLength>=32);
    assert.equal(fs.statSync(r.config).mode & 0o777,0o600);
    const original=fs.readFileSync(r.config,'utf8');
    evaluate({...env,APP_PROFILE:'other'},'settings();console.log(JSON.stringify(true));');
    assert.equal(fs.readFileSync(r.config,'utf8'),original);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('xdg mode selects the app directory without writing during inspection',()=>{
  const r=evaluate({APP_DATA_MODE:'xdg',APP_PROFILE:'no-create'},'const s=settings({create:false});console.log(JSON.stringify({data:s.data}));');
  assert.equal(r.data,path.join(os.homedir(),'.local/share/videos-worth-keeping'));
});
