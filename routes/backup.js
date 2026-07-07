const express = require('express');
const router = express.Router();
const multer = require('multer');
const AdmZip = require('adm-zip');
const { asyncHandler } = require('../middleware/errorHandler');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const { writeAudit } = require('../middleware/audit');
const models = require('../models');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Sectores del backup: cada colección en su propio archivo JSON (nombre humano).
const SECTORES = [
  { model: 'Local', file: 'locales' },
  { model: 'Rubro', file: 'rubros' },
  { model: 'Subrubro', file: 'subrubros' },
  { model: 'Movimiento', file: 'movimientos' },
  { model: 'Campo', file: 'campos' },
  { model: 'Categoria', file: 'categorias' },
  { model: 'CajaMovimiento', file: 'caja_movimientos' },
  { model: 'CajaConfig', file: 'caja_config' },
  { model: 'AppConfig', file: 'configuracion' },
  { model: 'ImportConfig', file: 'import_config' },
  { model: 'Producto', file: 'productos' },
  { model: 'MovimientoStock', file: 'movimientos_stock' },
  { model: 'IvaCompra', file: 'iva_compras' },
  { model: 'IvaVenta', file: 'iva_ventas' },
  { model: 'IvaConfig', file: 'iva_config' },
  { model: 'User', file: 'usuarios' },     // se exporta SIN password_hash
  { model: 'Audit', file: 'auditoria' },
  { model: 'Counter', file: 'counters' },   // preserva los auto-increment
];

// Colecciones que la importación NO toca por seguridad:
// - User: el backup no incluye contraseñas; reimportarlo dejaría a todos sin poder entrar.
// - Audit: es un registro histórico; reinsertarlo duplicaría o falsearía la traza.
const NO_IMPORTAR = new Set(['User', 'Audit']);

const README = `CA-Gestión — Backup de datos
================================

Este archivo ZIP contiene una copia completa de la base de datos, con cada
módulo en su propio archivo JSON (locales, rubros, subrubros, movimientos,
caja, stock, IVA, configuración y auditoría).

- metadata.json  → información general (fecha, versión, cantidad de registros).
- backup.json    → volcado canónico usado para RE-IMPORTAR.
- *.json         → cada colección por separado (para inspección).

IMPORTANTE
- usuarios.json NO incluye contraseñas.
- Para restaurar: Configuración → Backup y Recuperación → Importar, y subí
  este mismo ZIP. La importación NO modifica usuarios ni auditoría.
- La importación en modo "reemplazar" borra los datos actuales de cada módulo
  antes de cargar los del backup. Hacé un backup nuevo antes de importar.
`;

// GET /api/backup/export — descarga un ZIP con todos los datos sectorizados.
router.get('/export', requireSuperAdmin, asyncHandler(async (req, res) => {
  const data = {};
  const counts = {};
  for (const { model, file } of SECTORES) {
    const Model = models[model];
    if (!Model) continue;
    let docs = await Model.find().lean();
    if (model === 'User') docs = docs.map(({ password_hash, ...rest }) => rest);
    data[model] = docs;
    counts[file] = docs.length;
  }

  const metadata = {
    app: 'CA-Gestión',
    version: 1,
    exportedAt: new Date().toISOString(),
    generatedBy: req.user?.usuario || 'desconocido',
    counts,
  };

  const zip = new AdmZip();
  zip.addFile('metadata.json', Buffer.from(JSON.stringify(metadata, null, 2)));
  zip.addFile('README.txt', Buffer.from(README));
  // Volcado canónico para reimportar
  zip.addFile('backup.json', Buffer.from(JSON.stringify({ version: 1, exportedAt: metadata.exportedAt, data }, null, 2)));
  // Un archivo por sector
  for (const { model, file } of SECTORES) {
    zip.addFile(`${file}.json`, Buffer.from(JSON.stringify(data[model] ?? [], null, 2)));
  }
  const buf = zip.toBuffer();

  await writeAudit({
    usuario: req.user?.usuario || 'desconocido',
    user_id: req.user?.userId || null,
    accion: 'create',
    recurso: 'backup_export',
    recurso_id: metadata.exportedAt,
    diff: { counts },
    ip: req.ip,
  });

  const fecha = new Date().toISOString().slice(0, 10).replace(/-/g, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="backup_${fecha}.zip"`);
  res.send(buf);
}));

// Extrae el objeto `data` (Model → docs) de un archivo subido (ZIP o JSON).
function parseBackup(file) {
  const nombre = (file.originalname || '').toLowerCase();
  const esZip = nombre.endsWith('.zip') || file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed';

  if (esZip) {
    const zip = new AdmZip(file.buffer);
    const entry = zip.getEntry('backup.json');
    if (!entry) throw new Error('El ZIP no contiene backup.json (¿es un backup válido de CA-Gestión?)');
    const dump = JSON.parse(entry.getData().toString('utf8'));
    if (!dump || typeof dump.data !== 'object') throw new Error('backup.json con formato inválido');
    return dump.data;
  }

  // JSON suelto: acepta { data:{...} } o directamente { Model:[...] }
  const raw = JSON.parse(file.buffer.toString('utf8'));
  if (raw && typeof raw.data === 'object') return raw.data;
  if (raw && typeof raw === 'object') return raw;
  throw new Error('Archivo JSON con formato inválido');
}

// POST /api/backup/import  (multipart: file; body: mode=merge|replace)
router.post('/import', requireSuperAdmin, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Subí un archivo de backup (.zip o .json)' });

  let data;
  try {
    data = parseBackup(req.file);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const conocidos = SECTORES.map(s => s.model);
  const presentes = Object.keys(data).filter(k => conocidos.includes(k));
  if (presentes.length === 0) {
    return res.status(400).json({ error: 'El backup no contiene ninguna colección reconocida' });
  }

  const mode = req.body.mode === 'replace' ? 'replace' : 'merge';
  const resultado = {};
  const saltados = [];

  for (const model of presentes) {
    if (NO_IMPORTAR.has(model)) { saltados.push(model); continue; }
    const Model = models[model];
    const docs = Array.isArray(data[model]) ? data[model] : [];
    try {
      if (mode === 'replace') await Model.deleteMany({});
      if (docs.length > 0) {
        if (mode === 'replace') {
          await Model.insertMany(docs, { ordered: false });
        } else {
          // merge: upsert por _id
          const ops = docs
            .filter(d => d && d._id !== undefined)
            .map(d => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } }));
          if (ops.length) await Model.bulkWrite(ops, { ordered: false });
        }
      }
      resultado[model] = docs.length;
    } catch (err) {
      // insertMany/bulkWrite pueden tener errores parciales (duplicados): no abortamos.
      resultado[model] = `${docs.length} (con avisos: ${err.writeErrors?.length || 1})`;
    }
  }

  await writeAudit({
    usuario: req.user?.usuario || 'desconocido',
    user_id: req.user?.userId || null,
    accion: 'update',
    recurso: 'backup_import',
    recurso_id: new Date().toISOString(),
    diff: { mode, resultado, saltados },
    ip: req.ip,
  });

  res.json({ ok: true, mode, importado: resultado, saltados });
}));

module.exports = router;
