const express = require('express');
const router = express.Router();
const db = require('../db');
const { asyncHandler } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const { audit } = require('../middleware/audit');

// Bancos de la Caja del Día (multi-banco) y movimientos entre bancos propios.
// Ver db.js, sección BANCOS.

// --- Movimientos entre bancos (antes de /:id) ---
// GET /api/bancos/movimientos?desde=&hasta=
router.get('/movimientos', asyncHandler(async (req, res) => {
  res.json(await db.getMovimientosBanco({ desde: req.query.desde, hasta: req.query.hasta }));
}));

// body: { fecha, banco_origen_id, banco_destino_id, monto, descripcion?, idempotency_key? }
router.post('/movimientos', requireAdmin, audit('movimiento_banco'), asyncHandler(async (req, res) => {
  res.json(await db.createMovimientoBanco(req.body || {}, req.user?.usuario || null));
}));

router.put('/movimientos/:id', requireAdmin, audit('movimiento_banco'), asyncHandler(async (req, res) => {
  res.json(await db.updateMovimientoBanco(req.params.id, req.body || {}, req.user?.usuario || null));
}));

router.delete('/movimientos/:id', requireAdmin, audit('movimiento_banco'), asyncHandler(async (req, res) => {
  res.json(await db.deleteMovimientoBanco(req.params.id));
}));

// --- Bancos ---
router.get('/', asyncHandler(async (req, res) => {
  res.json(await db.getBancos());
}));

router.post('/', requireAdmin, audit('banco'), asyncHandler(async (req, res) => {
  res.json(await db.createBanco(req.body || {}));
}));

// body: { ids: [3, 1, 2] }
router.put('/orden', requireAdmin, audit('banco_orden'), asyncHandler(async (req, res) => {
  res.json(await db.reordenarBancos(req.body?.ids));
}));

router.put('/:id', requireAdmin, audit('banco'), asyncHandler(async (req, res) => {
  res.json(await db.updateBanco(req.params.id, req.body || {}));
}));

// Con movimientos → 409 (solo se puede desactivar).
router.delete('/:id', requireAdmin, audit('banco'), asyncHandler(async (req, res) => {
  res.json(await db.deleteBanco(req.params.id));
}));

module.exports = router;
