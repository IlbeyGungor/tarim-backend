const PASSWORD_RESET_ENDPOINT =
  'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode';

const HIDDEN_ACCOUNT_ERRORS = new Set([
  'EMAIL_NOT_FOUND',
  'USER_DISABLED',
]);

function firebaseErrorCode(payload) {
  return String(payload?.error?.message || '').split(' : ')[0].trim();
}

async function sendFirebasePasswordResetEmail(
  email,
  {
    apiKey = process.env.FIREBASE_WEB_API_KEY,
    fetchImpl = globalThis.fetch,
  } = {}
) {
  if (!apiKey) {
    const error = new Error('FIREBASE_WEB_API_KEY tanımlı değil.');
    error.status = 500;
    throw error;
  }
  if (typeof fetchImpl !== 'function') {
    const error = new Error('Firebase şifre sıfırlama isteği gönderilemiyor.');
    error.status = 500;
    throw error;
  }

  const response = await fetchImpl(
    `${PASSWORD_RESET_ENDPOINT}?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Firebase-Locale': 'tr',
      },
      body: JSON.stringify({
        requestType: 'PASSWORD_RESET',
        email,
      }),
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (response.ok) return true;

  const code = firebaseErrorCode(payload);
  if (HIDDEN_ACCOUNT_ERRORS.has(code)) return false;

  const error = new Error(
    code
      ? `Firebase şifre sıfırlama isteği başarısız: ${code}`
      : 'Firebase şifre sıfırlama isteği başarısız.'
  );
  error.status = code === 'TOO_MANY_ATTEMPTS_TRY_LATER' ? 429 : 502;
  throw error;
}

module.exports = {
  PASSWORD_RESET_ENDPOINT,
  sendFirebasePasswordResetEmail,
};
