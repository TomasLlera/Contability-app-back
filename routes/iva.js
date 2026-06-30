const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const { IvaCompra, IvaVenta, IvaConfig, Counter } = require('../models');
const requireAdmin = require('../middleware/requireAdmin');
const { audit } = require('../middleware/audit');
const upload = multer({ storage: multer.memoryStorage() });

const nowTs = () => new Date().toISOString();
const withId = doc => doc ? { ...doc, id: doc._id } : doc;

// Definición de columnas esperadas en el Excel (con sinónimos para tolerar variaciones).
// `tipo` define cómo se parsea el valor; el primer sinónimo es el nombre canónico por defecto.
const COLUMNS = [
  { key: 'fecha',           label: 'Fecha',           tipo: 'fecha', sum: false, syn: ['Fecha', 'Fecha Comprobante', 'Fecha Emisión'] },
  { key: 'tipo',            label: 'Tipo',            tipo: 'texto', sum: false, syn: ['Tipo', 'Tipo Comprobante', 'Tipo de Comprobante'] },
  { key: 'documento',       label: 'Documento',       tipo: 'texto', sum: false, syn: ['Documento', 'Tipo Doc', 'Tipo Documento'] },
  { key: 'nro_doc',         label: 'Nro Doc Emisor',  tipo: 'texto', sum: false, syn: ['Nro Doc Emisor', 'Nro Doc', 'Número Doc Emisor', 'Nro Documento', 'CUIT'] },
  { key: 'razon_social',    label: 'Razón Social',    tipo: 'texto', sum: false, syn: ['Razón Social', 'Razon Social', 'Proveedor', 'Denominación'] },
  { key: 'iva_21',          label: 'IVA 21%',         tipo: 'monto', sum: true,  syn: ['IVA 21%', 'IVA 21', 'IVA21', 'IVA 21 %'] },
  { key: 'neto_grav_21',    label: 'Neto Grav. 21%',  tipo: 'monto', sum: false, syn: ['Neto Grav. 21%', 'Neto Grav 21%', 'Neto Gravado 21%', 'Neto Grav. 21'] },
  { key: 'neto_gravado',    label: 'Neto Gravado',    tipo: 'monto', sum: true,  syn: ['Neto Gravado', 'Neto Grav.', 'Neto'] },
  { key: 'otros_atributos', label: 'Otros Atributos', tipo: 'texto', sum: false, syn: ['Otros Atributos', 'Otros', 'Otros Tributos'] },
  { key: 'total_iva',       label: 'Total IVA',       tipo: 'monto', sum: true,  syn: ['Total IVA', 'Total I.V.A.', 'IVA Total'] },
  { key: 'imp_total',       label: 'Imp. Total',      tipo: 'monto', sum: true,  syn: ['Imp. Total', 'Imp Total', 'Importe Total', 'Total Comprobante', 'Total'] },
  // Retenciones/percepciones: sum:false → NUNCA se suman al Imp. Total / Total IVA / Neto.
  // Se guardan aparte y se acumulan por mes en el resumen como pagos a cuenta.
  { key: 'percepcion_iva',  label: 'Percepción IVA',  tipo: 'monto', sum: false, syn: ['Percepción IVA', 'Percepcion IVA', 'Perc. IVA', 'Percepción de IVA', 'Percep. IVA', 'Percep IVA'] },
  { key: 'ingresos_brutos', label: 'Ingresos Brutos', tipo: 'monto', sum: false, syn: ['Ingresos Brutos', 'IIBB', 'Ing. Brutos', 'Percepción IIBB', 'Percepcion IIBB', 'Perc. IIBB', 'Ingresos Brutos Percepción'] },
];
const SUM_FIELDS = COLUMNS.filter(c => c.sum).map(c => c.key); // iva_21, neto_gravado, total_iva, imp_total

