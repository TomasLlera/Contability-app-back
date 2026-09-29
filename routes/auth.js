const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { User, Counter } = require('../models');
const { writeAudit } = require('../middleware/audit');
const { verificarToken, payloadToken } = require('../middleware/authJwt');
const logger = require('../logger');

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
  logger.info({ usuario: envUser }, 'Super Admin migrado a la base de datos');
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
    if (res.modifiedCount > 0) logger.info({ migrados: res.modifiedCount }, 'Admins migrados a superadmin');
  } catch (err) {
    logger.warn({ err: err.message }, 'No se pudo ejecutar la migración de superadmin');
  }
}

router.post('/login', async (req, res) => {
  try {
    await seedAdminIfNeeded();
    const { usuario, password } = req.body;
    // Tipos en el borde: un objeto (p. ej. { "$ne": null }) rompía `.trim()` y
    // devolvía 500 con el mensaje interno.
    if (typeof usuario !== 'string' || typeof password !== 'string' || !usuario.trim() || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    const user = await User.findOne({ usuario: usuario.trim().toLowerCase(), activo: true });
    if (!user) {
      await writeAudit({ usuario: usuario || 'desconocido', accion: 'login_failed', recurso: 'auth', ip: req.ip, diff: { motivo: 'usuario_no_encontrado' } });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const passOk = await bcrypt.compare(password, user.password_hash);
    if (!passOk) {
      await writeAudit({ usuario: user.usuario, user_id: user._id, accion: 'login_failed', recurso: 'auth', ip: req.ip, diff: { motivo: 'password_invalido' } });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const token = jwt.sign(payloadToken(user), process.env.JWT_SECRET, { expiresIn: '7d' });
    await writeAudit({ usuario: user.usuario, user_id: user._id, accion: 'login', recurso: 'auth', ip: req.ip });
    res.json({ token, role: user.role });
  } catch (err) {
    logger.error({ err: err.message }, 'Error en login');
    res.status(500).json({ error: 'No se pudo iniciar sesión' });
  }
});

// Renueva el token solo si el usuario sigue activo, y con su rol ACTUAL. Antes
// re-firmaba el token viejo sin consultar la base: un usuario desactivado podía
// renovarlo indefinidamente y un cambio de rol nunca le llegaba.
router.post('/refresh', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Sin token' });
  try {
    const user = await verificarToken(auth.slice(7));
    if (!user) return res.status(401).json({ error: 'Token inválido, expirado o usuario desactivado' });
    const newToken = jwt.sign(payloadToken(user), process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token: newToken, role: user.role });
  } catch (err) {
    logger.error({ err: err.message }, 'Error al renovar el token');
    res.status(500).json({ error: 'No se pudo renovar la sesión' });
  }
});

module.exports = router;
module.exports.ensureSuperAdmin = ensureSuperAdmin;
