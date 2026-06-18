// src/utils/notify.js
// Sends push notifications via Firebase Cloud Messaging (FCM)

const admin = require('firebase-admin');
const { query } = require('../db');

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

function notificationData(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, String(value)])
  );
}

async function sendToUser(userId, { title, body, data = {} }) {
  if (!initialized) return;

  try {
    const { rows } = await query(
      'SELECT token FROM device_tokens WHERE user_id=$1',
      [userId]
    );
    if (!rows.length) return;

    const tokens = rows.map(r => r.token);

    const message = {
      notification: { title, body },
      data: notificationData({
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      }),
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

    const response = await admin.messaging().sendEachForMulticast(message);

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
        await query(
          'DELETE FROM device_tokens WHERE token = ANY($1)',
          [toDelete]
        );
      }
    }
  } catch (err) {
    console.error('Push notification error:', err.message);
  }
}

const notify = {
  async newOffer({ sellerId, buyerName, cropName, offeredPrice, unit, offerId, listingId }) {
    await sendToUser(sellerId, {
      title: '🌾 Yeni Teklif Aldınız',
      body: `${buyerName}, "${cropName}" ilanınıza ₺${parseFloat(offeredPrice).toFixed(2)}/${unit} teklif etti.`,
      data: { type: 'new_offer', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async offerAccepted({ buyerId, sellerName, cropName, offerId, listingId }) {
    await sendToUser(buyerId, {
      title: '✅ Teklifiniz Kabul Edildi!',
      body: `${sellerName}, "${cropName}" için teklifinizi kabul etti. İletişime geçebilirsiniz.`,
      data: { type: 'offer_accepted', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async offerRejected({ buyerId, cropName, offerId, listingId }) {
    await sendToUser(buyerId, {
      title: '❌ Teklifiniz Reddedildi',
      body: `"${cropName}" için verdiğiniz teklif reddedildi. Yeni bir teklif verebilirsiniz.`,
      data: { type: 'offer_rejected', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async offerRejectedByAcceptedOther({ buyerId, sellerName, cropName, offerId, listingId }) {
    await sendToUser(buyerId, {
      title: '❌ Teklifiniz Reddedildi',
      body: `${sellerName}, "${cropName}" ilanında başka bir teklifi kabul etti. Teklifiniz otomatik olarak reddedildi.`,
      data: { type: 'offer_rejected_other_accepted', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async counterOffer({ recipientId, senderName, cropName, counterPrice, unit, offerId, madeBy, listingId }) {
    const who = madeBy === 'seller' ? 'Satıcı' : 'Alıcı';
    await sendToUser(recipientId, {
      title: '🔄 Karşı Teklif Geldi',
      body: `${who} ${senderName}, "${cropName}" için ₺${parseFloat(counterPrice).toFixed(2)}/${unit} karşı teklif yaptı.`,
      data: { type: 'counter_offer', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async finalOffer({ sellerId, buyerName, cropName, finalPrice, unit, offerId, listingId }) {
    await sendToUser(sellerId, {
      title: '⚡ Son Teklif Geldi',
      body: `${buyerName}, "${cropName}" için son teklifini yaptı: ₺${parseFloat(finalPrice).toFixed(2)}/${unit}`,
      data: { type: 'final_offer', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async counterCancelled({ recipientId, senderName, cropName, offerId, listingId }) {
    await sendToUser(recipientId, {
      title: '↩️ Karşı Teklif Geri Alındı',
      body: `${senderName}, "${cropName}" için yaptığı karşı teklifi geri aldı. Yeni teklif beklenebilir.`,
      data: { type: 'counter_cancelled', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async chatMessage({ recipientId, senderName, text, offerId, listingId }) {
    const cleanText = String(text || '').trim();
    const preview = cleanText.length > 80 ? `${cleanText.slice(0, 77)}...` : cleanText;
    await sendToUser(recipientId, {
      title: `💬 ${senderName}`,
      body: preview || 'Yeni mesajınız var.',
      data: { type: 'chat_message', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async reviewReceived({ revieweeId, reviewerName, rating, offerId }) {
    await sendToUser(revieweeId, {
      title: '⭐ Yeni Değerlendirme Aldınız',
      body: `${reviewerName}, size ${rating}/5 puan verdi ve değerlendirme yazdı.`,
      data: { type: 'review_received', offer_id: String(offerId) },
    });
  },
};

module.exports = notify;
