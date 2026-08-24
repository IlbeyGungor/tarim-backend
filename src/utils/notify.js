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
  if (!initialized) return { sent: false, retryable: true, reason: 'firebase_not_initialized' };

  try {
    const { rows } = await query(
      'SELECT token FROM device_tokens WHERE user_id=$1',
      [userId]
    );
    if (!rows.length) return { sent: false, retryable: false, reason: 'no_device_token' };

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
      android: {
        priority: 'high',
        notification: {
          icon: 'ic_stat_tarim_pazar',
          color: '#34C759',
          sound: 'default',
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
    return {
      sent: response.successCount > 0,
      retryable: response.successCount === 0 && response.failureCount > 0,
      successCount: response.successCount,
      failureCount: response.failureCount,
    };
  } catch (err) {
    console.error('Push notification error:', err.message);
    return { sent: false, retryable: true, reason: err.message };
  }
}

const notify = {
  async newOffer({ ownerId, sellerId, proposerName, buyerName, cropName, offeredPrice, unit, offerId, listingId, listingType = 'sell' }) {
    const role = listingType === 'buy' ? 'satıcı' : 'alıcı';
    await sendToUser(ownerId || sellerId, {
      title: '🌾 Yeni Teklif Aldınız',
      body: `${proposerName || buyerName || `Bir ${role}`}, "${cropName}" ilanınıza ₺${parseFloat(offeredPrice).toFixed(2)}/${unit} teklif etti.`,
      data: { type: 'new_offer', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async offerAccepted({ recipientId, buyerId, actorName, sellerName, cropName, offerId, listingId, acceptedCounter = false }) {
    await sendToUser(recipientId || buyerId, {
      title: acceptedCounter
        ? '✅ Karşı Teklifiniz Kabul Edildi!'
        : '✅ Teklifiniz Kabul Edildi!',
      body: acceptedCounter
        ? `${actorName || sellerName}, "${cropName}" için karşı teklifinizi kabul etti. İletişime geçebilirsiniz.`
        : `${actorName || sellerName}, "${cropName}" için teklifinizi kabul etti. İletişime geçebilirsiniz.`,
      data: { type: 'offer_accepted', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async offerRejected({ recipientId, buyerId, cropName, offerId, listingId }) {
    await sendToUser(recipientId || buyerId, {
      title: '❌ Teklifiniz Reddedildi',
      body: `"${cropName}" için verdiğiniz teklif reddedildi. Yeni bir teklif verebilirsiniz.`,
      data: { type: 'offer_rejected', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async offerAutoRejected({ recipientId, ownerName, cropName, offerId, listingId, reason }) {
    const body = reason === 'listing_closed'
      ? `${ownerName}, "${cropName}" ilanını kapattı. Açık teklifiniz otomatik olarak reddedildi.`
      : `${ownerName}, "${cropName}" ilanındaki hedef miktarı tamamladı. Açık teklifiniz otomatik olarak reddedildi.`;
    await sendToUser(recipientId, {
      title: '❌ Teklifiniz Reddedildi',
      body,
      data: { type: 'offer_rejected_other_accepted', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async counterOffer({ recipientId, senderName, cropName, counterPrice, unit, offerId, madeBy, actorRole, listingId }) {
    const who = actorRole || (madeBy === 'seller' ? 'İlan sahibi' : 'Teklif veren');
    await sendToUser(recipientId, {
      title: '🔄 Karşı Teklif Geldi',
      body: `${who} ${senderName}, "${cropName}" için ₺${parseFloat(counterPrice).toFixed(2)}/${unit} karşı teklif yaptı.`,
      data: { type: 'counter_offer', offer_id: String(offerId), listing_id: String(listingId) },
    });
  },

  async finalOffer({ recipientId, sellerId, proposerName, buyerName, cropName, finalPrice, unit, offerId, listingId }) {
    await sendToUser(recipientId || sellerId, {
      title: '⚡ Son Teklif Geldi',
      body: `${proposerName || buyerName}, "${cropName}" için son teklifini yaptı: ₺${parseFloat(finalPrice).toFixed(2)}/${unit}`,
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

  async reviewReceived({ revieweeId, reviewerName, rating, offerId, hasMessage = false }) {
    await sendToUser(revieweeId, {
      title: '⭐ Yeni Değerlendirme Aldınız',
      body: hasMessage
        ? `${reviewerName}, size ${rating}/5 puan verdi ve değerlendirme yazdı.`
        : `${reviewerName}, size ${rating}/5 puan verdi.`,
      data: { type: 'review_received', offer_id: String(offerId) },
    });
  },

  async listingMatch({ recipientId, cropName, newListingType, listingId, matchReason }) {
    const isBuyerListing = newListingType === 'buy';
    const listingTypeLabel = isBuyerListing ? 'Aranıyor' : 'Satılık';
    return sendToUser(recipientId, {
      title: 'Yeni İlan Eşleşmesi',
      body: matchReason === 'favorite_product'
        ? `Favorilerinizdeki ${cropName} için yeni ${listingTypeLabel} ilan yayınlandı.`
        : isBuyerListing
          ? `${cropName} arayan yeni bir ilan yayınlandı.`
          : `${cropName} satan yeni bir ilan yayınlandı.`,
      data: { type: 'listing_match', listing_id: String(listingId) },
    });
  },

  async listingUpdated({ recipientId, cropName, listingId }) {
    return sendToUser(recipientId, {
      title: 'İlan Güncellendi',
      body: `Teklif verdiğiniz "${cropName}" ilanının bilgileri güncellendi.`,
      data: { type: 'listing_updated', listing_id: String(listingId) },
    });
  },
};

module.exports = notify;
