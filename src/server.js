require('dotenv').config();
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const path    = require('path');

const authRoutes     = require('./routes/auth');
const listingRoutes  = require('./routes/listings');
const offerRoutes    = require('./routes/offers');
const { pricesRouter, usersRouter } = require('./routes/other');
const errorHandler   = require('./middleware/errorHandler');

const app  = express();
const PORT = process.env.PORT || 3000;

const uploadRoutes = require('./routes/upload');
app.use('/api/listings', uploadRoutes);

const tokenRoutes = require('./routes/tokens');
app.use('/api/tokens', tokenRoutes);

// ── Security & parsing ────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://yourapp.com']       // replace with your domain
    : '*',
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/offers',   offerRoutes);
app.use('/api/prices',   pricesRouter);
app.use('/api/users',    usersRouter);

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

module.exports = app;
