const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/:rubroId', (req, res) => {
  res.json(db.getSubrubros(req.params.rubroId));
});

router.post('/:rubroId', (req, res) => {
  const { nombre, monto_base = 0 } = req.body;
  res.json(db.createSubrubro(req.params.rubroId, nombre, monto_base));
});

router.put('/:id', (req, res) => {
  const { nombre, monto_base, icon } = req.body;
  db.updateSubrubro(req.params.id, nombre, monto_base, icon);
  res.json({ ok: true });
});

router.delete('/:id/movimientos', (req, res) => {
  try {
    const result = db.clearMovimientos(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  db.deleteSubrubro(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
