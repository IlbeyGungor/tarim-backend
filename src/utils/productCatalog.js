const CATEGORY_BY_FAMILY = {
  limon: 'fruit', elma: 'fruit', armut: 'fruit', ayva: 'fruit', uzum: 'fruit',
  portakal: 'fruit', mandalina: 'fruit', greyfurt: 'fruit', muz: 'fruit',
  ananas: 'fruit', seftali: 'fruit', nektarin: 'fruit', kiraz: 'fruit',
  visne: 'fruit', cilek: 'fruit', karpuz: 'fruit', kavun: 'fruit', erik: 'fruit',
  incir: 'fruit', nar: 'fruit', kivi: 'fruit', hurma: 'fruit', kayisi: 'fruit',
  domates: 'vegetable', biber: 'vegetable', salatalik: 'vegetable', patlican: 'vegetable',
  kabak: 'vegetable', marul: 'vegetable', sogan: 'vegetable', patates: 'vegetable',
  havuc: 'vegetable', lahana: 'vegetable', karnabahar: 'vegetable', brokoli: 'vegetable',
  ispanak: 'vegetable', pirasa: 'vegetable', kereviz: 'vegetable', enginar: 'vegetable',
  turp: 'vegetable', bamya: 'vegetable', mantar: 'vegetable', sarimsak: 'vegetable',
  fasulye: 'legume', bezelye: 'legume', nohut: 'legume', mercimek: 'legume',
  bakla: 'legume', barbunya: 'legume', borulce: 'legume',
  findik: 'nut', ceviz: 'nut', badem: 'nut', fistik: 'nut',
  'antep-fistigi': 'nut', 'yer-fistigi': 'nut', kestane: 'nut',
  bugday: 'grain', arpa: 'grain', yulaf: 'grain', cavdar: 'grain', pirinc: 'grain',
  misir: 'grain', bulgur: 'grain',
};

const FAMILY_ALIASES = {
  limon: ['limon', 'mayer limon', 'yatak limon', 'enter limon'],
  elma: ['elma', 'golden elma', 'starking elma', 'granny smith elma'],
  uzum: ['uzum'],
  salatalik: ['salatalik', 'hiyar'],
  sogan: ['sogan', 'kuru sogan', 'taze sogan'],
  fistik: ['fistik'],
  'antep-fistigi': ['antep fistigi'],
  'yer-fistigi': ['yer fistigi'],
};

const DISPLAY_CORRECTIONS = {
  'lolorosso kivircik kirmizi marul kivircik': 'Lolorosso (Kirmizi Kivircik)',
  'limon grass limon otu': 'Limon Otu',
};

function normalizeTurkish(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/[çÇ]/g, 'c')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[ıİiI]/g, 'i')
    .replace(/[öÖ]/g, 'o')
    .replace(/[şŞ]/g, 's')
    .replace(/[üÜ]/g, 'u')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function slug(value) {
  return normalizeTurkish(value).replace(/\s+/g, '-');
}

const normalizedAliases = Object.entries(FAMILY_ALIASES).flatMap(([family, aliases]) =>
  aliases.map((alias) => ({ family, alias: normalizeTurkish(alias) }))
);

function familyForName(name) {
  const normalized = normalizeTurkish(name);
  if (!normalized) return null;
  if (normalized.includes('limon otu') || normalized.includes('limon grass')) return null;
  if (normalized.includes('antep fistigi')) return 'antep-fistigi';
  if (normalized.includes('yer fistigi')) return 'yer-fistigi';

  const exact = normalizedAliases.find((item) => item.alias === normalized);
  if (exact) return exact.family;

  const tokens = new Set(normalized.split(' '));
  for (const family of Object.keys(CATEGORY_BY_FAMILY)) {
    if (tokens.has(family)) return family;
  }
  return null;
}

function displayNameFor(rawName) {
  const trimmed = String(rawName || '').trim().replace(/\s+/g, ' ');
  return DISPLAY_CORRECTIONS[normalizeTurkish(trimmed)] || trimmed;
}

function resolveProductIdentity(rawName, category, catalogProductKey = null) {
  const displayName = displayNameFor(rawName);
  const productKey = slug(displayName);
  const family = familyForName(displayName);
  return {
    product_key: productKey,
    product_family_key: family || `product:${productKey}`,
    catalog_product_key: catalogProductKey || null,
    display_name: displayName,
    family_key: family || `product:${productKey}`,
    category: CATEGORY_BY_FAMILY[family] || category || 'other',
  };
}

function buildCatalogItems(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const identity = resolveProductIdentity(row.product, row.category);
    if (!identity.product_key) continue;
    const current = byKey.get(identity.product_key);
    const candidate = {
      product_key: identity.product_key,
      display_name: identity.display_name,
      family_key: identity.family_key,
      category: identity.category,
    };
    if (!current || candidate.display_name.length < current.display_name.length) {
      byKey.set(identity.product_key, candidate);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.display_name.localeCompare(b.display_name, 'tr')
  );
}

module.exports = {
  buildCatalogItems,
  displayNameFor,
  familyForName,
  normalizeTurkish,
  resolveProductIdentity,
  slug,
};
