import { settings } from '../runtime.ts';
const { env } = settings();
process.env.SMOKE_BASE ??= `http://localhost:${env.PORT}`;
process.env.SMOKE_TOKEN ??= env.ACCESS_TOKEN;
await import('./api.ts');
