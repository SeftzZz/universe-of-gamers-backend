// utils/cryptoHelper.js
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // panjang IV untuk AES-GCM
const KEY = crypto.createHash('sha256').update(String(process.env.ENCRYPTION_KEY)).digest(); 
// ⚠️ ENCRYPTION_KEY harus ada di .env, minimal 32 karakter

/**
 * Enkripsi private key
 * @param {string} text - private key dalam bentuk string
 * @returns {string} hasil enkripsi base64
 */
export function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);

  let encrypted = cipher.update(text, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // simpan IV + authTag + data terenkripsi
  return Buffer.concat([iv, authTag, Buffer.from(encrypted, 'base64')]).toString('base64');
}

/**
 * Dekripsi private key
 * @param {string} encryptedData - data terenkripsi base64
 * @returns {string} private key asli
 */
export function decrypt(encryptedData) {
  const data = Buffer.from(encryptedData, 'base64');

  const iv = data.slice(0, IV_LENGTH);
  const authTag = data.slice(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = data.slice(IV_LENGTH + 16);

  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
