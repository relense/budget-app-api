import { randomInt } from 'node:crypto';
import argon2 from 'argon2';

// Uppercase letters + digits, excluding ambiguous characters (0/O, 1/I/L)
// so a code read off an email is easy to type back correctly.
const OTP_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const OTP_LENGTH = 6;

export const OTP_CODE_REGEX = new RegExp(`^[${OTP_ALPHABET}]{${OTP_LENGTH}}$`);

export function generateOtpCode(): string {
  let code = '';
  for (let i = 0; i < OTP_LENGTH; i++) {
    code += OTP_ALPHABET[randomInt(0, OTP_ALPHABET.length)];
  }
  return code;
}

export function hashOtpCode(code: string): Promise<string> {
  return argon2.hash(code);
}

export function verifyOtpCode(code: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, code);
}
