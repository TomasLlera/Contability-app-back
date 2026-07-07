const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { User, Counter } = require('../models');
const { writeAudit } = require('../middleware/audit');

// Seed del admin desde env vars si no hay usuarios en la DB
async function seedAdminIfNeeded() {
  const count = await User.countDocuments();
  if (count > 0) return;
  const envUser = (process.env.ADMIN_USER || '').trim().toLowerCase();
  const envPass = (process.env.ADMIN_PASSWORD || '').trim();
  if (!envUser || !envPass) return;
  const hash = envPass.startsWith('$2b$') || envPass.startsWith('$2a$')
    ? envPass
    : await bcrypt.hash(envPass, 10);
  const id = await Counter.next('users');
  await User.create({ _id: id, usuario: envUser, password_hash: hash, role: 'superadmin', activo: true, created_at: new Date().toISOString() });
  console.log(`Super Admin "${envUser}" migrado a la base de datos`);
}

// Migración one-shot: antes de esta versión, 'admin' era el rol de mayor privilegio.
// Si no existe ningún superadmin, promovemos a los admins existentes a 'superadmin'
// para que conserven exactamente el poder que ya tenían (incluida la gestión de
// usuarios). El nuevo rol 'admin' queda disponible como nivel intermedio.
async function ensureSuperAdmin() {
  try {
    const superCount = await User.countDocuments({ role: 'superadmin' });
    if (superCount > 0) return;
    const res = await User.updateMany({ role: 'admin' }, { $set: { role: 'superadmin' } });
    if (res.modifiedCount > 0) console.log(`Migrados ${res.modifiedCount} admin(s) a superadmin`);
  } catch (err) {
    console.warn('No se pudo ejecutar la migración de superadmin:', err.message);
  }
}

router.post('/login', async (req, res) => {
  try {
    await seedAdminIfNeeded();
    const { usuario, password } = req.body;
    const user = await User.findOne({ usuario: usuario?.trim().toLowerCase(), activo: true });
    if (!user) {
      await writeAudit({ usuario: usuario || 'desconocido', accion: 'login_failed', recurso: 'auth', ip: req.ip, diff: { motivo: 'usuario_no_encontrado' } });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const passOk = await bcrypt.compare(password, user.password_hash);
    if (!passOk) {
      await writeAudit({ usuario: user.usuario, user_id: user._id, accion: 'login_failed', recurso: 'auth', ip: req.ip, diff: { motivo: 'password_invalido' } });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const token = jwt.sign({ usuario: user.usuario, role: user.role, userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    await writeAudit({ usuario: user.usuario, user_id: user._id, accion: 'login', recurso: 'auth', ip: req.ip });
    res.json({ token, role: user.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/refresh', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Sin token' });
  const token = auth.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const newToken = jwt.sign(
      { usuario: decoded.usuario, role: decoded.role, userId: decoded.userId },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token: newToken, role: decoded.role });
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
});

module.exports = router;
module.exports.ensureSuperAdmin = ensureSuperAdmin;
