const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/:rubroId', async (req, res) => {
  try { res.json(await db.getCategorias(req.params.rubroId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:rubroId', async (req, res) => {
  const { nombre, operacion, tipo_calculo, porcentaje_default } = req.body;
  if (!nombre || !operacion) return res.status(400).json({ error: 'Nombre y operación requeridos' });
  try { res.json(await db.createCategoria(req.params.rubroId, nombre, operacion, tipo_calculo, porcentaje_default)); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  const { nombre, operacion, tipo_calculo, porcentaje_default } = req.body;
  try { await db.updateCategoria(req.params.id, nombre, operacion, tipo_calculo, porcentaje_default); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try { await db.deleteCategoria(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
