const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { User, Counter } = require('../models');
const requireAdmin = require('../middleware/requireAdmin');
const { audit } = require('../middleware/audit');

// GET /api/users — lista de usuarios (solo admin)
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const users = await User.find({}, { password_hash: 0 }).lean();
    res.json(users.map(u => ({ ...u, id: u._id })));
  } catch (err) { next(err); }
});

// POST /api/users — crear usuario (solo admin)
router.post('/', requireAdmin, audit('user'), async (req, res, next) => {
  try {
    const { usuario, password, role = 'viewer' } = req.body;
    if (!usuario || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });
    const exists = await User.findOne({ usuario: usuario.trim() });
    if (exists) return res.status(400).json({ error: 'El usuario ya existe' });
    const hash = await bcrypt.hash(password, 10);
    const id = await Counter.next('users');
    const user = await User.create({ _id: id, usuario: usuario.trim(), password_hash: hash, role, activo: true, created_at: new Date().toISOString() });
    res.json({ id: user._id, usuario: user.usuario, role: user.role, activo: user.activo });
  } catch (err) { next(err); }
});

// DELETE /api/users/:id — eliminar usuario (solo admin)
router.delete('/:id', requireAdmin, audit('user'), async (req, res, next) => {
  try {
    const user = await User.findById(Number(req.params.id));
    if (!user) return res.status(404).json({ error: 'No encontrado' });
    if (user.role === 'admin') {
      const adminCount = await User.countDocuments({ role: 'admin', activo: true });
      if (adminCount <= 1) return res.status(400).json({ error: 'No podés eliminar el único administrador' });
    }
    await User.findByIdAndDelete(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /api/users/:id/password — cambiar contraseña (solo admin)
router.put('/:id/password', requireAdmin, audit('user_password'), async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    const hash = await bcrypt.hash(password, 10);
    await User.findByIdAndUpdate(Number(req.params.id), { password_hash: hash });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
