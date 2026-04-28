const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  try { res.json(await db.getRubros()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const { nombre, local_id } = req.body;
  if (!nombre || !local_id) return res.status(400).json({ error: 'Nombre y local requeridos' });
  try { res.json(await db.createRubro(nombre, local_id)); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try { await db.updateRubro(req.params.id, req.body.nombre, req.body.icon); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try { await db.deleteRubro(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/movimientos', async (req, res) => {
  try { res.json(await db.clearAllMovimientos(req.params.id)); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/:id/import-config', async (req, res) => {
  try { res.json((await db.getImportConfig(req.params.id)) || {}); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/import-config', async (req, res) => {
  try { res.json(await db.saveImportConfig(req.params.id, req.body.mapping, req.body.mode)); } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
