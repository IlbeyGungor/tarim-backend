require('dotenv').config();
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const path    = require('path');

const { scheduleMarketPriceUpdate } = require('./jobs/scheduleMarketPriceUpdate');
const authRoutes     = require('./routes/auth');
const listingRoutes  = require('./routes/listings');
const offerRoutes    = require('./routes/offers');
const adminRoutes    = require('./routes/admin');
const productRoutes  = require('./routes/products');
const interestRoutes = require('./routes/interests');
const { pricesRouter, usersRouter } = require('./routes/other');
const errorHandler   = require('./middleware/errorHandler');
const { scheduleReservedListingCleanup } = require('./jobs/cleanupReservedListings');
const { scheduleListingMatchRetries } = require('./services/listingMatches');
const { scheduleProductInterestPruning } = require('./services/productInterest');
const { listingPageRouter, listingSitemap } = require('./routes/listingPages');

const app  = express();
const PORT = process.env.PORT || 3000;

const uploadRoutes = require('./routes/upload');
const tokenRoutes = require('./routes/tokens');

const defaultCorsOrigins = [
  'https://app.tarim-pazar.com',
  'https://tarim-pazar.com',
  'https://www.tarim-pazar.com',
  'https://tarim-pazar.web.app',
  'https://tarim-pazar.firebaseapp.com',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost:8080',
  'http://localhost:8081',
];
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedCorsOrigins = new Set([
  ...defaultCorsOrigins,
  ...corsOrigins,
]);

function isAllowedCorsOrigin(origin) {
  if (allowedCorsOrigins.has(origin)) return true;

  try {
    const { protocol, hostname } = new URL(origin);
    return (
      (protocol === 'http:' || protocol === 'https:') &&
      (hostname === 'localhost' || hostname === '127.0.0.1')
    );
  } catch (_) {
    return false;
  }
}

// Security & parsing
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || process.env.NODE_ENV !== 'production') {
      callback(null, true);
      return;
    }
    callback(null, isAllowedCorsOrigin(origin));
  },
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','Cache-Control','Pragma'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/listings', uploadRoutes);
app.use('/api/tokens', tokenRoutes);

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/offers',   offerRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/products', productRoutes);
app.use('/api/interests', interestRoutes);
app.use('/api/prices',   pricesRouter);
app.use('/api/users',    usersRouter);
app.use('/ilan',         listingPageRouter);
app.get('/ilan-sitemap.xml', listingSitemap);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Tarım Pazar API',
    timestamp: new Date().toISOString(),
  });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Endpoint bulunamadı.' }));

// Global error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`\n🌾  Tarım Pazar API running on http://localhost:${PORT}`);
  console.log(`   ENV: ${process.env.NODE_ENV || 'development'}\n`);
});

scheduleReservedListingCleanup();
scheduleMarketPriceUpdate();
scheduleListingMatchRetries();
scheduleProductInterestPruning();

module.exports = app;
