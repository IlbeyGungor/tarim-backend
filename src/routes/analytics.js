const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { rateLimit } = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');
const {
  recordContactEvent,
  resolveCallTarget,
} = require('../services/contactAnalytics');

const callLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Çok fazla analytics isteği gönderildi.' },
});

router.post('/contacts/call', authMiddleware.optional, callLimiter, [
  body('event_id').isString().isLength({ min: 8, max: 160 }),
  body('listing_id').isUUID(),
  body('offer_id').optional({ nullable: true }).isUUID(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    const target = await resolveCallTarget({
      listingId: req.body.listing_id,
      offerId: req.body.offer_id || null,
      actorUserId: req.user?.id || null,
    });
    if (!target) {
      return res.status(404).json({ error: 'Arama hedefi bulunamadı.' });
    }
    const recorded = await recordContactEvent({
      eventId: req.body.event_id,
      channel: 'call',
      actorUserId: req.user?.id || null,
      recipientUserId: target.recipientUserId,
      listingId: target.listingId,
      offerId: target.offerId,
      isGuest: !req.user,
    });
    res.status(recorded ? 201 : 200).json({ ok: true, recorded });
  } catch (error) { next(error); }
});

module.exports = router;
