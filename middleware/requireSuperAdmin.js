const jwt = require('jsonwebtoken');

// Requiere rol superadmin: control total del sistema, incluida la gestión de usuarios.
module.exports = function requireSuperAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    if (decoded.role !== 'superadmin') {
      return res.status(403).json({ error: 'Se requiere rol Super Administrador' });
    }
    req.user = req.user || decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
