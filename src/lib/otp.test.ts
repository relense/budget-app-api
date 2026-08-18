import { describe, expect, it } from '@jest/globals';
import { generateOtpCode, hashOtpCode, OTP_CODE_REGEX, verifyOtpCode } from './otp.js';

describe('generateOtpCode', () => {
  it('returns a 6-character code from the allowed alphanumeric alphabet', () => {
    const code = generateOtpCode();

    expect(code).toMatch(OTP_CODE_REGEX);
  });

  it('never includes ambiguous characters (0, O, 1, I, L)', () => {
    const codes = Array.from({ length: 500 }, () => generateOtpCode());

    for (const code of codes) {
      expect(code).toHaveLength(6);
      expect(code).not.toMatch(/[01ILO]/);
    }
  });

  it('is always uppercase', () => {
    const code = generateOtpCode();

    expect(code).toBe(code.toUpperCase());
  });
});

describe('hashOtpCode / verifyOtpCode', () => {
  it('verifies a code against its own hash', async () => {
    const code = 'K7QXF3';
    const hash = await hashOtpCode(code);

    await expect(verifyOtpCode(code, hash)).resolves.toBe(true);
  });

  it('rejects an incorrect code', async () => {
    const hash = await hashOtpCode('K7QXF3');

    await expect(verifyOtpCode('9ZMPWH', hash)).resolves.toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    const [hashA, hashB] = await Promise.all([hashOtpCode('K7QXF3'), hashOtpCode('K7QXF3')]);

    expect(hashA).not.toBe(hashB);
  });
});
