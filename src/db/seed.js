require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('./index');

const seed = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE market_prices, messages, offers, listings, users RESTART IDENTITY CASCADE');

    const hash = await bcrypt.hash('demo1234', 10);

    // ── Users ──────────────────────────────────────────────────
    const u1 = uuidv4(), u2 = uuidv4(), u3 = uuidv4();

    await client.query(`
      INSERT INTO users (id,name,phone,password_hash,role,city,district,bio,tc_verified,cks_verified,is_verified,rating,total_trades)
      VALUES
        ($1,'Ahmet Yılmaz','+905321234567',$4,'farmer','İzmir','Ödemiş','Ege bölgesinde zeytin ve incir üreticisiyim.',true,true,true,4.8,34),
        ($2,'Fatma Kaya','+905422223344',$4,'farmer','Konya','Çumra','Buğday ve arpa üreticisi.',true,false,true,4.5,18),
        ($3,'Ali Komisyon','+905334445566',$4,'middleman','İstanbul','Bağcılar','10 yıldır komisyonculuk yapıyorum.',true,false,true,4.7,120)
    `, [u1, u2, u3, hash]);

    // ── Listings ───────────────────────────────────────────────
    const l1 = uuidv4(), l2 = uuidv4(), l3 = uuidv4(), l4 = uuidv4();

    await client.query(`
      INSERT INTO listings (id,seller_id,crop_name,category,quantity,unit,price_per_unit,price_type,city,district,description,status,harvest_date)
      VALUES
        ($1,$5,'Sofralık Zeytin','fruit',5000,'kg',18.50,'negotiate','İzmir','Ödemiş','Doğal ve ilaçsız yetiştirilmiş sofralık siyah zeytin. Paket veya dökme teslim.','active',CURRENT_DATE - 5),
        ($2,$6,'Ekmeklik Buğday','grain',20000,'kg',8.20,'fixed','Konya','Çumra','Sertifikalı tohumdan, analiz belgeli ekmeklik buğday.','active',CURRENT_DATE - 30),
        ($3,$5,'Kuru İncir','fruit',3000,'kg',55.00,'negotiate','İzmir','Ödemiş','AB standartlarına uygun kuru incir, ihracata hazır.','active',CURRENT_DATE - 10),
        ($4,$6,'Tombul Fındık','nut',8000,'kg',85.00,'negotiate','Giresun','Merkez','İç fındık oranı 48%+, rutubet 6%, analiz belgeli.','active',CURRENT_DATE - 7)
    `, [l1, l2, l3, l4, u1, u2]);

    // ── Market prices ──────────────────────────────────────────
    await client.query(`
      INSERT INTO market_prices (product,icon,city,min_price,max_price,avg_price,unit,trend)
      VALUES
        ('Domates','🍅','İstanbul',4.50,7.20,5.80,'kg',0.12),
        ('Zeytin','🫒','İzmir',15.00,22.00,18.50,'kg',-0.05),
        ('Buğday','🌾','Konya',7.80,8.60,8.20,'kg',0.03),
        ('Fındık','🌰','Giresun',78.00,92.00,85.00,'kg',0.08),
        ('Üzüm','🍇','Manisa',18.00,26.00,22.00,'kg',-0.02),
        ('Elma','🍎','Isparta',5.50,9.00,7.20,'kg',0.15),
        ('Biber','🌶️','Antalya',3.00,5.50,4.20,'kg',-0.10),
        ('Patates','🥔','Niğde',2.80,4.00,3.40,'kg',0.01),
        ('Kuru İncir','🫐','Aydın',45.00,65.00,55.00,'kg',0.06),
        ('Nohut','🫘','Ankara',28.00,35.00,31.50,'kg',0.04)
    `);

    await client.query('COMMIT');
    console.log('✅  Seed complete');
    console.log('   Demo login → phone: +905321234567  password: demo1234');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌  Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

seed();
