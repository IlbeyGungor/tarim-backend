require('dotenv').config();
const { pool } = require('./index');

const migrate = async () => {
  const client = await pool.connect();
  try {

    const dbInfo = await client.query(`
  SELECT
    current_database() AS db,
    inet_server_addr() AS host,
    inet_server_port() AS port,
    current_user AS user
`);
console.log('DB INFO:', dbInfo.rows[0]);
    await client.query('BEGIN');

    // Enable UUID extension
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    // ── users ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name            VARCHAR(120) NOT NULL,
        phone           VARCHAR(20)  NOT NULL UNIQUE,
        password_hash   VARCHAR(255) NOT NULL,
        role            VARCHAR(30)  NOT NULL CHECK (role IN ('farmer','middleman','trader')),
        city            VARCHAR(80),
        district        VARCHAR(80),
        address         VARCHAR(255),
        bio             TEXT,
        tc_verified     BOOLEAN DEFAULT FALSE,
        cks_verified    BOOLEAN DEFAULT FALSE,
        is_verified     BOOLEAN DEFAULT FALSE,
        rating          NUMERIC(3,2) DEFAULT 0.0,
        total_trades    INTEGER DEFAULT 0,
        profile_image   VARCHAR(255),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── listings ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS listings (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        seller_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        crop_name       VARCHAR(120) NOT NULL,
        category        VARCHAR(40)  NOT NULL CHECK (category IN ('grain','vegetable','fruit','nut','legume','other')),
        quantity        NUMERIC(12,2) NOT NULL,
        unit            VARCHAR(20)  NOT NULL DEFAULT 'kg',
        price_per_unit  NUMERIC(10,2) NOT NULL,
        price_type      VARCHAR(20)  NOT NULL CHECK (price_type IN ('fixed','negotiate')) DEFAULT 'negotiate',
        city            VARCHAR(80),
        district        VARCHAR(80),
        address         VARCHAR(255),
        description     TEXT,
        status          VARCHAR(20)  NOT NULL CHECK (status IN ('active','sold','reserved')) DEFAULT 'active',
        harvest_date    DATE,
        view_count      INTEGER DEFAULT 0,
        offer_count     INTEGER DEFAULT 0,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── offers ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS offers (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        listing_id      UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        buyer_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        offered_price   NUMERIC(10,2) NOT NULL,
        quantity        NUMERIC(12,2) NOT NULL,
        message         TEXT,
        status          VARCHAR(20)  NOT NULL CHECK (status IN ('pending','accepted','rejected','countered','completed')) DEFAULT 'pending',
        counter_price   NUMERIC(10,2),
        counter_by      VARCHAR(20) CHECK (counter_by IN ('seller','buyer')),
        buyer_deleted_at TIMESTAMPTZ,
        seller_deleted_at TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── messages ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        offer_id    UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
        sender_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text        TEXT NOT NULL,
        is_read     BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── market_prices ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS market_prices (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        product     VARCHAR(100) NOT NULL,
        icon        VARCHAR(10),
        city        VARCHAR(80)  NOT NULL,
        min_price   NUMERIC(10,2) NOT NULL,
        max_price   NUMERIC(10,2) NOT NULL,
        avg_price   NUMERIC(10,2) NOT NULL,
        unit        VARCHAR(20)  NOT NULL DEFAULT 'kg',
        trend       NUMERIC(6,4) DEFAULT 0,
        price_date  DATE DEFAULT CURRENT_DATE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── market_price_history ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS market_price_history (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        product          VARCHAR(100) NOT NULL,
        market           VARCHAR(120) NOT NULL,
        city             VARCHAR(80)  NOT NULL,
        production_type  VARCHAR(80)  NOT NULL,
        icon             VARCHAR(10),
        min_price        NUMERIC(10,2),
        max_price        NUMERIC(10,2),
        avg_price        NUMERIC(10,2) NOT NULL,
        unit             VARCHAR(20)  NOT NULL DEFAULT 'kg',
        price_date       DATE NOT NULL,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (product, market, city, production_type ,price_date)
      )
    `);

    // ── market_price_latest ───────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS market_price_latest (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        product          VARCHAR(100) NOT NULL,
        market           VARCHAR(120) NOT NULL,
        city             VARCHAR(80)  NOT NULL,
        production_type  VARCHAR(80)  NOT NULL,
        icon             VARCHAR(10),
        min_price        NUMERIC(10,2),
        max_price        NUMERIC(10,2),
        avg_price        NUMERIC(10,2) NOT NULL,
        unit             VARCHAR(20)  NOT NULL DEFAULT 'kg',
        latest_price_date DATE NOT NULL,
        prev_price_date  DATE,
        trend            NUMERIC(10,4) DEFAULT 0,
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (product, market, city, production_type)
      )
    `);

    // ── Indexes ────────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_seller     ON listings(seller_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_city       ON listings(city)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_category   ON listings(category)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_status     ON listings(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_listing      ON offers(listing_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_buyer        ON offers(buyer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_offer      ON messages(offer_id)`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_market_price_history_lookup
      ON market_price_history(product, market, city, price_date DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_market_price_latest_lookup
      ON market_price_latest(product, market, city)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_market_price_latest_date
      ON market_price_latest(latest_price_date DESC)
    `);

    await client.query('COMMIT');
    console.log('✅  Migration complete — all tables created');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate();