// Normaliza un encabezado: minúsculas, sin acentos, solo alfanumérico → "IVA 21%" == "iva 21" == "iva21".
const norm = s => (s ?? '').toString().toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// Tokens que delatan la fila de encabezado real de un Excel de compras AFIP.
const HEADER_TOKENS = ['fecha', 'tipo', 'documento', 'doc', 'emisor', 'razon', 'social', 'iva', 'neto', 'gravado', 'total', 'imp', 'importe', 'comprobante', 'cuit'];

// Escanea las primeras filas y devuelve el índice de la que parece el encabezado
// (la que más tokens conocidos contiene). Permite filas de título por encima.
function detectHeaderRow(matrix, maxScan = 15) {
  let best = 0, bestScore = -1;
  for (let i = 0; i < Math.min(matrix.length, maxScan); i++) {
    let score = 0;
    for (const cell of (matrix[i] || [])) {
      const n = norm(cell);
      if (n && HEADER_TOKENS.some(t => n === t || n.includes(t))) score++;
    }
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return bestScore >= 2 ? best : 0;
}

// --- Helpers de parseo ---------------------------------------------------

// Convierte fecha (Date de Excel, serial, o string DD/MM/AAAA o AAAA-MM-DD) a YYYY-MM-DD.
function parseFecha(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date && !isNaN(value)) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()))
      .toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && value > 0 && value < 60000) {
    const d = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = value.toString().trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yr}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Convierte "1.234,56" / "$ 1234.56" / 1234 a Number.
