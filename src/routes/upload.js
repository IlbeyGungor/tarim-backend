// src/routes/upload.js
// Install dependencies first:
//   npm install cloudinary multer multer-storage-cloudinary

const router = require('express').Router();
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { query } = require('../db');
const authMiddleware = require('../middleware/auth');
const {
  cloudinaryPublicId,
  parseRetainedImageUrls,
  validateRetainedImageUrls,
} = require('../services/listingImages');

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

function uploadListingImage(file, listingId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `tarim-pazar/listings/${listingId}`,
        transformation: [
          { width: 1200, height: 900, crop: 'limit' },
          { quality: 'auto:good' },
          { fetch_format: 'auto' },
        ],
      },
      (error, result) => {
        if (error) reject(error);
        else resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(file.buffer);
  });
}

async function destroyImages(publicIds) {
  await Promise.allSettled(
    publicIds.filter(Boolean).map((publicId) => cloudinary.uploader.destroy(publicId))
  );
}

// PUT /api/listings/:id/images — atomically replace retained and newly uploaded images.
router.put('/:id/images', authMiddleware, upload.array('images', 5), async (req, res, next) => {
  let uploaded = [];
  try {
    const { rows } = await query('SELECT * FROM listings WHERE id=$1', [req.params.id]);
    const listing = rows[0];
    if (!listing) return res.status(404).json({ error: 'İlan bulunamadı.' });
    if (listing.seller_id !== req.user.id) return res.status(403).json({ error: 'Yetki yok.' });
    if (listing.status !== 'active') {
      return res.status(409).json({
        error: 'Yalnızca aktif ilanların fotoğrafları düzenlenebilir.',
        code: 'LISTING_NOT_ACTIVE',
      });
    }

    const retained = parseRetainedImageUrls(req.body.retained_image_urls);
    validateRetainedImageUrls(listing.image_urls || [], retained);
    const files = req.files || [];
    if (retained.length + files.length > 5) {
      return res.status(400).json({ error: 'Bir ilanda en fazla 5 fotoğraf olabilir.' });
    }

    const results = await Promise.allSettled(
      files.map((file) => uploadListingImage(file, listing.id))
    );
    uploaded = results.filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      await destroyImages(uploaded.map((item) => item.publicId));
      uploaded = [];
      throw failed.reason;
    }

    const imageUrls = [...retained, ...uploaded.map((item) => item.url)];
    const { rows: updatedRows } = await query(`
      UPDATE listings SET image_urls=$1,updated_at=NOW()
      WHERE id=$2 AND seller_id=$3 AND status='active' AND image_urls=$4::jsonb
      RETURNING *,
        (SELECT row_to_json(u) FROM (
          SELECT id,name,phone,phone_verified,city,district,tc_verified,cks_verified,
                 is_verified,rating,total_trades,profile_image FROM users
          WHERE id=listings.seller_id
        ) u) AS seller
    `, [
      JSON.stringify(imageUrls),
      listing.id,
      req.user.id,
      JSON.stringify(listing.image_urls || []),
    ]);
    if (!updatedRows.length) {
      await destroyImages(uploaded.map((item) => item.publicId));
      uploaded = [];
      return res.status(409).json({
        error: 'İlan fotoğrafları başka bir işlemde değişti. Lütfen yeniden deneyin.',
        code: 'LISTING_IMAGES_CHANGED',
      });
    }

    const removedPublicIds = (listing.image_urls || [])
      .filter((url) => !retained.includes(url))
      .map((url) => cloudinaryPublicId(url, listing.id));
    await destroyImages(removedPublicIds);
    res.json(updatedRows[0]);
  } catch (err) {
    if (uploaded.length) {
      await destroyImages(uploaded.map((item) => item.publicId));
    }
    next(err);
  }
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
    const uploaded = await Promise.all(
      req.files.map((file) => uploadListingImage(file, req.params.id))
    );
    const urls = uploaded.map((item) => item.url);

    // Merge with any existing image URLs (don't overwrite, append)
    const existing = listing[0].image_urls || [];
    const merged = [...existing, ...urls].slice(0, 5); // max 5 total

    const { rows: updated } = await query(`
      UPDATE listings SET image_urls=$1, updated_at=NOW()
      WHERE id=$2
      RETURNING *,
        (SELECT row_to_json(u) FROM (
          SELECT id,name,phone,phone_verified,city,district,tc_verified,cks_verified,
                 is_verified,rating,total_trades,profile_image FROM users WHERE id=listings.seller_id
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
      const publicId = cloudinaryPublicId(imageUrl, req.params.id);
      if (publicId) await cloudinary.uploader.destroy(publicId);
    } catch (_) { /* ignore cloudinary delete errors */ }

    await query('UPDATE listings SET image_urls=$1, updated_at=NOW() WHERE id=$2',
      [JSON.stringify(filtered), req.params.id]);

    res.json({ message: 'Görsel silindi.', imageUrls: filtered });
  } catch (err) { next(err); }
});

module.exports = router;
