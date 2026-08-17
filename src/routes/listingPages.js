const router = require('express').Router();
const { query } = require('../db');

const SITE_ORIGIN = 'https://www.tarim-pazar.com';
const DEFAULT_PRODUCT_IMAGE_BASE =
  'https://res.cloudinary.com/dcqdlktnl/image/upload/f_auto,q_auto,c_limit,w_1200';
const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const PUBLIC_LISTING_SELECT = `
  SELECT l.*, GREATEST(l.quantity - l.fulfilled_quantity, 0) AS remaining_quantity,
    json_build_object(
      'id', u.id, 'name', u.name, 'city', u.city, 'district', u.district,
      'tc_verified', u.tc_verified, 'cks_verified', u.cks_verified,
      'is_verified', u.is_verified, 'rating', u.rating,
      'total_trades', u.total_trades, 'profile_image', u.profile_image
    ) AS seller
  FROM listings l JOIN users u ON u.id = l.seller_id
`;

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function slugify(value) {
  return String(value || '').trim().toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function listingSlug(listing) {
  const parts = [listing.seller && listing.seller.name, listing.city, listing.district, listing.crop_name]
    .map(slugify).filter(Boolean);
  parts.push(String(listing.id).toLowerCase());
  return parts.join('-');
}

function listingPath(listing) { return `/ilan/${listingSlug(listing)}/`; }
function listingUrl(listing) { return `${SITE_ORIGIN}${listingPath(listing)}`; }

function defaultProductImageId(value) {
  return String(value || '')
    .replace(/[çÇ]/g, 'c')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[ıİ]/g, 'i')
    .replace(/[öÖ]/g, 'o')
    .replace(/[şŞ]/g, 's')
    .replace(/[üÜ]/g, 'u')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function defaultProductImageUrl(value) {
  const publicId = defaultProductImageId(value);
  return publicId ? `${DEFAULT_PRODUCT_IMAGE_BASE}/${publicId}.jpg` : null;
}

function withListingShareUrls(value) {
  if (Array.isArray(value)) return value.map(withListingShareUrls);
  if (!value || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const result = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, withListingShareUrls(child)])
  );
  const sellerName = result.seller && result.seller.name;
  if (result.id && result.crop_name && sellerName) {
    result.share_url = listingUrl(result);
  }
  if (
    result.id &&
    result.crop_name &&
    Object.prototype.hasOwnProperty.call(result, 'image_urls') &&
    Array.isArray(result.image_urls) &&
    result.image_urls.length === 0
  ) {
    result.default_image_url = defaultProductImageUrl(result.crop_name);
  }
  return result;
}
function extractListingId(slug) {
  const match = String(slug || '').match(UUID_AT_END);
  return match ? match[1].toLowerCase() : null;
}

function formatNumber(value, maximumFractionDigits = 2) {
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat('tr-TR', { maximumFractionDigits }).format(number)
    : '—';
}

function formatCurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${formatNumber(number)} TL`;
}

function formatDate(value) {
  if (!value) return 'Belirtilmedi';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Belirtilmedi';
  return new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Istanbul',
  }).format(date);
}

function cloudinaryUrl(value, width) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let resolved = raw;
  if (raw.startsWith('//')) {
    resolved = `https:${raw}`;
  } else if (!/^https?:\/\//i.test(raw)) {
    const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || 'dcqdlktnl').trim();
    if (!cloudName) return null;
    const cleanPath = raw.replace(/^\/+/, '');
    resolved = cleanPath.startsWith('image/upload/')
      ? `https://res.cloudinary.com/${cloudName}/${cleanPath}`
      : `https://res.cloudinary.com/${cloudName}/image/upload/${cleanPath}`;
  }
  try {
    const parsed = new URL(resolved);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.hostname === 'res.cloudinary.com' && parsed.pathname.includes('/image/upload/')) {
      parsed.pathname = parsed.pathname.replace('/image/upload/', `/image/upload/f_auto,q_auto,c_limit,w_${width}/`);
    }
    return parsed.toString();
  } catch (_) { return null; }
}

function truncate(value, maximumLength) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length <= maximumLength ? normalized : `${normalized.slice(0, maximumLength - 1).trim()}…`;
}
function safeJson(value) { return JSON.stringify(value).replace(/</g, '\\u003c'); }

