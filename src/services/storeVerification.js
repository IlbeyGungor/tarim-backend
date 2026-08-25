const crypto = require('crypto');
const fs = require('fs');

const { getPromotionProduct } = require('./promotionProducts');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw Object.assign(new Error(`${name} tanımlı değil.`), { code: 'STORE_NOT_CONFIGURED' });
  return value;
}

function purchaseTokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function preferredAppleEnvironment(library) {
  return String(process.env.APPLE_IAP_ENVIRONMENT || 'production').toLowerCase() === 'sandbox'
    ? library.Environment.SANDBOX
    : library.Environment.PRODUCTION;
}

function applePrivateKey() {
  const filePath = String(process.env.APPLE_IAP_PRIVATE_KEY_PATH || '').trim();
  if (filePath) return fs.readFileSync(filePath, 'utf8');
  const encoded = required('APPLE_IAP_PRIVATE_KEY_BASE64');
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function appleRootCertificates() {
  return required('APPLE_IAP_ROOT_CA_PATHS')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((filePath) => fs.readFileSync(filePath));
}

function appleVerifier(library, environment) {
  const appAppleId = environment === library.Environment.PRODUCTION
    ? Number(required('APPLE_IAP_APP_ID'))
    : undefined;
  return new library.SignedDataVerifier(
    appleRootCertificates(),
    true,
    environment,
    required('APPLE_IAP_BUNDLE_ID'),
    appAppleId,
  );
}

async function verifyApplePurchase({ productId, transactionId }) {
  const library = require('@apple/app-store-server-library');
  const preferred = preferredAppleEnvironment(library);
  const environments = preferred === library.Environment.PRODUCTION
    ? [library.Environment.PRODUCTION, library.Environment.SANDBOX]
    : [library.Environment.SANDBOX, library.Environment.PRODUCTION];
  let lastError;
  for (const environment of environments) {
    try {
      const client = new library.AppStoreServerAPIClient(
        applePrivateKey(),
        required('APPLE_IAP_KEY_ID'),
        required('APPLE_IAP_ISSUER_ID'),
        required('APPLE_IAP_BUNDLE_ID'),
        environment,
      );
      const response = await client.getTransactionInfo(String(transactionId));
      const transaction = await appleVerifier(library, environment)
        .verifyAndDecodeTransaction(response.signedTransactionInfo);
      if (transaction.bundleId !== required('APPLE_IAP_BUNDLE_ID') || transaction.productId !== productId) {
        throw Object.assign(new Error('Apple ürünü veya uygulama kimliği eşleşmiyor.'), { code: 'STORE_MISMATCH' });
      }
      if (transaction.revocationDate) {
        throw Object.assign(new Error('Apple işlemi iptal edilmiş.'), { code: 'PURCHASE_REVOKED' });
      }
      return {
        transactionKey: String(transaction.transactionId || transactionId),
        environment: environment === library.Environment.SANDBOX ? 'sandbox' : 'production',
        status: 'verified',
      };
    } catch (error) {
      if (error.code === 'STORE_MISMATCH' || error.code === 'PURCHASE_REVOKED') throw error;
      lastError = error;
    }
  }
  throw lastError || new Error('Apple satın alma işlemi doğrulanamadı.');
}

function googleCredentials() {
  const filePath = String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PATH || '').trim();
  if (filePath) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return JSON.parse(Buffer.from(required('GOOGLE_PLAY_SERVICE_ACCOUNT_BASE64'), 'base64').toString('utf8'));
}

let cachedGoogleAccessToken = null;

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

async function googleAccessToken() {
  if (cachedGoogleAccessToken?.expiresAt > Date.now() + 60_000) {
    return cachedGoogleAccessToken.value;
  }
  const credentials = googleCredentials();
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: credentials.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key)
    .toString('base64url');
  const response = await fetch(credentials.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!response.ok) throw new Error(`Google OAuth token request failed: ${response.status}`);
  const payload = await response.json();
  cachedGoogleAccessToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (Number(payload.expires_in || 3600) * 1000),
  };
  return cachedGoogleAccessToken.value;
}

async function googlePublisherRequest(path, { method = 'GET' } = {}) {
  const response = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/${path}`, {
    method,
    headers: { authorization: `Bearer ${await googleAccessToken()}` },
  });
  if (!response.ok) {
    throw new Error(`Google Play Developer API request failed: ${response.status}`);
  }
  return response.status === 204 ? {} : response.json();
}

async function verifyGooglePurchase({ productId, purchaseToken }) {
  const packageName = required('GOOGLE_PLAY_PACKAGE_NAME');
  const data = await googlePublisherRequest(
    `applications/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`,
  );
  const state = Number(data.purchaseState);
  if (state === 2) {
    return {
      transactionKey: purchaseTokenHash(purchaseToken),
      environment: data.purchaseType === 0 ? 'test' : 'production',
      status: 'pending',
    };
  }
  if (state !== 0) {
    throw Object.assign(new Error('Google Play satın alma işlemi tamamlanmamış.'), { code: 'PURCHASE_NOT_COMPLETED' });
  }
  if (data.productId && data.productId !== productId) {
    throw Object.assign(new Error('Google Play ürünü eşleşmiyor.'), { code: 'STORE_MISMATCH' });
  }
  return {
    transactionKey: purchaseTokenHash(purchaseToken),
    environment: data.purchaseType === 0 ? 'test' : 'production',
    status: 'verified',
    orderId: data.orderId || null,
  };
}

async function consumeGooglePurchase({ productId, purchaseToken }) {
  const packageName = required('GOOGLE_PLAY_PACKAGE_NAME');
  await googlePublisherRequest(
    `applications/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`,
    { method: 'POST' },
  );
}

async function verifyStorePurchase({ platform, productId, purchaseId, verificationData }) {
  if (!getPromotionProduct(productId)) {
    throw Object.assign(new Error('Bilinmeyen öne çıkarma paketi.'), { code: 'UNKNOWN_PRODUCT' });
  }
  if (platform === 'ios') {
    if (!purchaseId) throw Object.assign(new Error('Apple işlem kimliği eksik.'), { code: 'MISSING_PROOF' });
    return verifyApplePurchase({ productId, transactionId: purchaseId });
  }
  if (platform === 'android') {
    if (!verificationData) throw Object.assign(new Error('Google Play satın alma kanıtı eksik.'), { code: 'MISSING_PROOF' });
    return verifyGooglePurchase({ productId, purchaseToken: verificationData });
  }
  throw Object.assign(new Error('Geçersiz mağaza platformu.'), { code: 'INVALID_PLATFORM' });
}

async function decodeAppleNotification(signedPayload) {
  const library = require('@apple/app-store-server-library');
  const preferred = preferredAppleEnvironment(library);
  const environments = preferred === library.Environment.PRODUCTION
    ? [library.Environment.PRODUCTION, library.Environment.SANDBOX]
    : [library.Environment.SANDBOX, library.Environment.PRODUCTION];
  let lastError;
  for (const environment of environments) {
    try {
      const verifier = appleVerifier(library, environment);
      const notification = await verifier.verifyAndDecodeNotification(signedPayload);
      const transaction = notification.data?.signedTransactionInfo
        ? await verifier.verifyAndDecodeTransaction(notification.data.signedTransactionInfo)
        : null;
      return { notification, transaction };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Apple bildirimi doğrulanamadı.');
}

module.exports = {
  purchaseTokenHash,
  verifyStorePurchase,
  verifyGooglePurchase,
  consumeGooglePurchase,
  decodeAppleNotification,
};
