import { randomInt } from 'node:crypto';
import argon2 from 'argon2';

const OTP_MAX_EXCLUSIVE = 1_000_000;
const OTP_LENGTH = 6;

export function generateOtpCode(): string {
  return randomInt(0, OTP_MAX_EXCLUSIVE).toString().padStart(OTP_LENGTH, '0');
}

export function hashOtpCode(code: string): Promise<string> {
  return argon2.hash(code);
}

export function verifyOtpCode(code: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, code);
}
