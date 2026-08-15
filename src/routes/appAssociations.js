const APPLE_APP_ID = 'BR65QP8KFZ.com.tarim.pazar';
const ANDROID_PACKAGE = 'com.tarim.pazar';
const ANDROID_CERTIFICATES = [
  '0E:F1:2B:05:33:1C:F9:14:88:D6:8F:E8:AD:A7:E1:07:2D:F8:40:74:93:05:A3:15:98:F9:DC:17:25:56:98:39',
  'F3:33:AC:63:9C:23:90:06:5C:77:94:B5:BB:17:A3:C3:7F:74:D7:06:C7:6F:FA:11:C8:73:B5:CC:FC:A5:1C:7C',
];

const appleAssociation = {
  applinks: {
    apps: [],
    details: [
      {
        appIDs: [APPLE_APP_ID],
        components: [{ '/': '/ilan/*' }],
      },
    ],
  },
};

const androidAssociation = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: ANDROID_PACKAGE,
      sha256_cert_fingerprints: ANDROID_CERTIFICATES,
    },
  },
];

function sendAssociation(res, body) {
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
  });
  return res.status(200).send(JSON.stringify(body));
}

function appleAppSiteAssociation(req, res) {
  return sendAssociation(res, appleAssociation);
}

function androidAssetLinks(req, res) {
  return sendAssociation(res, androidAssociation);
}

module.exports = {
  ANDROID_CERTIFICATES,
  ANDROID_PACKAGE,
  APPLE_APP_ID,
  androidAssociation,
  androidAssetLinks,
  appleAppSiteAssociation,
  appleAssociation,
};
