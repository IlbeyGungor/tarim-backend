const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { rateLimit } = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');
const { query } = require('../db');
const { recordProductInterest } = require('../services/productInterest');

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

router.post('/events', authMiddleware, limiter, [
  body('event_id').isString().isLength({ min: 8, max: 160 }),
  body('event_type').isIn(['listing_view','search','call_button_click']),
  body('listing_id').optional({ nullable: true }).isUUID(),
  body('product_name').optional({ nullable: true }).isString().isLength({ min: 1, max: 160 }),
  body('category').optional({ nullable: true }).isIn(['grain','vegetable','fruit','nut','legume','other']),
  body('listing_type').optional().isIn(['sell','buy']),
  body('active_seconds').optional().isInt({ min: 0, max: 120 }),
  body('session_id').optional({ nullable: true }).isString().isLength({ min: 8, max: 160 }),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  try {
    let listing = null;
    if (req.body.listing_id) {
      const result = await query('SELECT * FROM listings WHERE id=$1', [req.body.listing_id]);
      listing = result.rows[0] || null;
      if (!listing) return res.status(404).json({ error: 'İlan bulunamadı.' });
    }
    const recorded = await recordProductInterest({
      userId: req.user.id,
      eventId: req.body.event_id,
      eventType: req.body.event_type,
      listing,
      productName: req.body.product_name,
      category: req.body.category,
      listingType: req.body.listing_type,
      activeSeconds: req.body.active_seconds,
      sessionId: req.body.session_id,
    });
    res.json({ ok: true, recorded });
  } catch (err) { next(err); }
});

module.exports = router;
