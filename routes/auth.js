const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const router = express.Router();

router.post('/login', async (req, res) => {
  const { usuario, password } = req.body;
  const userOk = usuario?.trim() === (process.env.ADMIN_USER || '').trim();
  const storedPass = (process.env.ADMIN_PASSWORD || '').trim();
  const passOk = userOk && (
    storedPass.startsWith('$2b$') || storedPass.startsWith('$2a$')
      ? await bcrypt.compare(password, storedPass)
      : password === storedPass
  );
  if (userOk && passOk) {
    const token = jwt.sign({ usuario }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
});

router.post('/refresh', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Sin token' });
  const token = auth.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const newToken = jwt.sign({ usuario: decoded.usuario }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token: newToken });
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
});

module.exports = router;
