const jwt = require('jsonwebtoken');

const decodeToken = (req) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  return jwt.verify(token, process.env.JWT_SECRET);
};

const authMiddleware = (req, res, next) => {
  try {
    const decoded = decodeToken(req);
    if (!decoded) {
      return res.status(401).json({ error: 'Authorization token gerekli.' });
    }
    req.user = decoded; // { id, phone, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token.' });
  }
};

authMiddleware.optional = (req, res, next) => {
  try {
    const decoded = decodeToken(req);
    if (decoded) req.user = decoded;
  } catch (err) {
    // Invalid optional auth is treated as anonymous for public endpoints.
  }
  next();
};

module.exports = authMiddleware;
