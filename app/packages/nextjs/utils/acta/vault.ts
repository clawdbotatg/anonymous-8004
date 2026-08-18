/**
 * The wallet vault (doc 13): credentials + the master secret, AES-GCM
 * encrypted in localStorage under a key derived from ONE wallet signature.
 *
 * Sign-in = sign a fixed message → HKDF the signature into an AES key.
 * Same wallet + same message = same key, so unlocking is repeatable with no
 * account and no server. Plaintext exists only in React state while
 * unlocked.
 *
 * v1 targets EOAs: ECDSA via RFC 6979 makes the signature deterministic in
 * practice for MetaMask-style wallets, but smart-account wallets don't
 * guarantee that — a non-deterministic signer shows up as "wrong key" on
 * the second unlock, which unlockVault surfaces as a clear error.
 */
import { FIELD_MODULUS } from "./actaSdk";
import { ActaVerifiableCredential } from "./vc";

export const randomFieldElement = () => {
  const bytes = new Uint8Array(31); // 248 bits < 254-bit field
  crypto.getRandomValues(bytes);
  return bytes.reduce((acc, b) => (acc << 8n) + BigInt(b), 0n) % FIELD_MODULUS;
};

export const VAULT_MESSAGE =
  "ACTA credential wallet v1 — unlock\n\n" +
  "Signing this message derives the key that encrypts your credentials on this device. " +
  "It is free, sends no transaction, and moves no funds.";

export type VaultData = {
  /** The agent's master secret (decimal string) — needed to prove; never shown. */
  masterSecret: string;
  vcs: ActaVerifiableCredential[];
};

const storageKey = (address: string) => `acta-vault:${address.toLowerCase()}`;
const te = new TextEncoder();

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function deriveVaultKey(signature: `0x${string}`): Promise<CryptoKey> {
  const sigBytes = Uint8Array.from(
    signature
      .slice(2)
      .match(/.{2}/g)!
      .map(h => parseInt(h, 16)),
  );
  const ikm = await crypto.subtle.importKey("raw", sigBytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: te.encode("acta-wallet-vault-v1"), info: te.encode("aes-gcm-256") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function hasVault(address: string): boolean {
  return window.localStorage.getItem(storageKey(address)) !== null;
}

/** null = no vault stored for this address yet. Throws on wrong key. */
export async function loadVault(address: string, key: CryptoKey): Promise<VaultData | null> {
  const raw = window.localStorage.getItem(storageKey(address));
  if (!raw) return null;
  const { iv, ct } = JSON.parse(raw);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct));
  } catch {
    throw new Error(
      "vault exists but this signature can't open it — a different wallet signed, or your wallet doesn't sign deterministically (smart-account wallets aren't supported in v1)",
    );
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

export async function saveVault(address: string, key: CryptoKey, data: VaultData): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(data)));
  window.localStorage.setItem(storageKey(address), JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) }));
}
