// TOTP (RFC 6238): the 6-digit codes authenticator apps show, changing every 30 seconds.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string) {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of s.replace(/[\s=]/g, "").toUpperCase()) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("ADMIN_TOTP_SECRET is not valid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(key: Buffer, step: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", key).update(msg).digest();
  const offset = h[19] & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 30_000);

/**
 * Accepts the current code or one 30 s step either side (clock drift).
 * Each step is accepted only once, so a code seen over someone's shoulder can't be replayed.
 */
export function createTotpVerifier(secretBase32: string) {
  const key = base32Decode(secretBase32);
  let lastUsedStep = -1;
  return (code: string | undefined) => {
    if (!code || !/^\d{6}$/.test(code)) return false;
    const now = currentStep();
    for (const step of [now - 1, now, now + 1]) {
      if (step <= lastUsedStep) continue;
      if (timingSafeEqual(Buffer.from(totpCode(key, step)), Buffer.from(code))) {
        lastUsedStep = step;
        return true;
      }
    }
    return false;
  };
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

// `npm run admin:2fa` prints a fresh secret and the link to add it to an authenticator app.
if (import.meta.main) {
  const secret = newTotpSecret();
  const uri = `otpauth://totp/Claude%20Gateway:admin?secret=${secret}&issuer=Claude%20Gateway&algorithm=SHA1&digits=6&period=30`;
  console.log(`\nADMIN_TOTP_SECRET=${secret}\n`);
  console.log("1. Put the line above in .env and restart the server.");
  console.log("2. In your authenticator app choose 'enter a setup key' and paste the secret,");
  console.log("   or turn this link into a QR code locally and scan it:\n");
  console.log(`   ${uri}\n`);
  console.log("Keep the secret private: anyone with it can generate your codes.\n");
}
