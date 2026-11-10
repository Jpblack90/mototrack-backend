import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 12 bytes recomendado para GCM

/**
 * Obtiene y valida la clave de cifrado simétrico desde las variables de entorno.
 * Debe ser una cadena Base64 que decodifique exactamente a 32 bytes (256 bits).
 *
 * @returns {Buffer}
 */
function getEncryptionKey() {
  const keyBase64 = process.env.PSE_ENCRYPTION_KEY;
  if (!keyBase64 || typeof keyBase64 !== 'string' || keyBase64.trim() === '') {
    console.error('[PSE_CRYPTO] PSE_ENCRYPTION_KEY no configurada en las variables de entorno.');
    const err = new Error('Servicio de facturación electrónica no disponible.');
    err.code = 'PSE_KEY_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  }

  const keyBuffer = Buffer.from(keyBase64.trim(), 'base64');
  if (keyBuffer.length !== 32) {
    console.error('[PSE_CRYPTO] PSE_ENCRYPTION_KEY inválida: debe tener exactamente 32 bytes decodificados de Base64.');
    const err = new Error('Servicio de facturación electrónica no disponible.');
    err.code = 'PSE_KEY_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  }

  return keyBuffer;
}

/**
 * Cifra un texto plano utilizando AES-256-GCM con IV aleatorio de 12 bytes.
 *
 * @param {string} plainText Texto a cifrar
 * @returns {string|null} Cadena en formato "iv_base64:tag_base64:ciphertext_base64"
 */
export function encrypt(plainText) {
  if (typeof plainText !== 'string' || !plainText) {
    return null;
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Descifra una cadena previamente cifrada con encrypt().
 *
 * @param {string} encryptedText Cadena en formato "iv_base64:tag_base64:ciphertext_base64"
 * @returns {string|null} Texto plano original
 */
export function decrypt(encryptedText) {
  if (typeof encryptedText !== 'string' || !encryptedText) {
    return null;
  }

  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Formato de texto cifrado inválido.');
  }

  const [ivBase64, tagBase64, cipherBase64] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivBase64, 'base64');
  const tag = Buffer.from(tagBase64, 'base64');
  const ciphertext = Buffer.from(cipherBase64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
