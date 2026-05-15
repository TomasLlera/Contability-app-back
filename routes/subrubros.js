const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');

router.get('/:rubroId', asyncHandler(async (req, res) => {
  res.json(await db.getSubrubros(req.params.rubroId));
}));

router.post('/:rubroId', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, monto_base = 0 } = req.body;
  res.json(await db.createSubrubro(req.params.rubroId, nombre, monto_base));
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, monto_base, icon } = req.body;
  await db.updateSubrubro(req.params.id, nombre, monto_base, icon);
  res.json({ ok: true });
}));

router.delete('/:id/movimientos', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await db.clearMovimientos(req.params.id));
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await db.deleteSubrubro(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
