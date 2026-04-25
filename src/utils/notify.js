// src/utils/notify.js
// Sends push notifications via Firebase Cloud Messaging (FCM)
// Install: npm install firebase-admin

const admin = require('firebase-admin');
const { query } = require('../db');

// Initialize Firebase Admin SDK once
// You get serviceAccount JSON from Firebase Console →
// Project Settings → Service Accounts → Generate new private key
let initialized = false;

function initFirebase() {
  if (initialized) return;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
    return;
  }
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    initialized = true;
    console.log('🔔  Firebase Admin initialized');
  } catch (err) {
    console.error('❌  Firebase init failed:', err.message);
  }
}

initFirebase();

// ── Core send function ──────────────────────────────────────────────────────

async function sendToUser(userId, { title, body, data = {} }) {
  if (!initialized) {
    console.log('🚨 sendToUser skipped: firebase not initialized');
    return;
  }

  try {
    console.log('🚨 sendToUser called', { userId, title, body, data });

    // Get all device tokens for this user
    const { rows } = await query(
      'SELECT token FROM device_tokens WHERE user_id=$1',
      [userId]
    );

    console.log('🚨 tokens fetched', {
      userId,
      tokenCount: rows.length,
      tokens: rows.map(r => r.token?.slice(0, 12)),
    });

    if (!rows.length) {
      console.log('🚨 no tokens found for user');
      return;
    }

    const tokens = rows.map(r => r.token);

    const message = {
      notification: { title, body },
      data: { ...data, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
      tokens,
    };

    console.log('🚨 about to send push via firebase-admin', {
      userId,
      tokenCount: tokens.length,
      tokenStarts: tokens.map(t => t?.slice(0, 12)),
    });

    const response = await admin.messaging().sendEachForMulticast(message);

    console.log('🚨 firebase-admin response', {
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses.map((r, i) => ({
        index: i,
        success: r.success,
        errorCode: r.error?.code,
        errorMessage: r.error?.message,
      })),
    });

    // Clean up invalid tokens
    if (response.failureCount > 0) {
      const toDelete = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            toDelete.push(tokens[idx]);
          }
        }
      });

      if (toDelete.length > 0) {
        console.log('🚨 deleting invalid tokens', {
          count: toDelete.length,
          tokenStarts: toDelete.map(t => t?.slice(0, 12)),
        });

        await query(
          'DELETE FROM device_tokens WHERE token = ANY($1)',
          [toDelete]
        );
      }
    }
  } catch (err) {
    console.log('🚨 push send failed', err);
    console.error('Push notification error:', err.message);
    // Never throw — notification failures should never break the main flow
  }
}

// ── Notification templates ──────────────────────────────────────────────────

const notify = {

  // New offer received — notify seller
  async newOffer({ sellerId, buyerName, cropName, offeredPrice, unit, offerId, listingId }) {
    console.log('🚨 notify.newOffer entered', {
      sellerId,
      buyerName,
      cropName,
      offeredPrice,
      unit,
      offerId,
      listingId,
    });

    await sendToUser(sellerId, {
      title: '🌾 Yeni Teklif Aldınız',
      body: `${buyerName}, "${cropName}" ilanınıza ₺${parseFloat(offeredPrice).toFixed(2)}/${unit} teklif etti.`,
      data: { type: 'new_offer', offer_id: offerId, listing_id: listingId },
    });
  },

  // Offer accepted — notify buyer
  async offerAccepted({ buyerId, sellerName, cropName, offerId }) {
    await sendToUser(buyerId, {
      title: '✅ Teklifiniz Kabul Edildi!',
      body: `${sellerName}, "${cropName}" için teklifinizi kabul etti. İletişime geçebilirsiniz.`,
      data: { type: 'offer_accepted', offer_id: offerId },
    });
  },

  // Offer rejected — notify buyer
  async offerRejected({ buyerId, cropName, offerId }) {
    await sendToUser(buyerId, {
      title: '❌ Teklifiniz Reddedildi',
      body: `"${cropName}" için verdiğiniz teklif reddedildi. Yeni bir teklif verebilirsiniz.`,
      data: { type: 'offer_rejected', offer_id: offerId },
    });
  },

  // Counter offer — notify the other party
  async counterOffer({ recipientId, senderName, cropName, counterPrice, unit, offerId, madeBy }) {
    const who = madeBy === 'seller' ? 'Satıcı' : 'Alıcı';
    await sendToUser(recipientId, {
      title: '🔄 Karşı Teklif Geldi',
      body: `${who} ${senderName}, "${cropName}" için ₺${parseFloat(counterPrice).toFixed(2)}/${unit} karşı teklif yaptı.`,
      data: { type: 'counter_offer', offer_id: offerId },
    });
  },

  // Buyer made a final offer — notify seller
  async finalOffer({ sellerId, buyerName, cropName, finalPrice, unit, offerId }) {
    await sendToUser(sellerId, {
      title: '⚡ Son Teklif Geldi',
      body: `${buyerName}, "${cropName}" için son teklifini yaptı: ₺${parseFloat(finalPrice).toFixed(2)}/${unit}`,
      data: { type: 'final_offer', offer_id: offerId },
    });
  },

  // Offer cancelled (counter withdrawn) — notify the other party
  async counterCancelled({ recipientId, senderName, cropName, offerId }) {
    await sendToUser(recipientId, {
      title: '↩️ Karşı Teklif Geri Alındı',
      body: `${senderName}, "${cropName}" için yaptığı karşı teklifi geri aldı. Yeni teklif beklenebilir.`,
      data: { type: 'counter_cancelled', offer_id: offerId },
    });
  },
};

module.exports = notify;