function parseMonto(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value;
  let s = value.toString().replace(/[^\d.,-]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

// Clave de deduplicación estable: misma fecha + misma razón social + mismo importe total.
const dedupKey = (fecha, razon, imp) => `${fecha}|${norm(razon)}|${Math.round((imp || 0) * 100)}`;

// Resuelve el valor de una columna interna en una fila, probando el override del
// usuario y luego los sinónimos. `headerMap` mapea encabezado normalizado → key real.
function pickCol(row, headerMap, col, mapping) {
  const candidates = [];
  if (mapping && mapping[col.key]) candidates.push(mapping[col.key]);
  candidates.push(...col.syn);
  for (const cand of candidates) {
    const realKey = headerMap[norm(cand)];
    if (realKey !== undefined && row[realKey] !== undefined && row[realKey] !== null && row[realKey] !== '') {
      return row[realKey];
    }
  }
  return undefined;
}

async function getMapping() {
  const cfg = await IvaConfig.findById('main').lean();
  return cfg?.mapping || {};
}

// =========================================================================
// CONFIG de columnas
// =========================================================================

// GET /api/iva/config — metadatos de columnas + overrides guardados
router.get('/config', async (req, res, next) => {
  try {
    const mapping = await getMapping();
    const columns = COLUMNS.map(c => ({
      key: c.key, label: c.label, tipo: c.tipo, sum: c.sum,
      default: c.syn[0], actual: mapping[c.key] || c.syn[0],
    }));
    res.json({ columns, mapping });
  } catch (err) { next(err); }
});

// PUT /api/iva/config — guarda overrides de nombres de columna
router.put('/config', requireAdmin, audit('iva_config'), async (req, res, next) => {
  try {
    const incoming = req.body.mapping || {};
    const mapping = {};
    for (const c of COLUMNS) {
      const v = (incoming[c.key] || '').toString().trim();
      if (v && norm(v) !== norm(c.syn[0])) mapping[c.key] = v; // solo guarda si difiere del default
    }
    await IvaConfig.findByIdAndUpdate('main', { mapping, updated_at: nowTs() }, { upsert: true });
    res.json({ ok: true, mapping });
  } catch (err) { next(err); }
});

// =========================================================================
// COMPRAS
// =========================================================================

// GET /api/iva/compras — todas las filas importadas
router.get('/compras', async (req, res, next) => {
  try {
    const compras = await IvaCompra.find({}).sort({ fecha: -1, _id: -1 }).lean();
    res.json(compras.map(withId));
  } catch (err) { next(err); }
});

// GET /api/iva/compras/lotes — resumen de cada archivo importado
router.get('/compras/lotes', async (req, res, next) => {
  try {
    const lotes = await IvaCompra.aggregate([
      { $group: {
          _id: '$lote',
          archivo: { $first: '$archivo' },
          created_at: { $first: '$created_at' },
          filas: { $sum: 1 },
          imp_total: { $sum: '$imp_total' },
      } },
      { $sort: { created_at: -1 } },
    ]);
    res.json(lotes.map(l => ({ lote: l._id, archivo: l.archivo, created_at: l.created_at, filas: l.filas, imp_total: l.imp_total })));
  } catch (err) { next(err); }
});

// POST /api/iva/compras/import — sube un Excel, valida duplicados y ACUMULA
router.post('/compras/import', requireAdmin, audit('iva_compra_import'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const mapping = await getMapping();
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = (req.body.sheet && wb.Sheets[req.body.sheet]) ? req.body.sheet : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];

    // Leemos como matriz (header:1) para poder ubicar la fila de encabezado real,
    // que en exportaciones AFIP suele venir debajo de filas de título.
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!matrix.length) return res.status(400).json({ error: 'El Excel no tiene filas.' });

    let headerRow = Number(req.body.headerRow);
    if (!Number.isInteger(headerRow) || headerRow < 0 || headerRow >= matrix.length) headerRow = detectHeaderRow(matrix);
    const headers = (matrix[headerRow] || []).map(h => (h == null ? '' : String(h).trim()));

    // Reconstruimos objetos { encabezado: valor } a partir de la fila de header detectada.
    const rows = matrix.slice(headerRow + 1).map(r => {
      const o = {};
      headers.forEach((h, i) => { if (h !== '') o[h] = r[i]; });
      return o;
    });
    if (!rows.length) return res.status(400).json({ error: 'El Excel no tiene filas de datos.' });

    // Índice de encabezados normalizados
    const headerMap = {};
    for (const h of headers) if (h !== '') headerMap[norm(h)] = h;

    // dryRun: solo analiza y cuenta (no inserta) — el front lo usa para avisar de duplicados.
    // incluirDuplicados: guarda las filas duplicadas igual (caso notas de crédito repetidas).
    const dryRun = req.body.dryRun === 'true' || req.body.dryRun === true;
    const incluirDuplicados = req.body.incluirDuplicados === 'true' || req.body.incluirDuplicados === true;

    // Claves de dedup ya existentes en la base
    const existentes = await IvaCompra.find({}, { dedup_key: 1 }).lean();
    const claves = new Set(existentes.map(e => e.dedup_key));

    const parsed = [];
    let duplicadas = 0, vacias = 0;
    for (const row of rows) {
      const fecha = parseFecha(pickCol(row, headerMap, COLUMNS[0], mapping));
      const razon_social = (pickCol(row, headerMap, COLUMNS[4], mapping) || '').toString().trim();
      const imp_total = parseMonto(pickCol(row, headerMap, COLUMNS[10], mapping));

      if (!fecha && !razon_social && !imp_total) { vacias++; continue; }
      if (!fecha) { vacias++; continue; } // sin fecha no se agrupa por mes

      const key = dedupKey(fecha, razon_social, imp_total);
      const esDup = claves.has(key); // ya existe (en base o en este mismo archivo)
      if (esDup) {
        duplicadas++;
        if (!incluirDuplicados) continue; // omitir duplicado salvo que se pida guardarlo igual
      }
      claves.add(key);

      parsed.push({
        fecha, mes: fecha.slice(0, 7), razon_social, imp_total, dedup_key: key,
        tipo:            (pickCol(row, headerMap, COLUMNS[1], mapping) || '').toString().trim(),
        documento:       (pickCol(row, headerMap, COLUMNS[2], mapping) || '').toString().trim(),
        nro_doc:         (pickCol(row, headerMap, COLUMNS[3], mapping) || '').toString().trim(),
        iva_21:          parseMonto(pickCol(row, headerMap, COLUMNS[5], mapping)),
        neto_grav_21:    parseMonto(pickCol(row, headerMap, COLUMNS[6], mapping)),
        neto_gravado:    parseMonto(pickCol(row, headerMap, COLUMNS[7], mapping)),
        otros_atributos: (pickCol(row, headerMap, COLUMNS[8], mapping) || '').toString().trim(),
        total_iva:       parseMonto(pickCol(row, headerMap, COLUMNS[9], mapping)),
        // Retenciones/percepciones (no afectan ningún total del comprobante)
        percepcion_iva:  parseMonto(pickCol(row, headerMap, COLUMNS[11], mapping)),
        ingresos_brutos: parseMonto(pickCol(row, headerMap, COLUMNS[12], mapping)),
      });
    }

    // dryRun: devolvemos el conteo sin escribir nada (el front decide qué hacer con los duplicados)
    if (dryRun) {
      return res.json({ dryRun: true, importadas: parsed.length, duplicadas, vacias, archivo: req.file.originalname });
    }

    if (!parsed.length) {
      return res.status(duplicadas ? 200 : 400).json({
        importadas: 0, duplicadas, vacias, archivo: req.file.originalname,
        error: duplicadas ? undefined : 'No se encontraron filas válidas. Revisá los nombres de columna en Configurar columnas.',
      });
    }

    const lote = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const archivo = req.file.originalname || 'compras.xlsx';
    const created_at = nowTs();
    const startId = await Counter.nextBatch('iva_compras', parsed.length);
    const docs = parsed.map((p, i) => ({ _id: startId + i, ...p, archivo, lote, created_at }));
    await IvaCompra.insertMany(docs);

    res.json({ importadas: docs.length, duplicadas, vacias, archivo, lote, created_at, filas: docs.map(withId) });
  } catch (err) { next(err); }
});