function imageGallery(listing) {
  const images = (Array.isArray(listing.image_urls) ? listing.image_urls : [])
    .map((image) => ({ full: cloudinaryUrl(image, 1400), thumb: cloudinaryUrl(image, 280) }))
    .filter((image) => image.full && image.thumb).slice(0, 5);
  const title = escapeHtml(listing.crop_name || 'Tarım ürünü');
  if (!images.length) {
    return `<section class="card gallery photo-placeholder" aria-label="İlan fotoğrafı yok"><div><span class="placeholder-icon" aria-hidden="true">TP</span><strong>${title}</strong><span>Bu ilana henüz fotoğraf eklenmemiş.</span></div></section>`;
  }
  const thumbnails = images.map((image, index) => {
    const alt = `${listing.crop_name || 'Ürün'} ilan fotoğrafı ${index + 1}`;
    return `<button class="gallery-thumb${index === 0 ? ' is-active' : ''}" type="button" data-gallery-image="${escapeHtml(image.full)}" data-gallery-alt="${escapeHtml(alt)}" aria-label="${index + 1}. fotoğrafı göster" aria-pressed="${index === 0 ? 'true' : 'false'}"><img src="${escapeHtml(image.thumb)}" alt="" loading="lazy" width="280" height="280"></button>`;
  }).join('');
  return `<section class="card gallery" aria-label="İlan fotoğrafları"><div class="gallery-main"><img id="listingMainImage" src="${escapeHtml(images[0].full)}" alt="${escapeHtml(`${listing.crop_name || 'Ürün'} ilan fotoğrafı 1`)}" width="1400" height="1050" fetchpriority="high"><span class="gallery-count">${images.length} fotoğraf</span></div>${images.length > 1 ? `<div class="gallery-thumbs">${thumbnails}</div>` : ''}</section>`;
}

