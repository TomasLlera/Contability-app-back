const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');

router.get('/', asyncHandler(async (req, res) => {
  res.json(await db.getLocales());
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { nombre, icon } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  res.json(await db.createLocal(nombre, icon));
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await db.updateLocal(req.params.id, req.body.nombre, req.body.icon);
  res.json({ ok: true });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  await db.deleteLocal(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
