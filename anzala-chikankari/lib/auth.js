// Password hashing and cookie sessions.
const crypto = require('node:crypto');

const SESSION_COOKIE = 'anzala_sid';
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

async function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, userId, expires]);
  return token;
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 864e5,
    path: '/',
  });
}

// Express middleware: attaches req.user when a valid session cookie is present.
// Requires `cookie-parser` to already have populated req.cookies.
function loadUser(db) {
  return async (req, _res, next) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      req.sessionToken = token || null;
      req.user = token
        ? (await db.get(
            `SELECT u.id, u.name, u.email, u.phone, u.role
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token = ? AND s.expires_at > ?`,
            [token, new Date().toISOString()],
          )) || null
        : null;
      next();
    } catch (err) { next(err); }
  };
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access only.' });
  next();
}

module.exports = {
  SESSION_COOKIE, hashPassword, verifyPassword,
  createSession, setSessionCookie, loadUser, requireUser, requireAdmin,
};
