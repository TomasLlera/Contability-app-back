const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const router = express.Router();

router.post('/login', async (req, res) => {
  const { usuario, password } = req.body;
  const userOk = usuario === process.env.ADMIN_USER;
  const passOk = userOk && await bcrypt.compare(password, process.env.ADMIN_PASSWORD);
  if (userOk && passOk) {
    const token = jwt.sign({ usuario }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
});

module.exports = router;