// POST /api/iva/compras — carga manual de un comprobante de compra
router.post('/compras', requireAdmin, audit('iva_compra'), async (req, res, next) => {
  try {
    const fecha = parseFecha(req.body.fecha);
    if (!fecha) return res.status(400).json({ error: 'Fecha inválida' });
    const razon_social = (req.body.razon_social || '').toString().trim();
    const imp_total = parseMonto(req.body.imp_total);
    const id = await Counter.next('iva_compras');
    const compra = await IvaCompra.create({
      _id: id, fecha, mes: fecha.slice(0, 7), razon_social, imp_total,
      dedup_key: dedupKey(fecha, razon_social, imp_total),
      tipo:            (req.body.tipo || '').toString().trim(),
      documento:       (req.body.documento || '').toString().trim(),
      nro_doc:         (req.body.nro_doc || '').toString().trim(),
      iva_21:          parseMonto(req.body.iva_21),
      neto_grav_21:    parseMonto(req.body.neto_grav_21),
      neto_gravado:    parseMonto(req.body.neto_gravado),
      otros_atributos: (req.body.otros_atributos || '').toString().trim(),
      total_iva:       parseMonto(req.body.total_iva),
      // Retenciones/percepciones: aparte, no entran en ningún total del comprobante.
      percepcion_iva:  parseMonto(req.body.percepcion_iva),
      ingresos_brutos: parseMonto(req.body.ingresos_brutos),
      archivo: 'Carga manual', lote: 'manual', created_at: nowTs(),
    });
    res.json(withId(compra.toObject()));
  } catch (err) { next(err); }
});

