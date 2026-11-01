// @here-wallet/core imports Node's `crypto` only for randomBytes(32) (a sign-in nonce). The browser has Web Crypto.
import { Buffer } from "buffer/";

export function randomBytes(size) {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(size)));
}
