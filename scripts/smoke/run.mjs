import { spawn } from 'node:child_process';
import { settings, root } from '../runtime.mjs';
const {env}=settings();
const child=spawn('python3',['scripts/smoke/api.py'],{cwd:root,env:{...process.env,SMOKE_BASE:process.env.SMOKE_BASE??`http://localhost:${env.PORT}`,SMOKE_TOKEN:process.env.SMOKE_TOKEN??env.ACCESS_TOKEN},stdio:'inherit'});
child.on('exit',code=>process.exit(code??1));
