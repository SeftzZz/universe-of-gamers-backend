import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // panjang IV untuk AES-GCM

// Ambil key utama (prod)
if (!process.env.ENCRYPTION_KEY) {
  throw new Error("❌ Missing ENCRYPTION_KEY in environment variables");
}
const KEY_MAIN = crypto
  .createHash("sha256")
  .update(String(process.env.ENCRYPTION_KEY))
  .digest();

// Optional: key cadangan (misalnya GAME_DEV)
let KEY_FALLBACK: Buffer | null = null;
if (process.env.ENCRYPTION_KEY_GAME_DEV) {
  KEY_FALLBACK = crypto
    .createHash("sha256")
    .update(String(process.env.ENCRYPTION_KEY_GAME_DEV))
    .digest();
}

/**
 * Enkripsi private key (selalu pakai KEY_MAIN)
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY_MAIN, iv);

  let encrypted = cipher.update(text, "utf8", "base64");
  encrypted += cipher.final("base64");

  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, Buffer.from(encrypted, "base64")]).toString("base64");
}

/**
 * Dekripsi private key
 * - Coba pakai KEY_MAIN dulu
 * - Kalau gagal, coba pakai KEY_FALLBACK (jika ada)
 */
export function decrypt(encryptedData: string): string {
  const data = Buffer.from(encryptedData, "base64");
  const iv = data.slice(0, IV_LENGTH);
  const authTag = data.slice(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = data.slice(IV_LENGTH + 16);

  function tryDecrypt(key: Buffer): string {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, undefined, "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  // 1️⃣ Coba dengan KEY_MAIN
  try {
    return tryDecrypt(KEY_MAIN);
  } catch (err) {
    console.warn("⚠️ Decrypt with ENCRYPTION_KEY failed:", (err as Error).message);
  }

  // 2️⃣ Coba dengan KEY_FALLBACK
  if (KEY_FALLBACK) {
    try {
      return tryDecrypt(KEY_FALLBACK);
    } catch (err) {
      console.warn("⚠️ Decrypt with ENCRYPTION_KEY_GAME_DEV failed:", (err as Error).message);
    }
  }

  throw new Error("❌ Failed to decrypt private key with all available keys");
}
