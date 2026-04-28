const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/:rubroId', async (req, res) => {
  try { res.json(await db.getCampos(req.params.rubroId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:rubroId', async (req, res) => {
  const { nombre, tipo = 'texto', orden = 0 } = req.body;
  try { res.json(await db.createCampo(req.params.rubroId, nombre, tipo, orden)); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  const { nombre, tipo, orden } = req.body;
  try { await db.updateCampo(req.params.id, nombre, tipo, orden); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try { await db.deleteCampo(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
