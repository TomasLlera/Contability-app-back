const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  try { res.json(await db.getLocales()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const { nombre, icon } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  try { res.json(await db.createLocal(nombre, icon)); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try { await db.updateLocal(req.params.id, req.body.nombre, req.body.icon); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try { await db.deleteLocal(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