function renderNotFound() {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>İlan bulunamadı | Tarım Pazar</title><link rel="icon" href="/assets/Icon-App-1024x1024@1x.png"><link rel="stylesheet" href="/assets/listing-pages.css"></head><body><header class="site-header"><div class="nav-shell"><a class="brand" href="/"><img src="/assets/web_site_logo.png" alt="Tarım Pazar" width="156"></a><a class="header-action" href="/indir/">Uygulamayı İndir</a></div></header><main class="card notice"><h1>İlan bulunamadı</h1><p>Bu ilan kapanmış, silinmiş veya artık yayında olmayabilir.</p><a class="primary-action" href="/ilanlar/">Aktif ilanlara dön</a></main></body></html>`;
}

function renderListing(listing) {
  const canonicalUrl = `${SITE_ORIGIN}${listingPath(listing)}`;
  const locationText = [listing.city, listing.district].filter(Boolean).join(', ') || 'Konum belirtilmedi';
  const titleText = `${listing.crop_name} İlanı - ${locationText} | Tarım Pazar`;
  const quantityText = `${formatNumber(listing.remaining_quantity)} ${listing.unit || ''}`.trim();
  const descriptionText = truncate(`${listing.crop_name} ilanı: ${quantityText}, ${locationText}. ${listing.seller.name} tarafından Tarım Pazar'da yayınlandı.`, 160);
  const numericPrice = Number(listing.price_per_unit);
  const hasPrice = Number.isFinite(numericPrice) && numericPrice > 0;
  const priceText = hasPrice ? `${formatCurrency(numericPrice)} / ${listing.price_unit || listing.unit || 'birim'}` : 'Teklif al';
  const totalValue = hasPrice && listing.unit === listing.price_unit ? numericPrice * Number(listing.remaining_quantity) : null;
  const images = (Array.isArray(listing.image_urls) ? listing.image_urls : []).map((image) => cloudinaryUrl(image, 1400)).filter(Boolean);
  const profileImage = cloudinaryUrl(listing.seller.profile_image, 160);
  const sellerInitial = Array.from(String(listing.seller.name || 'T').trim())[0] || 'T';
  const typeText = listing.listing_type === 'buy' ? 'Aranıyor' : 'Satılık';
  const verifiedText = listing.seller.is_verified || listing.seller.cks_verified || listing.seller.tc_verified ? 'Doğrulanmış ilan sahibi' : 'Tarım Pazar ilan sahibi';
  const productOrDemand = listing.listing_type === 'buy'
    ? { '@type': 'Demand', name: listing.crop_name, description: descriptionText, areaServed: locationText }
    : {
        '@type': 'Product', name: listing.crop_name, description: descriptionText,
        image: images, category: listing.category,
        offers: hasPrice ? {
          '@type': 'Offer', url: canonicalUrl, price: numericPrice.toFixed(2),
          priceCurrency: 'TRY', availability: 'https://schema.org/InStock',
          seller: { '@type': 'Person', name: listing.seller.name },
        } : undefined,
      };
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ItemPage', '@id': canonicalUrl, url: canonicalUrl,
        name: titleText, description: descriptionText,
        datePublished: listing.created_at, dateModified: listing.updated_at,
        mainEntity: productOrDemand,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Tarım Pazar', item: `${SITE_ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: 'İlanlar', item: `${SITE_ORIGIN}/ilanlar/` },
          { '@type': 'ListItem', position: 3, name: listing.crop_name, item: canonicalUrl },
        ],
      },
    ],
  };
  const descriptionClass = listing.description ? 'description' : 'description is-muted';
  const description = listing.description || 'İlan sahibi bu ürün için ek açıklama paylaşmamış.';
  const ogImage = images[0] || `${SITE_ORIGIN}/assets/Icon-App-1024x1024@1x.png`;

  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(titleText)}</title><meta name="description" content="${escapeHtml(descriptionText)}"><link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <link rel="icon" href="/assets/Icon-App-1024x1024@1x.png"><meta property="og:type" content="product"><meta property="og:site_name" content="Tarım Pazar"><meta property="og:title" content="${escapeHtml(titleText)}"><meta property="og:description" content="${escapeHtml(descriptionText)}"><meta property="og:url" content="${escapeHtml(canonicalUrl)}"><meta property="og:image" content="${escapeHtml(ogImage)}">
  <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(titleText)}"><meta name="twitter:description" content="${escapeHtml(descriptionText)}"><meta name="twitter:image" content="${escapeHtml(ogImage)}">
  <link rel="stylesheet" href="/assets/listing-pages.css?v=20260812-2"><script type="application/ld+json">${safeJson(structuredData)}</script>
