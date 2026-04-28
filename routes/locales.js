const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => res.json(db.getLocales()));

router.post('/', (req, res) => {
  const { nombre, icon } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  res.json(db.createLocal(nombre, icon));
});

router.put('/:id', (req, res) => {
  const { nombre, icon } = req.body;
  db.updateLocal(req.params.id, nombre, icon);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.deleteLocal(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
