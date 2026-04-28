const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/:rubroId', (req, res) => {
  res.json(db.getCategorias(req.params.rubroId));
});

router.post('/:rubroId', (req, res) => {
  const { nombre, operacion, tipo_calculo, porcentaje_default } = req.body;
  if (!nombre || !operacion) return res.status(400).json({ error: 'Nombre y operación requeridos' });
  res.json(db.createCategoria(req.params.rubroId, nombre, operacion, tipo_calculo, porcentaje_default));
});

router.put('/:id', (req, res) => {
  const { nombre, operacion, tipo_calculo, porcentaje_default } = req.body;
  db.updateCategoria(req.params.id, nombre, operacion, tipo_calculo, porcentaje_default);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.deleteCategoria(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
