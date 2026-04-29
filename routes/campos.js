const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/:rubroId', asyncHandler(async (req, res) => {
  res.json(await db.getCampos(req.params.rubroId));
}));

router.post('/:rubroId', asyncHandler(async (req, res) => {
  const { nombre, tipo = 'texto', orden = 0 } = req.body;
  res.json(await db.createCampo(req.params.rubroId, nombre, tipo, orden));
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { nombre, tipo, orden } = req.body;
  await db.updateCampo(req.params.id, nombre, tipo, orden);
  res.json({ ok: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await db.deleteCampo(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
