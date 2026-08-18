import { jwtVerify, SignJWT } from 'jose';

const ACCESS_TOKEN_TTL = '15m';

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
