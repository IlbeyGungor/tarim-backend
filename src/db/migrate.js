require('dotenv').config();
const { pool } = require('./index');
const { resolveProductIdentity } = require('../utils/productCatalog');

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
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

    // ── users ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name            VARCHAR(120) NOT NULL,
        phone           VARCHAR(20) UNIQUE,
        phone_verified  BOOLEAN DEFAULT FALSE,
        firebase_uid    VARCHAR(128) UNIQUE,
        email           VARCHAR(320),
        password_hash   VARCHAR(255) NOT NULL,
        has_local_password BOOLEAN NOT NULL DEFAULT FALSE,
        auth_providers  JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
        account_status  VARCHAR(20) NOT NULL DEFAULT 'active',
        token_version   INTEGER NOT NULL DEFAULT 0,
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
        last_active_at  TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(128) UNIQUE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(320)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS has_local_password BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_providers JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) NOT NULL DEFAULT 'active'`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS match_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS personalization_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS favorite_product_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
    await client.query(`ALTER TABLE users ALTER COLUMN phone DROP NOT NULL`);
    await client.query(`ALTER TABLE users ALTER COLUMN profile_image TYPE TEXT`);
    await client.query(`
      UPDATE users
      SET has_local_password = true,
          auth_providers = CASE
            WHEN auth_providers = '[]'::jsonb THEN '["phone_password"]'::jsonb
            ELSE auth_providers
          END
      WHERE password_hash NOT LIKE 'firebase:%'
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='users_account_status_check'
            AND conrelid='users'::regclass
        ) THEN
          ALTER TABLE users ADD CONSTRAINT users_account_status_check
          CHECK (account_status IN ('active','suspended','deletion_pending'));
        END IF;
      END $$;
    `);
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
        quantity_unlimited BOOLEAN NOT NULL DEFAULT FALSE,
        unit            VARCHAR(20)  NOT NULL DEFAULT 'kg',
        price_per_unit  NUMERIC(10,2),
        price_unit      VARCHAR(20)  NOT NULL DEFAULT 'kg',
        price_type      VARCHAR(20)  NOT NULL CHECK (price_type IN ('fixed','negotiate')) DEFAULT 'negotiate',
        city            VARCHAR(80),
        district        VARCHAR(80),
        is_nationwide   BOOLEAN NOT NULL DEFAULT FALSE,
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
        image_urls      JSONB NOT NULL DEFAULT '[]'::jsonb,
        match_revision  INTEGER NOT NULL DEFAULT 1
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
    await client.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS quantity_unlimited BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_nationwide BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS product_key VARCHAR(160)`);
    await client.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS product_family_key VARCHAR(180)`);
    await client.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS catalog_product_key VARCHAR(160)`);
    await client.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS match_revision INTEGER NOT NULL DEFAULT 1`);
    await client.query(`ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_unit VARCHAR(20)`);
    await client.query(`UPDATE listings SET price_unit=unit WHERE price_unit IS NULL OR BTRIM(price_unit)=''`);
    await client.query(`ALTER TABLE listings ALTER COLUMN price_unit SET DEFAULT 'kg'`);
    await client.query(`ALTER TABLE listings ALTER COLUMN price_unit SET NOT NULL`);
    await client.query(`ALTER TABLE listings ALTER COLUMN price_per_unit DROP NOT NULL`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='listings_quantity_scope_check'
            AND conrelid='listings'::regclass
        ) THEN
          ALTER TABLE listings ADD CONSTRAINT listings_quantity_scope_check
          CHECK (
            (quantity_unlimited=TRUE AND quantity=0)
            OR (quantity_unlimited=FALSE AND quantity>0)
          ) NOT VALID;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='listings_nationwide_location_check'
            AND conrelid='listings'::regclass
        ) THEN
          ALTER TABLE listings ADD CONSTRAINT listings_nationwide_location_check
          CHECK (is_nationwide=FALSE OR (city IS NULL AND district IS NULL)) NOT VALID;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='listings_price_positive_check'
            AND conrelid='listings'::regclass
        ) THEN
          ALTER TABLE listings ADD CONSTRAINT listings_price_positive_check
          CHECK (price_per_unit IS NULL OR price_per_unit > 0);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='listings_price_required_type_check'
            AND conrelid='listings'::regclass
        ) THEN
          ALTER TABLE listings ADD CONSTRAINT listings_price_required_type_check
          CHECK (price_per_unit IS NOT NULL OR price_type='negotiate');
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='listings_unit_compatibility_check'
            AND conrelid='listings'::regclass
        ) THEN
          ALTER TABLE listings ADD CONSTRAINT listings_unit_compatibility_check
          CHECK (
            (unit IN ('kg','ton') AND price_unit IN ('kg','ton'))
            OR (unit IN ('adet','kasa','çuval') AND price_unit=unit)
          );
        END IF;
      END $$;
    `);
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

    const { rows: productsToBackfill } = await client.query(`
      SELECT id,crop_name,category,catalog_product_key
      FROM listings
      WHERE product_key IS NULL OR product_family_key IS NULL
    `);
    for (const listing of productsToBackfill) {
      const identity = resolveProductIdentity(
        listing.crop_name,
        listing.category,
        listing.catalog_product_key
      );
      await client.query(`
        UPDATE listings
        SET product_key=$1, product_family_key=$2
        WHERE id=$3
      `, [identity.product_key, identity.product_family_key, listing.id]);
    }
    await client.query(`ALTER TABLE listings ALTER COLUMN product_key SET NOT NULL`);
    await client.query(`ALTER TABLE listings ALTER COLUMN product_family_key SET NOT NULL`);

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

    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_challenges (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        purpose     VARCHAR(30) NOT NULL CHECK (purpose IN ('phone_register','phone_password_reset')),
        phone       VARCHAR(32) NOT NULL,
        user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
        token_hash  VARCHAR(64) NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        admin_id     UUID REFERENCES users(id) ON DELETE SET NULL,
        action       VARCHAR(60) NOT NULL,
        target_type  VARCHAR(30) NOT NULL,
        target_id    UUID,
        reason       TEXT NOT NULL,
        snapshot     JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_activity_daily (
        user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        activity_date    DATE NOT NULL,
        first_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_active_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ping_count       INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, activity_date)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS contact_events (
        id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        event_id           VARCHAR(160) NOT NULL UNIQUE,
        channel            VARCHAR(20) NOT NULL CHECK (channel IN ('call','message')),
        actor_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
        recipient_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
        listing_id         UUID REFERENCES listings(id) ON DELETE SET NULL,
        offer_id           UUID REFERENCES offers(id) ON DELETE SET NULL,
        contact_key        VARCHAR(180),
        is_guest           BOOLEAN NOT NULL DEFAULT FALSE,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO contact_events (
        event_id,channel,actor_user_id,recipient_user_id,listing_id,offer_id,
        contact_key,is_guest,created_at
      )
      SELECT
        'message:' || m.id::text,
        'message',
        m.sender_id,
        CASE WHEN m.sender_id=o.buyer_id THEN l.seller_id ELSE o.buyer_id END,
        o.listing_id,
        o.id,
        o.listing_id::text || ':' ||
          LEAST(m.sender_id::text,
            (CASE WHEN m.sender_id=o.buyer_id THEN l.seller_id ELSE o.buyer_id END)::text) || ':' ||
          GREATEST(m.sender_id::text,
            (CASE WHEN m.sender_id=o.buyer_id THEN l.seller_id ELSE o.buyer_id END)::text),
        false,
        m.created_at
      FROM messages m
      JOIN offers o ON o.id=m.offer_id
      JOIN listings l ON l.id=o.listing_id
      WHERE COALESCE(m.action_type,'chat')='chat'
        AND m.sender_id IN (o.buyer_id,l.seller_id)
      ON CONFLICT (event_id) DO NOTHING
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_interest_events (
        id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        event_id            VARCHAR(160) NOT NULL,
        user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_type          VARCHAR(40) NOT NULL,
        product_key         VARCHAR(160) NOT NULL,
        product_family_key  VARCHAR(180) NOT NULL,
        product_name        VARCHAR(160) NOT NULL,
        category            VARCHAR(40),
        listing_type        VARCHAR(10) CHECK (listing_type IN ('sell','buy')),
        listing_id          UUID REFERENCES listings(id) ON DELETE SET NULL,
        active_seconds      INTEGER NOT NULL DEFAULT 0,
        score               NUMERIC(12,4) NOT NULL,
        session_id          VARCHAR(160),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id,event_id)
      )
    `);
    await client.query(`
      INSERT INTO contact_events (
        event_id,channel,actor_user_id,recipient_user_id,listing_id,
        contact_key,is_guest,created_at
      )
      SELECT
        'interest-call:' || pie.id::text,
        'call',
        pie.user_id,
        l.seller_id,
        l.id,
        l.id::text || ':' || LEAST(pie.user_id::text,l.seller_id::text) || ':' ||
          GREATEST(pie.user_id::text,l.seller_id::text),
        false,
        pie.created_at
      FROM product_interest_events pie
      JOIN listings l ON l.id=pie.listing_id
      WHERE pie.event_type='call_button_click'
        AND pie.user_id<>l.seller_id
      ON CONFLICT (event_id) DO NOTHING
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_product_interests (
        user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_family_key  VARCHAR(180) NOT NULL,
        listing_type        VARCHAR(10) NOT NULL CHECK (listing_type IN ('sell','buy')),
        product_name        VARCHAR(160) NOT NULL,
        category            VARCHAR(40),
        score               NUMERIC(14,4) NOT NULL DEFAULT 0,
        event_count         INTEGER NOT NULL DEFAULT 0,
        last_event_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id,product_family_key,listing_type)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_favorite_products (
        user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_family_key  VARCHAR(180) NOT NULL,
        product_key         VARCHAR(160) NOT NULL,
        display_name        VARCHAR(160) NOT NULL,
        category            VARCHAR(40),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id,product_family_key)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS listing_match_outbox (
        id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        new_listing_id      UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        matched_listing_id  UUID REFERENCES listings(id) ON DELETE SET NULL,
        recipient_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        match_revision      INTEGER NOT NULL DEFAULT 1,
        match_reason        VARCHAR(30) NOT NULL DEFAULT 'opposite_listing'
                            CHECK (match_reason IN ('opposite_listing','favorite_product')),
        status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','sent','failed')),
        attempts            INTEGER NOT NULL DEFAULT 0,
        next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_error          TEXT,
        sent_at             TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE listing_match_outbox ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE listing_match_outbox ADD COLUMN IF NOT EXISTS match_revision INTEGER NOT NULL DEFAULT 1`);
    await client.query(`ALTER TABLE listing_match_outbox ADD COLUMN IF NOT EXISTS match_reason VARCHAR(30) NOT NULL DEFAULT 'opposite_listing'`);
    await client.query(`ALTER TABLE listing_match_outbox DROP CONSTRAINT IF EXISTS listing_match_outbox_match_reason_check`);
    await client.query(`
      ALTER TABLE listing_match_outbox
      ADD CONSTRAINT listing_match_outbox_match_reason_check
      CHECK (match_reason IN ('opposite_listing','favorite_product'))
    `);
    await client.query(`ALTER TABLE listing_match_outbox DROP CONSTRAINT IF EXISTS listing_match_outbox_status_check`);
    await client.query(`
      ALTER TABLE listing_match_outbox
      ADD CONSTRAINT listing_match_outbox_status_check
      CHECK (status IN ('pending','processing','sent','failed','permanent_failed'))
    `);
    await client.query(`
      UPDATE listing_match_outbox
      SET status='permanent_failed',claimed_at=NULL
      WHERE status='failed' AND attempts>=3
    `);
    await client.query(`ALTER TABLE listing_match_outbox DROP CONSTRAINT IF EXISTS listing_match_outbox_new_listing_id_recipient_id_key`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_match_outbox_revision_recipient
      ON listing_match_outbox(new_listing_id,recipient_id,match_revision)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS listing_match_jobs (
        listing_id       UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        match_revision   INTEGER NOT NULL DEFAULT 1,
        status           VARCHAR(20) NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','processing','done','failed','permanent_failed')),
        attempts         INTEGER NOT NULL DEFAULT 0,
        next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at       TIMESTAMPTZ,
        processed_at     TIMESTAMPTZ,
        last_error       TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (listing_id,match_revision)
      )
    `);
    await client.query(`ALTER TABLE listing_match_jobs ADD COLUMN IF NOT EXISTS match_revision INTEGER NOT NULL DEFAULT 1`);
    await client.query(`ALTER TABLE listing_match_jobs DROP CONSTRAINT IF EXISTS listing_match_jobs_pkey`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname='listing_match_jobs_pkey'
            AND conrelid='listing_match_jobs'::regclass
        ) THEN
          ALTER TABLE listing_match_jobs
          ADD CONSTRAINT listing_match_jobs_pkey PRIMARY KEY (listing_id,match_revision);
        END IF;
      END $$;
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS listing_match_daily_counts (
        recipient_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        notification_date  DATE NOT NULL,
        notification_count INTEGER NOT NULL DEFAULT 0 CHECK (notification_count BETWEEN 0 AND 5),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (recipient_id,notification_date)
      )
    `);

    const { rows: pistachioListings } = await client.query(`
      SELECT id,crop_name,category,catalog_product_key,product_family_key
      FROM listings
      WHERE product_family_key IN ('fistik','antep-fistigi','yer-fistigi')
         OR crop_name ILIKE '%fıst%'
         OR crop_name ILIKE '%fist%'
    `);
    for (const listing of pistachioListings) {
      const identity = resolveProductIdentity(
        listing.crop_name,
        listing.category,
        listing.catalog_product_key
      );
      if (identity.product_family_key !== listing.product_family_key) {
        await client.query(`
          UPDATE listings SET product_family_key=$1 WHERE id=$2
        `, [identity.product_family_key, listing.id]);
      }
    }

    const { rows: pistachioEvents } = await client.query(`
      SELECT id,product_name,category,product_family_key
      FROM product_interest_events
      WHERE product_family_key IN ('fistik','antep-fistigi','yer-fistigi')
         OR product_name ILIKE '%fıst%'
         OR product_name ILIKE '%fist%'
    `);
    for (const event of pistachioEvents) {
      const identity = resolveProductIdentity(event.product_name, event.category);
      if (identity.product_family_key !== event.product_family_key) {
        await client.query(`
          UPDATE product_interest_events
          SET product_family_key=$1
          WHERE id=$2
        `, [identity.product_family_key, event.id]);
      }
    }
    await client.query(`
      DELETE FROM user_product_interests
      WHERE product_family_key IN ('fistik','antep-fistigi','yer-fistigi')
    `);
    await client.query(`
      INSERT INTO user_product_interests
        (user_id,product_family_key,listing_type,product_name,category,score,event_count,last_event_at)
      SELECT user_id,
             product_family_key,
             listing_type,
             (ARRAY_AGG(product_name ORDER BY created_at DESC))[1],
             (ARRAY_AGG(category ORDER BY created_at DESC))[1],
             SUM(score * POWER(0.5,EXTRACT(EPOCH FROM (NOW()-created_at))/2592000.0)),
             COUNT(*)::int,
             MAX(created_at)
      FROM product_interest_events
      WHERE product_family_key IN ('fistik','antep-fistigi','yer-fistigi')
      GROUP BY user_id,product_family_key,listing_type
      ON CONFLICT (user_id,product_family_key,listing_type) DO UPDATE SET
        product_name=EXCLUDED.product_name,
        category=EXCLUDED.category,
        score=EXCLUDED.score,
        event_count=EXCLUDED.event_count,
        last_event_at=EXCLUDED.last_event_at
    `);

    // ── Indexes ────────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_seller     ON listings(seller_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_city       ON listings(city)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_nationwide ON listings(is_nationwide) WHERE is_nationwide=TRUE`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_category   ON listings(category)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listings_status     ON listings(status)`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_active_family_type_created
      ON listings(product_family_key,listing_type,created_at DESC)
      WHERE status='active'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_product_name_trgm
      ON listings USING GIN (crop_name gin_trgm_ops)
      WHERE status='active'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_seller_status_created
      ON listings(seller_id, status, created_at DESC)
    `);
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
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique_lower ON users(LOWER(email)) WHERE email IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_account_status ON users(account_status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_activity_date ON user_activity_daily(activity_date DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_contact_events_created ON contact_events(created_at DESC)`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_contact_events_contact_created
      ON contact_events(contact_key,channel,created_at DESC)
      WHERE contact_key IS NOT NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_auth_challenges_phone_created ON auth_challenges(phone, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges(expires_at) WHERE used_at IS NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_product_interest_events_user_created ON product_interest_events(user_id,created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_product_interest_events_created ON product_interest_events(created_at DESC)`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_product_interest_events_session_dedupe
      ON product_interest_events(user_id,event_type,session_id)
      WHERE session_id IS NOT NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_product_interests_rank ON user_product_interests(user_id,score DESC,last_event_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listing_match_outbox_retry ON listing_match_outbox(status,next_attempt_at) WHERE status IN ('pending','failed')`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listing_match_outbox_recipient_created ON listing_match_outbox(recipient_id,created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listing_match_outbox_terminal_cleanup ON listing_match_outbox(status,created_at) WHERE status IN ('sent','permanent_failed')`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listing_match_outbox_processing_claimed ON listing_match_outbox(claimed_at) WHERE status='processing'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_favorite_products_family ON user_favorite_products(product_family_key,user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listing_match_jobs_retry ON listing_match_jobs(status,next_attempt_at) WHERE status IN ('pending','failed','processing')`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listing_match_jobs_processing_claimed ON listing_match_jobs(claimed_at) WHERE status='processing'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_listing_match_daily_counts_date ON listing_match_daily_counts(notification_date)`);
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
