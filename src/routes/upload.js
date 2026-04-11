// src/routes/upload.js
// Install dependencies first:
//   npm install cloudinary multer multer-storage-cloudinary

const router = require('express').Router();
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');

// Configure Cloudinary — set these in your .env
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Use memory storage — file goes straight to Cloudinary, not disk
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max per file
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Sadece görsel dosyaları kabul edilir.'));
  },
});

// POST /api/listings/:id/images
// Accepts up to 5 images, uploads to Cloudinary, stores URLs in DB
router.post('/:id/images', authMiddleware, upload.array('images', 5), async (req, res, next) => {
  try {
    // Verify listing exists and belongs to the current user
    const { rows: listing } = await query(
      'SELECT * FROM listings WHERE id=$1', [req.params.id]
    );
    if (!listing.length) return res.status(404).json({ error: 'İlan bulunamadı.' });
    if (listing[0].seller_id !== req.user.id) return res.status(403).json({ error: 'Yetki yok.' });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Görsel seçilmedi.' });
    }

    // Upload each file to Cloudinary
    const uploadPromises = req.files.map(file => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: `tarim-pazar/listings/${req.params.id}`,
            transformation: [
              { width: 1200, height: 900, crop: 'limit' }, // max size
              { quality: 'auto:good' },                     // auto compression
              { fetch_format: 'auto' },                     // WebP for supported browsers
            ],
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result.secure_url);
          }
        );
        stream.end(file.buffer);
      });
    });

    const urls = await Promise.all(uploadPromises);

    // Merge with any existing image URLs (don't overwrite, append)
    const existing = listing[0].image_urls || [];
    const merged = [...existing, ...urls].slice(0, 5); // max 5 total

    const { rows: updated } = await query(`
      UPDATE listings SET image_urls=$1, updated_at=NOW()
      WHERE id=$2
      RETURNING *,
        (SELECT row_to_json(u) FROM (
          SELECT id,name,phone,role,city,district,tc_verified,cks_verified,
                 is_verified,rating,total_trades FROM users WHERE id=listings.seller_id
        ) u) AS seller
    `, [JSON.stringify(merged), req.params.id]);

    res.json(updated[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/listings/:id/images  — remove a specific image by URL
router.delete('/:id/images', authMiddleware, async (req, res, next) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl gerekli.' });

    const { rows: listing } = await query('SELECT * FROM listings WHERE id=$1', [req.params.id]);
    if (!listing.length) return res.status(404).json({ error: 'İlan bulunamadı.' });
    if (listing[0].seller_id !== req.user.id) return res.status(403).json({ error: 'Yetki yok.' });

    const existing = listing[0].image_urls || [];
    const filtered = existing.filter(url => url !== imageUrl);

    // Delete from Cloudinary too
    try {
      const publicId = imageUrl.split('/').slice(-2).join('/').replace(/\.[^.]+$/, '');
      await cloudinary.uploader.destroy(publicId);
    } catch (_) { /* ignore cloudinary delete errors */ }

    await query('UPDATE listings SET image_urls=$1, updated_at=NOW() WHERE id=$2',
      [JSON.stringify(filtered), req.params.id]);

    res.json({ message: 'Görsel silindi.', imageUrls: filtered });
  } catch (err) { next(err); }
});

module.exports = router;
