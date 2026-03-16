
// --- Utility Functions ---

/**
 * Converts a string to a Uint8Array.
 * @param {string} str The string to convert.
 * @returns {Uint8Array} The converted Uint8Array.
 */
function strToUint8(str) {
  return new TextEncoder().encode(str);
}

/**
 * Converts a Uint8Array to a Base64Url-encoded string.
 * @param {Uint8Array} arr The Uint8Array to convert.
 * @returns {string} The Base64Url-encoded string.
 */
function uint8ToBase64Url(arr) {
  return btoa(String.fromCharCode.apply(null, arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Converts a Base64Url-encoded string to a Uint8Array.
 * @param {string} str The Base64Url-encoded string to convert.
 * @returns {Uint8Array} The converted Uint8Array.
 */
function base64UrlToUint8(str) {
  return new Uint8Array(atob(str.replace(/-/g, '+').replace(/_/g, '/')).split('').map(c => c.charCodeAt(0)));
}


// --- Crypto Functions ---

/**
 * Creates a new HMAC key from a secret.
 * @param {string} secret The secret to use for the key.
 * @returns {Promise<CryptoKey>} The generated HMAC key.
 */
async function createKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    strToUint8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Signs a payload and returns a JWT.
 * @param {object} payload The payload to sign.
 * @param {string} secret The secret to use for signing.
 * @returns {Promise<string>} The generated JWT.
 */
export async function signJWT(payload, secret) {
  const key = await createKey(secret);

  const header = { alg: "HS256", typ: "JWT" };
  const payloadWithExp = { ...payload, exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7) }; // 7 days

  const headerBase64Url = uint8ToBase64Url(strToUint8(JSON.stringify(header)));
  const payloadBase64Url = uint8ToBase64Url(strToUint8(JSON.stringify(payloadWithExp)));

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    strToUint8(`${headerBase64Url}.${payloadBase64Url}`),
  );

  const signatureBase64Url = uint8ToBase64Url(new Uint8Array(signature));

  return `${headerBase64Url}.${payloadBase64Url}.${signatureBase64Url}`;
}

/**
 * Verifies a JWT and returns the payload if valid.
 * @param {string} token The JWT to verify.
 * @param {string} secret The secret to use for verification.
 * @returns {Promise<object|null>} The payload if the token is valid, otherwise null.
 */
export async function verifyJWT(token, secret) {
  try {
    const key = await createKey(secret);
    const parts = token.split('.');
    if (parts.length !== 3) {
        return null; // Invalid token format
    }
    const [headerBase64Url, payloadBase64Url, signatureBase64Url] = parts;
    
    const header = JSON.parse(new TextDecoder().decode(base64UrlToUint8(headerBase64Url)));
    if (header.alg !== 'HS256') {
        return null; // Invalid algorithm
    }

    const signature = base64UrlToUint8(signatureBase64Url);

    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      strToUint8(`${headerBase64Url}.${payloadBase64Url}`),
    );

    if (!isValid) {
      return null;
    }

    const payload = JSON.parse(new TextDecoder().decode(base64UrlToUint8(payloadBase64Url)));

    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return null;
    }

    return payload;
  } catch (error) {
    return null;
  }
}
