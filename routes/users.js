const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { User, Counter } = require('../models');
const requireAdmin = require('../middleware/requireAdmin');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const { audit } = require('../middleware/audit');
// Cambiar rol/estado, contraseña o borrar invalida la caché de sesiones: el cambio
// rige desde la próxima request de ese usuario, no cuando venza su token.
const { invalidarUsuario, payloadToken } = require('../middleware/authJwt');
const jwt = require('jsonwebtoken');

const ROLES = ['superadmin', 'admin', 'viewer'];

// Cuenta cuántos superadmins activos quedarían si se excluye a `exceptId`.
// Se usa para no dejar al sistema sin ningún superadmin (lockout).
async function activeSuperadminsExcluding(exceptId) {
  return User.countDocuments({ role: 'superadmin', activo: true, _id: { $ne: Number(exceptId) } });
}

// GET /api/users — lista de usuarios (admin y superadmin pueden ver)
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const users = await User.find({}, { password_hash: 0 }).lean();
    res.json(users.map(u => ({ ...u, id: u._id })));
  } catch (err) { next(err); }
});

// POST /api/users — crear usuario (solo superadmin)
router.post('/', requireSuperAdmin, audit('user'), async (req, res, next) => {
  try {
    const { usuario, password, role = 'viewer' } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
    const usuarioNormalizado = usuario.trim().toLowerCase();
    const exists = await User.findOne({ usuario: usuarioNormalizado });
    if (exists) return res.status(400).json({ error: 'El usuario ya existe' });
    const hash = await bcrypt.hash(password, 10);
    const id = await Counter.next('users');
    const user = await User.create({ _id: id, usuario: usuarioNormalizado, password_hash: hash, role, activo: true, created_at: new Date().toISOString() });
    res.json({ id: user._id, usuario: user.usuario, role: user.role, activo: user.activo });
  } catch (err) { next(err); }
});

// PUT /api/users/:id — editar rol y/o estado activo (solo superadmin)
router.put('/:id', requireSuperAdmin, audit('user'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: 'No encontrado' });

    const updates = {};
    if (req.body.role !== undefined) {
      if (!ROLES.includes(req.body.role)) return res.status(400).json({ error: 'Rol inválido' });
      updates.role = req.body.role;
    }
    if (req.body.activo !== undefined) updates.activo = !!req.body.activo;

    // No permitir dejar el sistema sin superadmins activos.
    const dejaDeSerSuper = (updates.role !== undefined && updates.role !== 'superadmin') || updates.activo === false;
    if (user.role === 'superadmin' && dejaDeSerSuper) {
      const restantes = await activeSuperadminsExcluding(id);
      if (restantes === 0) return res.status(400).json({ error: 'Debe existir al menos un Super Administrador activo' });
    }

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
    await User.findByIdAndUpdate(id, updates);
    invalidarUsuario(id);
    const updated = await User.findById(id, { password_hash: 0 }).lean();
    res.json({ ...updated, id: updated._id });
  } catch (err) { next(err); }
});

// DELETE /api/users/:id — eliminar usuario (solo superadmin)
router.delete('/:id', requireSuperAdmin, audit('user'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: 'No encontrado' });
    if (user.role === 'superadmin') {
      const restantes = await activeSuperadminsExcluding(id);
      if (restantes === 0) return res.status(400).json({ error: 'No podés eliminar el único Super Administrador' });
    }
    await User.findByIdAndDelete(id);
    invalidarUsuario(id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Roles que pueden cambiar SU PROPIA contraseña. El superadmin, además, cambia la de
// cualquiera (PUT /:id/password); un viewer la pide al superadmin.
const ROLES_CAMBIO_PROPIO = ['superadmin', 'admin'];

// PUT /api/users/me/password — cambiar la propia contraseña
// body: { password_actual, password_nueva }. Exige la actual. Como cambiar la
// contraseña cierra las sesiones abiertas (token_version), devuelve un token nuevo
// para que quien la cambió siga adentro en este dispositivo.
router.put('/me/password', audit('user_password_propia', { idFromBody: (req) => req.user?.userId }), async (req, res, next) => {
  try {
    const id = Number(req.user?.userId);
    if (!ROLES_CAMBIO_PROPIO.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Tu usuario no puede cambiar su contraseña: pedíselo al Super Administrador' });
    }
    const { password_actual, password_nueva } = req.body || {};
    if (typeof password_actual !== 'string' || !password_actual) return res.status(400).json({ error: 'Ingresá tu contraseña actual' });
    if (typeof password_nueva !== 'string' || password_nueva.length < 6) return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 6 caracteres' });
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: 'No encontrado' });
    if (!(await bcrypt.compare(password_actual, user.password_hash))) return res.status(400).json({ error: 'La contraseña actual no es correcta' });
    if (await bcrypt.compare(password_nueva, user.password_hash)) return res.status(400).json({ error: 'La contraseña nueva tiene que ser distinta de la actual' });
    const hash = await bcrypt.hash(password_nueva, 10);
    const actualizado = await User.findByIdAndUpdate(id, { password_hash: hash, $inc: { token_version: 1 } }, { returnDocument: 'after' }).lean();
    invalidarUsuario(id);
    const token = jwt.sign(payloadToken(actualizado), process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ ok: true, token, role: actualizado.role });
  } catch (err) { next(err); }
});

// PUT /api/users/:id/password — cambiar contraseña de cualquier usuario (solo superadmin)
router.put('/:id/password', requireSuperAdmin, audit('user_password'), async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    const hash = await bcrypt.hash(password, 10);
    // Nueva versión de sesión: los tokens emitidos con la contraseña vieja dejan de valer.
    await User.findByIdAndUpdate(Number(req.params.id), { password_hash: hash, $inc: { token_version: 1 } });
    invalidarUsuario(req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