</head>
<body>
  <header class="site-header"><div class="nav-shell"><a class="brand" href="/" aria-label="Tarım Pazar ana sayfa"><img src="/assets/web_site_logo.png" alt="Tarım Pazar" width="156"></a><a class="header-action" href="/indir/">Uygulamayı İndir</a></div></header>
  <nav class="breadcrumbs" aria-label="Sayfa yolu"><a href="/">Ana Sayfa</a><span>›</span><a href="/ilanlar/">İlanlar</a><span>›</span>${escapeHtml(listing.crop_name)}</nav>
  <main class="listing-layout">
    <div class="listing-main">
      ${imageGallery(listing)}
      <section class="card detail-card"><h2 class="section-heading"><span aria-hidden="true">•</span> Ürün Bilgisi</h2><div class="detail-grid"><div class="detail-item"><small>Hasat Tarihi</small><strong>${escapeHtml(formatDate(listing.harvest_date))}</strong></div><div class="detail-item"><small>İlan Tarihi</small><strong>${escapeHtml(formatDate(listing.created_at))}</strong></div><div class="detail-item"><small>Teklif Sayısı</small><strong>${escapeHtml(formatNumber(listing.offer_count, 0))}</strong></div></div><p class="${descriptionClass}">${escapeHtml(description)}</p></section>
      <section class="card detail-card"><h2 class="section-heading"><span aria-hidden="true">•</span> Konum</h2><div class="location-row"><span class="location-pin" aria-hidden="true">●</span><strong>${escapeHtml(locationText)}</strong></div></section>
      <section class="card detail-card"><h2 class="section-heading"><span aria-hidden="true">•</span> İlan Sahibi</h2><div class="seller-row"><span class="seller-avatar">${profileImage ? `<img src="${escapeHtml(profileImage)}" alt="${escapeHtml(listing.seller.name)} profil fotoğrafı" width="160" height="160" loading="lazy">` : escapeHtml(sellerInitial)}</span><div class="seller-meta"><strong>${escapeHtml(listing.seller.name)}</strong><span>${escapeHtml(verifiedText)}</span></div><div class="seller-rating"><strong>Puan ${escapeHtml(formatNumber(listing.seller.rating || 0, 1))}</strong><small>${escapeHtml(formatNumber(listing.seller.total_trades || 0, 0))} işlem</small></div></div></section>
      <a class="secondary-action" href="/indir/">Uygunsuz İçeriği Bildir</a>
    </div>
    <aside class="listing-side"><section class="card summary-card"><div class="title-row"><div><p class="listing-type">${escapeHtml(typeText)}</p><h1>${escapeHtml(listing.crop_name)}</h1></div><span class="status-badge">Aktif</span></div><p class="summary-location">Konum · ${escapeHtml(locationText)}</p><div class="price-block"><span class="price">${escapeHtml(priceText)}</span><span class="price-label">${hasPrice ? 'Birim fiyat' : 'Fiyat tipi: Pazarlık'}</span></div><div class="metrics"><div class="metric"><small>Miktar</small><strong>${escapeHtml(quantityText)}</strong></div><div class="metric"><small>Fiyat Tipi</small><strong>${listing.price_type === 'fixed' && hasPrice ? 'Sabit Fiyat' : 'Pazarlık Payı Var'}</strong></div>${Number.isFinite(totalValue) ? `<div class="metric is-wide"><small>Toplam Değer</small><strong>${escapeHtml(formatCurrency(totalValue))}</strong></div>` : ''}</div><a class="primary-action desktop-action" href="/indir/">Teklif Ver</a></section></aside>
  </main>
  <div class="mobile-action"><a class="primary-action" href="/indir/">Teklif Ver</a></div>
  <footer class="site-footer">© ${new Date().getUTCFullYear()} Tarım Pazar · Çiftçiden alıcıya doğrudan</footer>
  <script src="/assets/listing-pages.js?v=20260812-1" defer></script>
</body></html>`;
}

function setHtmlHeaders(res) {
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://res.cloudinary.com; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    'X-Robots-Tag': 'index, follow, max-image-preview:large',
  });
}

async function showListing(req, res, next) {
  try {
    const listingId = extractListingId(req.params.slug);
    if (!listingId) {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
      return res.status(404).send(renderNotFound());
    }
    const { rows } = await query(`${PUBLIC_LISTING_SELECT} WHERE l.id=$1 AND l.status='active' AND u.account_status='active'`, [listingId]);
    if (!rows.length) {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
      return res.status(404).send(renderNotFound());
    }
    const listing = rows[0];
    const canonicalPath = listingPath(listing);
    if (req.path !== `/${listingSlug(listing)}/`) return res.redirect(301, canonicalPath);
    setHtmlHeaders(res);
    return res.status(200).send(renderListing(listing));
  } catch (error) { return next(error); }
}

router.get('/:slug/', showListing);
router.get('/:slug', showListing);

async function listingSitemap(req, res, next) {
  try {
    const { rows } = await query(`${PUBLIC_LISTING_SELECT} WHERE l.status='active' AND u.account_status='active' ORDER BY l.updated_at DESC LIMIT 50000`);
    const urls = rows.map((listing) => {
      const modified = new Date(listing.updated_at || listing.created_at);
      const lastmod = Number.isNaN(modified.getTime()) ? '' : `<lastmod>${modified.toISOString()}</lastmod>`;
      return `<url><loc>${escapeHtml(`${SITE_ORIGIN}${listingPath(listing)}`)}</loc>${lastmod}<changefreq>daily</changefreq><priority>0.7</priority></url>`;
    }).join('');
    res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' });
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  } catch (error) { return next(error); }
}

router.helpers = { cloudinaryUrl, defaultProductImageId, defaultProductImageUrl, escapeHtml, extractListingId, listingPath, listingSlug, listingUrl, renderListing, slugify, withListingShareUrls };
module.exports = { defaultProductImageId, defaultProductImageUrl, listingPageRouter: router, listingSitemap, listingUrl, withListingShareUrls };
