import type { FastifyRequest } from 'fastify';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

export interface Identity { sub: string; email: string }
/** Resolves the caller's identity, or null if unauthenticated. */
export type Verify = (req: FastifyRequest) => Promise<Identity | null>;

const bearer = (req: FastifyRequest) => req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];

/** Verifies Cognito ID tokens (they carry the verified email). */
export function cognitoVerify(userPoolId: string, clientId: string): Verify {
  const verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' });
  return async req => {
    const token = bearer(req);
    if (!token) return null;
    try {
      const p = await verifier.verify(token);
      return typeof p.email === 'string' && p.email_verified === true ? { sub: p.sub, email: p.email } : null;
    } catch { return null }
  };
}

/** Local dev only: trusts an `x-dev-sub` header (used as the email too). Refuses to run in production. */
export function devVerify(): Verify {
  if (process.env.NODE_ENV === 'production') throw new Error('Dev auth is not allowed in production');
  return async req => {
    const sub = req.headers['x-dev-sub'];
    return typeof sub === 'string' && sub ? { sub, email: sub } : null;
  };
}