// DELETE /api/iva/compras/:id — borra una fila
router.delete('/compras/:id', requireAdmin, audit('iva_compra'), async (req, res, next) => {
  try {
    await IvaCompra.findByIdAndDelete(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/iva/compras — borra un lote (?lote=) o TODAS las compras
router.delete('/compras', requireAdmin, audit('iva_compra_clear'), async (req, res, next) => {
  try {
    const filter = req.query.lote ? { lote: req.query.lote } : {};
    const r = await IvaCompra.deleteMany(filter);
    res.json({ ok: true, eliminadas: r.deletedCount });
  } catch (err) { next(err); }
});

// =========================================================================
// VENTAS (carga manual)
// =========================================================================

router.get('/ventas', async (req, res, next) => {
  try {
    const ventas = await IvaVenta.find({}).sort({ fecha: -1, _id: -1 }).lean();
    res.json(ventas.map(withId));
  } catch (err) { next(err); }
});

router.post('/ventas', requireAdmin, audit('iva_venta'), async (req, res, next) => {
  try {
    const fecha = parseFecha(req.body.fecha);
    const total = parseMonto(req.body.total);
    if (!fecha) return res.status(400).json({ error: 'Fecha inválida' });
    if (!total) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
    const id = await Counter.next('iva_ventas');
    const venta = await IvaVenta.create({
      _id: id, fecha, mes: fecha.slice(0, 7), total,
      concepto: (req.body.concepto || '').toString().trim(), created_at: nowTs(),
    });
    res.json(withId(venta.toObject()));
  } catch (err) { next(err); }
});

router.put('/ventas/:id', requireAdmin, audit('iva_venta'), async (req, res, next) => {
  try {
    const upd = {};
    if (req.body.fecha !== undefined) {
      const fecha = parseFecha(req.body.fecha);
      if (!fecha) return res.status(400).json({ error: 'Fecha inválida' });
      upd.fecha = fecha; upd.mes = fecha.slice(0, 7);
    }
    if (req.body.total !== undefined) upd.total = parseMonto(req.body.total);
    if (req.body.concepto !== undefined) upd.concepto = (req.body.concepto || '').toString().trim();
    await IvaVenta.findByIdAndUpdate(Number(req.params.id), upd);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/ventas/:id', requireAdmin, audit('iva_venta'), async (req, res, next) => {
  try {
    await IvaVenta.findByIdAndDelete(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// =========================================================================
// CRUCE — diferencia mensual (ventas - compras)
// =========================================================================

// Una Nota de Crédito de compra resta (no suma) en los totales. Se detecta por el
// texto del tipo ("Nota de Crédito ..." → "...credito...").
const esNotaCredito = (tipo) => norm(tipo).includes('credito');

// Agrega compras + ventas por mes y calcula la diferencia. Reusado por
// /resumen y por los exports (Excel/PDF).
//
// Las compras se netean: facturas suman, notas de crédito restan. Además se expone
// el desglose `por_tipo` (montos crudos por tipo + flag es_nc) para que el front
// pueda filtrar/sumar por tipo de comprobante.
async function buildResumen() {
  const [comprasAgg, ventasAgg] = await Promise.all([
    IvaCompra.aggregate([
      { $group: {
          _id: { mes: '$mes', tipo: '$tipo' },
          imp_total:    { $sum: '$imp_total' },
          total_iva:    { $sum: '$total_iva' },
          iva_21:       { $sum: '$iva_21' },
          neto_gravado: { $sum: '$neto_gravado' },
          percepcion_iva:  { $sum: '$percepcion_iva' },
          ingresos_brutos: { $sum: '$ingresos_brutos' },
          items:        { $sum: 1 },
      } },
    ]),
    IvaVenta.aggregate([
      { $group: { _id: '$mes', total: { $sum: '$total' }, items: { $sum: 1 } } },
    ]),
  ]);

  const emptyCompras = () => ({ imp_total: 0, total_iva: 0, iva_21: 0, neto_gravado: 0, percepcion_iva: 0, ingresos_brutos: 0, items: 0, facturas: 0, notas_credito: 0, por_tipo: {} });
  const map = {};
  const tiposSet = new Map(); // tipo -> es_nc (lista global de tipos para el filtro)

  for (const c of comprasAgg) {
    const mes = c._id?.mes;
    if (!mes) continue;
    const tipo = (c._id.tipo || '').trim() || 'Sin tipo';
    const es_nc = esNotaCredito(tipo);
    const signo = es_nc ? -1 : 1;
    tiposSet.set(tipo, es_nc);

    if (!map[mes]) map[mes] = { mes, compras: emptyCompras(), ventas: 0, ventas_items: 0 };
    const cp = map[mes].compras;
    cp.imp_total    += signo * c.imp_total;
    cp.total_iva    += signo * c.total_iva;
    cp.iva_21       += signo * c.iva_21;
    cp.neto_gravado += signo * c.neto_gravado;
    // Retenciones/percepciones: se acumulan por mes (NC las revierte, igual que el resto)
    // pero NO entran en la diferencia del cruce (que usa solo total_iva).
    cp.percepcion_iva  += signo * c.percepcion_iva;
    cp.ingresos_brutos += signo * c.ingresos_brutos;
    cp.items        += c.items;
    cp.facturas      += es_nc ? 0 : c.imp_total;
    cp.notas_credito += es_nc ? c.imp_total : 0;
    cp.por_tipo[tipo] = { tipo, es_nc, imp_total: c.imp_total, total_iva: c.total_iva, iva_21: c.iva_21, neto_gravado: c.neto_gravado, items: c.items };
  }
  for (const v of ventasAgg) {
    if (!v._id) continue;
    if (!map[v._id]) map[v._id] = { mes: v._id, compras: emptyCompras(), ventas: 0, ventas_items: 0 };
    map[v._id].ventas = v.total;
    map[v._id].ventas_items = v.items;
  }

  // La diferencia del cruce usa el IVA acumulado en compras (crédito fiscal), no el Imp. Total.
  const meses = Object.values(map)
    .map(m => ({ ...m, diferencia: m.ventas - m.compras.total_iva }))
    .sort((a, b) => b.mes.localeCompare(a.mes));

  const totales = meses.reduce((acc, m) => ({
    compras_imp_total:     acc.compras_imp_total + m.compras.imp_total,
    compras_total_iva:     acc.compras_total_iva + m.compras.total_iva,
    compras_iva_21:        acc.compras_iva_21 + m.compras.iva_21,
    compras_neto_gravado:  acc.compras_neto_gravado + m.compras.neto_gravado,
    compras_percepcion_iva:  acc.compras_percepcion_iva + m.compras.percepcion_iva,
    compras_ingresos_brutos: acc.compras_ingresos_brutos + m.compras.ingresos_brutos,
    compras_facturas:      acc.compras_facturas + m.compras.facturas,
    compras_notas_credito: acc.compras_notas_credito + m.compras.notas_credito,
    ventas: acc.ventas + m.ventas,
    diferencia: acc.diferencia + m.diferencia,
  }), { compras_imp_total: 0, compras_total_iva: 0, compras_iva_21: 0, compras_neto_gravado: 0, compras_percepcion_iva: 0, compras_ingresos_brutos: 0, compras_facturas: 0, compras_notas_credito: 0, ventas: 0, diferencia: 0 });

  const tipos = [...tiposSet.entries()]
    .map(([tipo, es_nc]) => ({ tipo, es_nc }))
    .sort((a, b) => a.tipo.localeCompare(b.tipo));

  return { meses, totales, tipos };
}

const MESES_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const labelMes = (mes) => {
  if (!mes) return '';
  const [y, m] = mes.split('-');
  return `${MESES_ES[Number(m) - 1] || m} ${y}`;
};
const fmtMonto = (n) => (n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const saldoLabel = (dif) => ((dif || 0) >= 0 ? 'A favor' : 'En contra');

// GET /api/iva/resumen — agrupa por mes. Compras desglosa los 4 campos sumables;
// el cruce usa Imp. Total de compras vs total de ventas.
router.get('/resumen', async (req, res, next) => {
  try {
    res.json(await buildResumen());
  } catch (err) { next(err); }
});

// GET /api/iva/export-resumen — descarga Excel del cruce mensual
router.get('/export-resumen', async (req, res, next) => {
  try {
    const { meses, totales } = await buildResumen();
    const rows = meses.map(m => ({
      'Mes': labelMes(m.mes),
      'Compras (Imp. Total)': m.compras.imp_total,
      'IVA Compras': m.compras.total_iva,
      'Neto Gravado': m.compras.neto_gravado,
      'Percepción IVA': m.compras.percepcion_iva,
      'Ingresos Brutos': m.compras.ingresos_brutos,
      'Ventas': m.ventas,
      'Diferencia': m.diferencia,
      'Saldo': saldoLabel(m.diferencia),
    }));
    rows.push({
      'Mes': 'TOTALES',
      'Compras (Imp. Total)': totales.compras_imp_total,
      'IVA Compras': totales.compras_total_iva,
      'Neto Gravado': totales.compras_neto_gravado,
      'Percepción IVA': totales.compras_percepcion_iva,
      'Ingresos Brutos': totales.compras_ingresos_brutos,
      'Ventas': totales.ventas,
      'Diferencia': totales.diferencia,
      'Saldo': saldoLabel(totales.diferencia),
    });

    const ws = XLSX.utils.json_to_sheet(rows, {
      header: ['Mes', 'Compras (Imp. Total)', 'IVA Compras', 'Neto Gravado', 'Percepción IVA', 'Ingresos Brutos', 'Ventas', 'Diferencia', 'Saldo'],
    });
    ws['!cols'] = [16, 20, 16, 16, 16, 16, 16, 16, 12].map(w => ({ wch: w }));
    // Formato con 2 decimales en las columnas de montos (B..H), filas de datos + totales.
    for (let r = 1; r <= rows.length; r++) {
      for (const c of [1, 2, 3, 4, 5, 6, 7]) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.t === 'n') cell.z = '#,##0.00';
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Cruce IVA');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="iva-cruce.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { next(err); }
});

// GET /api/iva/export-resumen-pdf — reporte imprimible del cruce mensual
router.get('/export-resumen-pdf', async (req, res, next) => {
  try {
    const { meses, totales } = await buildResumen();
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    res.setHeader('Content-Disposition', 'attachment; filename="iva-cruce.pdf"');
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);

    doc.fontSize(18).font('Helvetica-Bold').text('Cruce mensual IVA', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').fillColor('#666')
      .text(`Emitido: ${new Date().toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`, { align: 'center' });
    doc.fillColor('#000').moveDown(1);

    const cols = [
      { label: 'Mes', w: 95, align: 'left' },
      { label: 'Compras (Imp.)', w: 85, align: 'right' },
      { label: 'IVA Compras', w: 75, align: 'right' },
      { label: 'Ventas', w: 80, align: 'right' },
      { label: 'Diferencia', w: 80, align: 'right' },
      { label: 'Saldo', w: 0, align: 'right' },
    ];
    const startX = doc.page.margins.left;
    const usableW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    cols[cols.length - 1].w = usableW - cols.slice(0, -1).reduce((s, c) => s + c.w, 0);

    const drawRow = (cells, { bold = false } = {}) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      let x = startX;
      cells.forEach((txt, i) => {
        doc.text(txt, x + 2, y, { width: cols[i].w - 4, align: cols[i].align });
        x += cols[i].w;
      });
      doc.moveDown(0.6);
    };

    drawRow(cols.map(c => c.label), { bold: true });
    doc.moveTo(startX, doc.y - 2).lineTo(startX + usableW, doc.y - 2).strokeColor('#ccc').stroke();
    doc.moveDown(0.2);

    for (const m of meses) {
      drawRow([
        labelMes(m.mes),
        fmtMonto(m.compras.imp_total),
        fmtMonto(m.compras.total_iva),
        fmtMonto(m.ventas),
        fmtMonto(m.diferencia),
        saldoLabel(m.diferencia),
      ]);
    }

    doc.moveTo(startX, doc.y).lineTo(startX + usableW, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.2);
    drawRow([
      'TOTALES',
      fmtMonto(totales.compras_imp_total),
      fmtMonto(totales.compras_total_iva),
      fmtMonto(totales.ventas),
      fmtMonto(totales.diferencia),
      saldoLabel(totales.diferencia),
    ], { bold: true });

    doc.end();
  } catch (err) { next(err); }
});

module.exports = router;
