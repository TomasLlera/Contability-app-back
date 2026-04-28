const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/:rubroId', (req, res) => {
  res.json(db.getCampos(req.params.rubroId));
});

router.post('/:rubroId', (req, res) => {
  const { nombre, tipo = 'text', orden = 0 } = req.body;
  res.json(db.createCampo(req.params.rubroId, nombre, tipo, orden));
});

router.put('/:id', (req, res) => {
  const { nombre, tipo, orden } = req.body;
  db.updateCampo(req.params.id, nombre, tipo, orden);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.deleteCampo(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
