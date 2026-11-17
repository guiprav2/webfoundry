// Signs an APK off the main thread (v1 re-zip + digests of ~170 MB freeze the tab for ~30s otherwise).
import { ApkSigner, SigningKey } from 'https://cdn.jsdelivr.net/npm/apk_sign_ts@1.0.1/browser/+esm';

self.onmessage = async ({ data: { apk, keyPem, certPem } }) => {
  try {
    let signer = new ApkSigner({ signingKey: SigningKey.fromPEM(keyPem, certPem) });
    let { signedApk } = await signer.sign(apk);
    self.postMessage({ signedApk }, [signedApk.buffer]);
  } catch (err) {
    self.postMessage({ error: err?.message || String(err) });
  }
};
