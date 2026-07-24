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
        phone           VARCHAR(20) UNIQUE,
        phone_verified  BOOLEAN DEFAULT FALSE,
        firebase_uid    VARCHAR(128) UNIQUE,
        password_hash   VARCHAR(255) NOT NULL,
        city            VARCHAR(80),
        district        VARCHAR(80),
        address         VARCHAR(255),
        bio             TEXT,
        tc_verified     BOOLEAN DEFAULT FALSE,
        cks_verified    BOOLEAN DEFAULT FALSE,
        is_verified     BOOLEAN DEFAULT FALSE,
        rating          NUMERIC(3,2) DEFAULT 0.0,
        total_trades    INTEGER DEFAULT 0,
        profile_image   TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(128) UNIQUE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image TEXT`);
    await client.query(`ALTER TABLE users ALTER COLUMN phone DROP NOT NULL`);
    await client.query(`ALTER TABLE users ALTER COLUMN profile_image TYPE TEXT`);
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='users' AND column_name='role'
        ) THEN
          ALTER TABLE users ALTER COLUMN role DROP NOT NULL;
        END IF;
      END $$;
    `);

    // ── listings ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS listings (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        seller_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_type    VARCHAR(10) NOT NULL CHECK (listing_type IN ('sell','buy')) DEFAULT 'sell',
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
        fulfilled_quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
        reserved_at     TIMESTAMPTZ,
        reserved_until  TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        image_urls      JSONB NOT NULL DEFAULT '[]'::jsonb
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
        rejection_source VARCHAR(30) CHECK (rejection_source IN ('manual','listing_fulfilled','listing_closed','superseded')),
        buyer_deleted_at TIMESTAMPTZ,
        seller_deleted_at TIMESTAMPTZ,
        buyer_chat_deleted_at TIMESTAMPTZ,
        seller_chat_deleted_at TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Existing DBs may already have listings without reservation timestamps.
    await client.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ`);
    await client.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS listing_type VARCHAR(10) NOT NULL DEFAULT 'sell'`);
    await client.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS fulfilled_quantity NUMERIC(12,2) NOT NULL DEFAULT 0`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='listings_listing_type_check'
            AND conrelid='listings'::regclass
        ) THEN
          ALTER TABLE listings ADD CONSTRAINT listings_listing_type_check
          CHECK (listing_type IN ('sell','buy'));
        END IF;
      END $$;
    `);
    await client.query(`
      UPDATE listings
      SET reserved_at = COALESCE(reserved_at, updated_at, NOW()),
          reserved_until = COALESCE(reserved_until, COALESCE(reserved_at, updated_at, NOW()) + INTERVAL '7 days')
      WHERE status = 'reserved'
        AND reserved_until IS NULL
    `);

    await client.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS buyer_chat_deleted_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS seller_chat_deleted_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS rejection_source VARCHAR(30)`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='offers_rejection_source_check'
            AND conrelid='offers'::regclass
        ) THEN
          ALTER TABLE offers ADD CONSTRAINT offers_rejection_source_check
          CHECK (rejection_source IN ('manual','listing_fulfilled','listing_closed','superseded'));
        END IF;
      END $$;
    `);
    await client.query(`
      UPDATE listings l
      SET fulfilled_quantity = COALESCE((
        SELECT SUM(o.quantity)
        FROM offers o
        WHERE o.listing_id=l.id AND o.status IN ('accepted','completed')
      ), 0)
    `);

    // ── messages ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        offer_id    UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
        sender_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        text        TEXT NOT NULL,
        action_type VARCHAR(30) DEFAULT 'chat',
        price_snapshot NUMERIC(10,2),
        quantity_snapshot NUMERIC(12,2),
        unit_snapshot VARCHAR(20),
        is_read     BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS action_type VARCHAR(30) DEFAULT 'chat'`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS price_snapshot NUMERIC(10,2)`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS quantity_snapshot NUMERIC(12,2)`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS unit_snapshot VARCHAR(20)`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

    // ── reviews ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        offer_id     UUID NOT NULL,
        reviewer_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reviewee_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        message      TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (reviewer_id, reviewee_id)
      )
    `);
    await client.query(`ALTER TABLE reviews ALTER COLUMN message DROP NOT NULL`);

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
        scope            VARCHAR(20)  NOT NULL DEFAULT 'market',
        market           VARCHAR(120) NOT NULL,
        city             VARCHAR(80)  NOT NULL,
        production_type  VARCHAR(40)  NOT NULL DEFAULT 'Geleneksel',
        icon             VARCHAR(10),
        min_price        NUMERIC(10,2),
        max_price        NUMERIC(10,2),
        avg_price        NUMERIC(10,2) NOT NULL,
        unit             VARCHAR(20)  NOT NULL DEFAULT 'kg',
        price_date       DATE NOT NULL,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (product, market, city, production_type, price_date)
      )
    `);

    // ── market_price_latest ───────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS market_price_latest (
        id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        product           VARCHAR(100) NOT NULL,
        scope             VARCHAR(20)  NOT NULL DEFAULT 'market',
        market            VARCHAR(120) NOT NULL,
        city              VARCHAR(80)  NOT NULL,
        production_type   VARCHAR(40)  NOT NULL DEFAULT 'Geleneksel',
        icon              VARCHAR(10),
        min_price         NUMERIC(10,2),
        max_price         NUMERIC(10,2),
        avg_price         NUMERIC(10,2) NOT NULL,
        unit              VARCHAR(20)  NOT NULL DEFAULT 'kg',
        latest_price_date DATE NOT NULL,
        prev_price_date   DATE,
        trend             NUMERIC(10,4) DEFAULT 0,
        history_1y         JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (product, market, city, production_type)
      )
    `);
    await client.query(`
      ALTER TABLE market_price_latest
      ADD COLUMN IF NOT EXISTS history_1y JSONB NOT NULL DEFAULT '[]'::jsonb
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token       TEXT NOT NULL,
        platform    VARCHAR(20) NOT NULL CHECK (platform IN ('ios','android')),
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, token)
      )
    `);    

    await client.query(`
      CREATE TABLE IF NOT EXISTS phone_verification_attempts (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        phone       VARCHAR(32) NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_blocks (
        blocker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (blocker_id, blocked_id),
        CHECK (blocker_id <> blocked_id)
      )
    `);

    // ── Indexes ────────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_seller     ON listings(seller_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_city       ON listings(city)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_category   ON listings(category)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_status     ON listings(status)`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_active_type_created
      ON listings(listing_type, created_at DESC)
      WHERE status = 'active'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_reserved_until
      ON listings(reserved_until)
      WHERE status = 'reserved'
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_listing      ON offers(listing_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_buyer        ON offers(buyer_id)`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_offers_listing_buyer_status
      ON offers(listing_id, buyer_id, status)
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_offer      ON messages(offer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reviews_reviewee    ON reviews(reviewee_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reviews_offer       ON reviews(offer_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_unique_pair ON reviews(reviewer_id, reviewee_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id)`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_phone_verification_attempts_user_created
      ON phone_verification_attempts(user_id, created_at DESC)
    `);
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
