const jwt = require('jsonwebtoken');
const { query } = require('../db');

const decodeToken = (req) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  return jwt.verify(token, process.env.JWT_SECRET);
};

const loadActiveUser = async (decoded) => {
  const { rows } = await query(`
    SELECT id, phone, email, is_admin, account_status, token_version
    FROM users
    WHERE id=$1
    LIMIT 1
  `, [decoded.id]);
  if (!rows.length) return null;

  const user = rows[0];
  const tokenVersion = Number(decoded.token_version || 0);
  if (tokenVersion !== Number(user.token_version || 0)) return null;
  return { ...decoded, ...user };
};

const authMiddleware = async (req, res, next) => {
  try {
    const decoded = decodeToken(req);
    if (!decoded) {
      return res.status(401).json({ error: 'Authorization token gerekli.' });
    }
    const user = await loadActiveUser(decoded);
    if (!user) {
      return res.status(401).json({ error: 'Oturum geçersiz veya süresi dolmuş.' });
    }
    if (user.account_status !== 'active') {
      return res.status(403).json({ error: 'Bu hesap şu anda aktif değil.' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token.' });
  }
};

authMiddleware.optional = async (req, res, next) => {
  try {
    const decoded = decodeToken(req);
    if (decoded) {
      const user = await loadActiveUser(decoded);
      if (user?.account_status === 'active') req.user = user;
    }
  } catch (err) {
    // Invalid optional auth is treated as anonymous for public endpoints.
  }
  next();
};

module.exports = authMiddleware;
