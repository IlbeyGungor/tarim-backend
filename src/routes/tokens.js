// src/routes/tokens.js
// Handles device token registration and removal

const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');

// POST /api/tokens  — register or update device token
router.post('/', authMiddleware, [
  body('token').trim().notEmpty().withMessage('Token zorunludur.'),
  body('platform').isIn(['ios', 'android']).withMessage('Platform ios veya android olmalıdır.'),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { token, platform } = req.body;

    // Upsert — insert or update timestamp if token already exists
    await query(`
      INSERT INTO device_tokens (user_id, token, platform)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, token) DO UPDATE SET updated_at = NOW()
    `, [req.user.id, token, platform]);

    res.json({ message: 'Token kaydedildi.' });
  } catch (err) { next(err); }
});

// DELETE /api/tokens  — remove token on logout
router.delete('/', authMiddleware, [
  body('token').trim().notEmpty(),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    await query(
      'DELETE FROM device_tokens WHERE user_id=$1 AND token=$2',
      [req.user.id, req.body.token]
    );
    res.json({ message: 'Token silindi.' });
  } catch (err) { next(err); }
});

module.exports = router;
