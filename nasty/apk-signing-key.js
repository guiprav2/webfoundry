/**
 * Per-project APK signing keys: an RSA key from WebCrypto plus a self-signed
 * X.509 certificate, as the PEM pair exportAndroidApk's signingKey option takes.
 * Not wired into the export flow yet (see issue apk-signing-key).
 */

let pem = (label, der) => {
  let bin = '';
  let bytes = new Uint8Array(der);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  let b64 = btoa(bin).replace(/.{1,64}/g, '$&\n');
  return `-----BEGIN ${label}-----\n${b64}-----END ${label}-----\n`;
};

/**
 * @param {string} commonName certificate subject CN, e.g. the project name
 * @returns {Promise<{ keyPem: string, certPem: string }>}
 */
export async function generateApkSigningKey(commonName) {
  let { default: forge } = await import('https://cdn.jsdelivr.net/npm/node-forge@1.4.0/+esm');
  let pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  let keyPem = pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let publicPem = pem('PUBLIC KEY', await crypto.subtle.exportKey('spki', pair.publicKey));

  let cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicPem);
  // Positive 16-byte serial (high bit cleared).
  let serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;
  cert.serialNumber = [...serial].map(b => b.toString(16).padStart(2, '0')).join('');
  cert.validity.notBefore = new Date();
  // Android checks validity only at install time, but Play requires it to outlast 2033.
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 50);
  let subject = [
    { name: 'commonName', value: String(commonName || 'Webfoundry App').slice(0, 64) },
    { name: 'organizationName', value: 'Webfoundry' },
  ];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
  return { keyPem, certPem: forge.pki.certificateToPem(cert) };
}
