import { describe, expect, it } from '@jest/globals';
import { generateOtpCode, hashOtpCode, verifyOtpCode } from './otp.js';

describe('generateOtpCode', () => {
  it('returns a 6-digit numeric string', () => {
    const code = generateOtpCode();

    expect(code).toMatch(/^\d{6}$/);
  });

  it('pads codes below 100000 with leading zeros', () => {
    const codes = Array.from({ length: 200 }, () => generateOtpCode());

    for (const code of codes) {
      expect(code).toHaveLength(6);
    }
  });
});

describe('hashOtpCode / verifyOtpCode', () => {
  it('verifies a code against its own hash', async () => {
    const code = '123456';
    const hash = await hashOtpCode(code);

    await expect(verifyOtpCode(code, hash)).resolves.toBe(true);
  });

  it('rejects an incorrect code', async () => {
    const hash = await hashOtpCode('123456');

    await expect(verifyOtpCode('654321', hash)).resolves.toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    const [hashA, hashB] = await Promise.all([hashOtpCode('123456'), hashOtpCode('123456')]);

    expect(hashA).not.toBe(hashB);
  });
});
