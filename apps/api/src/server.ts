import { errorTracking } from './observability.js';
errorTracking.init(); // before anything else, so startup errors are captured too

import { buildApp } from './app.js';
import { cognitoVerify, devVerify } from './auth.js';
import { createDb } from './db.js';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Missing env ${k}`); return v };

const verify = process.env.AUTH_MODE === 'dev' ? devVerify() : cognitoVerify(env('COGNITO_USER_POOL_ID'), env('COGNITO_CLIENT_ID'));
const app = buildApp({ db: createDb(env('DATABASE_URL')), verify });
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
