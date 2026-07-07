const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { User, Counter } = require('../models');
const requireAdmin = require('../middleware/requireAdmin');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const { audit } = require('../middleware/audit');

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
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /api/users/:id/password — cambiar contraseña (solo superadmin)
router.put('/:id/password', requireSuperAdmin, audit('user_password'), async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    const hash = await bcrypt.hash(password, 10);
    await User.findByIdAndUpdate(Number(req.params.id), { password_hash: hash });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
