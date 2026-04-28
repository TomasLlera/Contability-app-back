const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
  res.json(db.getRubros());
});

router.post('/', (req, res) => {
  const { nombre, local_id } = req.body;
  if (!nombre || !local_id) return res.status(400).json({ error: 'Nombre y local requeridos' });
  try {
    res.json(db.createRubro(nombre, local_id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', (req, res) => {
  const { nombre, icon } = req.body;
  db.updateRubro(req.params.id, nombre, icon);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.deleteRubro(req.params.id);
  res.json({ ok: true });
});

router.delete('/:id/movimientos', (req, res) => {
  try {
    const result = db.clearAllMovimientos(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id/import-config', (req, res) => {
  res.json(db.getImportConfig(req.params.id) || {});
});

router.put('/:id/import-config', (req, res) => {
  const { mapping, mode } = req.body;
  res.json(db.saveImportConfig(req.params.id, mapping, mode));
});

module.exports = router;
