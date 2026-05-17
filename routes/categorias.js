const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const { audit } = require('../middleware/audit');

router.get('/:rubroId', asyncHandler(async (req, res) => {
  res.json(await db.getCategorias(req.params.rubroId));
}));

router.post('/:rubroId', requireAdmin, audit('categoria'), asyncHandler(async (req, res) => {
  const { nombre, operacion, tipo_calculo, porcentaje_default } = req.body;
  if (!nombre || !operacion) return res.status(400).json({ error: 'Nombre y operación requeridos' });
  res.json(await db.createCategoria(req.params.rubroId, nombre, operacion, tipo_calculo, porcentaje_default));
}));

router.put('/:id', requireAdmin, audit('categoria'), asyncHandler(async (req, res) => {
  const { nombre, operacion, tipo_calculo, porcentaje_default } = req.body;
  await db.updateCategoria(req.params.id, nombre, operacion, tipo_calculo, porcentaje_default);
  res.json({ ok: true });
}));

router.delete('/:id', requireAdmin, audit('categoria'), asyncHandler(async (req, res) => {
  await db.deleteCategoria(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
