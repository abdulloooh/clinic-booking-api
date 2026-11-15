import { randomBytes } from "node:crypto";

// Avoid 0/O, 1/I/L, U so ids survive being read aloud or retyped.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newBookingId(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) {
    out += ALPHABET[b % ALPHABET.length];
  }
  return `BK-${out.slice(0, 4)}-${out.slice(4)}`;
}
