const express = require('express');
const router = express.Router();
const db = require('../db');
const XLSX = require('xlsx');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

router.get('/export/:rubroId', (req, res) => {
  const rubro = db.getRubro(req.params.rubroId);
  if (!rubro) return res.status(404).json({ error: 'Rubro no encontrado' });

  const campos = db.getCampos(req.params.rubroId);
  const subrubros = db.getSubrubros(req.params.rubroId);
  const wb = XLSX.utils.book_new();

  for (const sub of subrubros) {
    const registros = db.getRegistros(sub.id);
    const rows = registros.map(reg => {
      const row = { Fecha: reg.fecha };
      for (const c of campos) {
        const val = reg.valores.find(v => v.campo_id === c.id);
        row[c.nombre] = val?.valor ?? '';
      }
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Fecha: '' }]);
    XLSX.utils.book_append_sheet(wb, ws, sub.nombre.substring(0, 31));
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${rubro.nombre}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.post('/import/:rubroId', upload.single('file'), (req, res) => {
  const rubro = db.getRubro(req.params.rubroId);
  if (!rubro) return res.status(404).json({ error: 'Rubro no encontrado' });

  const campos = db.getCampos(req.params.rubroId);
  const campoMap = Object.fromEntries(campos.map(c => [c.nombre.toLowerCase(), c.id]));

  const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  let imported = 0;

  for (const sheetName of wb.SheetNames) {
    let sub = db.getSubrubros(req.params.rubroId).find(s => s.nombre === sheetName);
    if (!sub) sub = db.createSubrubro(req.params.rubroId, sheetName);

    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
    for (const row of rows) {
      const fecha = String(row['Fecha'] || row['fecha'] || new Date().toISOString().split('T')[0]);
      const valores = {};
      for (const [key, val] of Object.entries(row)) {
        const campoId = campoMap[key.toLowerCase()];
        if (campoId) valores[campoId] = String(val);
      }
      db.createRegistro(sub.id, fecha, valores);
      imported++;
    }
  }

  res.json({ ok: true, imported });
});

router.get('/:subrubroId', (req, res) => {
  res.json(db.getRegistros(req.params.subrubroId));
});

router.post('/:subrubroId', (req, res) => {
  const { fecha, valores } = req.body;
  const sub = db.getSubrubro(req.params.subrubroId);
  if (!sub) return res.status(404).json({ error: 'Sub-rubro no encontrado' });
  const id = db.createRegistro(req.params.subrubroId, fecha, valores);
  res.json({ id, subrubro_id: req.params.subrubroId, fecha });
});

router.put('/:id', (req, res) => {
  const { fecha, valores } = req.body;
  db.updateRegistro(req.params.id, fecha, valores);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.deleteRegistro(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
