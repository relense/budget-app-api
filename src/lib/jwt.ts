import { jwtVerify, SignJWT } from 'jose';

const ACCESS_TOKEN_TTL = '15m';
const BEARER_PREFIX = 'Bearer ';

export interface AccessTokenPayload {
  userId: string;
}

export async function signAccessToken(
  payload: AccessTokenPayload,
  secret: string,
): Promise<string> {
  const key = new TextEncoder().encode(secret);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(key);
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenPayload | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);

    if (typeof payload.sub !== 'string') {
      return null;
    }

    return { userId: payload.sub };
  } catch {
    return null;
  }
}

/**
 * Extracts and verifies the bearer access token from a Fastify request's
 * Authorization header, returning the authenticated userId or null.
 * Shared by every REST route that requires a signed-in user but isn't
 * itself part of the OTP/token-issuing flow (logout-all, account
 * export/delete).
 */
export async function resolveBearerUserId(
  request: { headers: { authorization?: string } },
  secret: string,
): Promise<string | null> {
  const authHeader = request.headers.authorization;
  const token = authHeader?.startsWith(BEARER_PREFIX) ? authHeader.slice(BEARER_PREFIX.length) : null;
  const payload = token ? await verifyAccessToken(token, secret) : null;
  return payload?.userId ?? null;
}
