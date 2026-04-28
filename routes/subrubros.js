const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/:rubroId', async (req, res) => {
  try { res.json(await db.getSubrubros(req.params.rubroId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:rubroId', async (req, res) => {
  const { nombre, monto_base = 0 } = req.body;
  try { res.json(await db.createSubrubro(req.params.rubroId, nombre, monto_base)); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  const { nombre, monto_base, icon } = req.body;
  try { await db.updateSubrubro(req.params.id, nombre, monto_base, icon); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/movimientos', async (req, res) => {
  try { res.json(await db.clearMovimientos(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try { await db.deleteSubrubro(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
