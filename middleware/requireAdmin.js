const jwt = require('jsonwebtoken');

module.exports = function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Se requiere rol administrador' });
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
