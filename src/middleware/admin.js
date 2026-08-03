function configuredAdminEmails() {
  return new Set(
    String(process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function adminMiddleware(req, res, next) {
  const email = String(req.user?.email || '').trim().toLowerCase();
  const allowed = configuredAdminEmails();
  if (!req.user?.is_admin || !email || !allowed.has(email)) {
    return res.status(403).json({ error: 'Admin yetkisi gerekli.' });
  }
  next();
}

adminMiddleware.configuredAdminEmails = configuredAdminEmails;

module.exports = adminMiddleware;
