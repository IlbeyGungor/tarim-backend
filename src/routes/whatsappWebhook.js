const router = require('express').Router();
const {
  recordWebhookStatuses,
  verifyWebhookSignature,
  whatsappConfig,
} = require('../services/whatsappPhoneAuth');

router.get('/', (req, res) => {
  const config = whatsappConfig();
  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  if (mode === 'subscribe' && config.webhookVerifyToken && token === config.webhookVerifyToken) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'Webhook doğrulaması başarısız.' });
});

router.post('/', async (req, res, next) => {
  try {
    const config = whatsappConfig();
    const valid = verifyWebhookSignature(
      req.rawBody,
      req.get('X-Hub-Signature-256'),
      config.appSecret,
    );
    if (!valid) return res.status(401).json({ error: 'Geçersiz webhook imzası.' });
    await recordWebhookStatuses(req.body);
    return res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
