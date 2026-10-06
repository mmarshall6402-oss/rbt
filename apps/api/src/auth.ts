import type { FastifyRequest } from 'fastify';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

/** Resolves the caller's Cognito `sub`, or null if unauthenticated. */
export type Verify = (req: FastifyRequest) => Promise<string | null>;

const bearer = (req: FastifyRequest) => req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];

export function cognitoVerify(userPoolId: string, clientId: string): Verify {
  const verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'access' });
  return async req => {
    const token = bearer(req);
    if (!token) return null;
    try { return (await verifier.verify(token)).sub } catch { return null }
  };
}

/** Local dev only: trusts an `x-dev-sub` header. Refuses to run in production. */
export function devVerify(): Verify {
  if (process.env.NODE_ENV === 'production') throw new Error('Dev auth is not allowed in production');
  return async req => (typeof req.headers['x-dev-sub'] === 'string' ? req.headers['x-dev-sub'] : null);
}
