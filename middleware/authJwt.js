const jwt = require('jsonwebtoken');
const { User } = require('../models');

// Estado vigente del usuario detrás de un token. El JWT dura 7 días y antes se
// confiaba en él a ciegas: desactivar, borrar o bajarle el rol a alguien no tenía
// efecto hasta que venciera, y /auth/refresh lo renovaba indefinidamente. Ahora cada
// request confirma contra la base que el usuario sigue activo y toma su rol ACTUAL.
//
// Caché corta en memoria para no sumar una consulta por request. Los endpoints de
// usuarios la invalidan al cambiar rol, estado o contraseña, así que el cambio se
// aplica de inmediato en este proceso (y en otro, a lo sumo en CACHE_MS).
const CACHE_MS = 30 * 1000;
const cache = new Map(); // clave → { user: { _id, usuario, role }, expira }

const claveDe = (decoded) => (decoded.userId != null ? `id:${decoded.userId}` : `u:${decoded.usuario}`);

async function usuarioVigente(decoded) {
  const clave = claveDe(decoded);
  const hit = cache.get(clave);
  if (hit && hit.expira > Date.now()) return hit.user;
  const filtro = decoded.userId != null ? { _id: Number(decoded.userId) } : { usuario: decoded.usuario };
  const u = await User.findOne(filtro, { usuario: 1, role: 1, activo: 1, token_version: 1 }).lean();
  const user = u && u.activo !== false
    ? { _id: u._id, usuario: u.usuario, role: u.role, token_version: u.token_version || 0 }
    : null;
  // Solo se cachean los válidos: un rechazo se vuelve a consultar siempre.
  if (user) cache.set(clave, { user, expira: Date.now() + CACHE_MS });
  return user;
}

function invalidarUsuario(id) {
  if (id == null) { cache.clear(); return; }
  cache.delete(`id:${Number(id)}`);
  // Tokens viejos sin userId se identifican por nombre: se limpian todos por las dudas.
  for (const k of cache.keys()) if (k.startsWith('u:')) cache.delete(k);
}

// Verifica firma, vencimiento y estado actual del usuario. Devuelve el payload con
// el rol vigente, o null si el token no sirve.
async function verificarToken(token) {
  let decoded;
  try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return null; }
  const user = await usuarioVigente(decoded);
  if (!user) return null;
  // Token emitido antes del último cambio de contraseña → sesión cerrada.
  if ((decoded.tv || 0) !== user.token_version) return null;
  return { ...decoded, usuario: user.usuario, role: user.role, userId: user._id, tv: user.token_version };
}

// Payload de un token nuevo para un usuario (login y refresh).
const payloadToken = (u) => ({ usuario: u.usuario, role: u.role, userId: u._id ?? u.userId, tv: u.token_version ?? u.tv ?? 0 });

// Middleware global: protege todas las rutas montadas después.
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    const user = await verificarToken(auth.slice(7));
    if (!user) return res.status(401).json({ error: 'Token inválido, expirado o usuario desactivado' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

// Usuario autenticado de la request: el que dejó requireAuth, o se verifica acá si
// el middleware se usa en una ruta montada antes del global.
async function usuarioDeRequest(req) {
  if (req.user) return req.user;
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const user = await verificarToken(auth.slice(7));
  if (user) req.user = user;
  return user;
}

// Fábrica de guardas por rol (requireAdmin / requireSuperAdmin).
function requireRole(roles, mensaje) {
  return async (req, res, next) => {
    try {
      const user = await usuarioDeRequest(req);
      if (!user) return res.status(401).json({ error: 'Token inválido, expirado o usuario desactivado' });
      if (!roles.includes(user.role)) return res.status(403).json({ error: mensaje });
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireAuth, requireRole, verificarToken, invalidarUsuario, payloadToken };
