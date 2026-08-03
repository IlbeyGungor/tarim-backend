const admin = require('firebase-admin');

function ensureFirebaseAdmin() {
  if (admin.apps.length) return admin.app();
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT tanımlı değil.');
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

function firebaseAuth() {
  ensureFirebaseAdmin();
  return admin.auth();
}

module.exports = { ensureFirebaseAdmin, firebaseAuth };
