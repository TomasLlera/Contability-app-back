const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');

router.get('/', asyncHandler(async (req, res) => {
  res.json(await db.getRubros());
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, local_id } = req.body;
  if (!nombre || !local_id) return res.status(400).json({ error: 'Nombre y local requeridos' });
  res.json(await db.createRubro(nombre, local_id));
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await db.updateRubro(req.params.id, req.body.nombre, req.body.icon);
  res.json({ ok: true });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await db.deleteRubro(req.params.id);
  res.json({ ok: true });
}));

router.delete('/:id/movimientos', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await db.clearAllMovimientos(req.params.id));
}));

router.get('/:id/import-config', asyncHandler(async (req, res) => {
  res.json((await db.getImportConfig(req.params.id)) || {});
}));

router.put('/:id/import-config', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await db.saveImportConfig(req.params.id, req.body.mapping, req.body.mode));
}));

module.exports = router;
