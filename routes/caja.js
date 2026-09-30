const express = require('express');
const router = express.Router();
const { CajaMovimiento, CajaDescarte, CajaConfig, Counter, Subrubro, Movimiento } = require('../models');
const db = require('../db');
const { computeSaldosFacturas } = db;
const requireAdmin = require('../middleware/requireAdmin');
const { audit } = require('../middleware/audit');
const { asyncHandler } = require('../middleware/errorHandler');
const logger = require('../logger');
const { hoyLocal, sumarDias, esFechaValida } = require('../utils/tz');

const now = () => new Date().toISOString();

function withId(doc) {
  if (!doc) return null;
  const o = doc._id !== undefined ? doc : doc.toObject?.() ?? doc;
  return { ...o, id: o._id };
}
function withIds(docs) { return docs.map(withId); }

// Ventana mínima de "próximos vencimientos". La Caja de hoy los muestra aparte para
// poder pagarlos por adelantado sin navegar a su fecha (confirmar en un día futuro
// está bloqueado). Aunque la config tenga 0 días de anticipación, se miran al menos
// estos días hacia adelante.
const DIAS_PROXIMOS_MIN = 7;
const diasVentana = (cfg) => Math.max(Number(cfg?.dias_anticipacion_caja ?? 3) || 0, DIAS_PROXIMOS_MIN);

// Los gastos cargados a mano (sin factura) que quedan sin confirmar se arrastran a
// los días siguientes igual que los vencimientos, pero solo los creados desde esta
// fecha: los pendientes manuales anteriores quedan como estaban para no alterar el
// saldo de caja de hoy.
const ARRASTRE_MANUAL_DESDE = process.env.CAJA_ARRASTRE_MANUAL_DESDE || '2026-09-29';

const TIPOS_CAJA = ['saldo_inicial', 'saldo_cuenta', 'ingreso_extra', 'empleado', 'gasto'];

// Validación de los campos de un ítem de Caja (alta y edición; los ausentes no se
// validan). Devuelve el mensaje de error o null. Antes un monto negativo o una fecha
// imposible se guardaban tal cual, y un monto no numérico daba 500.
function validarCamposCaja({ fecha, tipo, monto, metodo }, tipoActual) {
  if (fecha !== undefined && !esFechaValida(fecha)) return 'Fecha inválida';
  if (tipo !== undefined && !TIPOS_CAJA.includes(tipo)) return `Tipo inválido: ${tipo}`;
  if (monto !== undefined) {
    const n = Number(monto);
    if (!Number.isFinite(n)) return 'El monto debe ser un número';
    // El saldo en cuenta puede ser 0 o negativo (cuenta en descubierto); el resto no.
    if ((tipo ?? tipoActual) !== 'saldo_cuenta' && n <= 0) return 'El monto debe ser mayor a 0';
  }
  if (metodo !== undefined && metodo !== null && !['efectivo', 'transferencia'].includes(metodo)) return `Método inválido: ${metodo}`;
  return null;
}

// Campos que necesitan el cálculo de saldos y el auto-sync. Las lecturas masivas de
// movimientos traían además campos_extra, idempotency_key, percepciones, etc.:
// ~960 KB por lectura con los datos actuales.
const CAMPOS_SALDO = {
  subrubro_id: 1, tipo: 1, fecha: 1, fecha_vencimiento: 1, monto: 1, pago: 1,
  facturas_vinculadas_ids: 1, pagado: 1, concepto: 1, metodo_pago: 1, documento: 1,
};

// GET /api/caja/config
router.get('/config', asyncHandler(async (req, res) => {
  const cfg = await CajaConfig.findById('main').lean();
  res.json(cfg || { empleados: [], proveedores: [], rubros_sync: [], dias_anticipacion_caja: 3 });
}));

// PUT /api/caja/config
router.put('/config', requireAdmin, audit('caja_config'), asyncHandler(async (req, res) => {
  const { empleados, proveedores, rubros_sync, dias_anticipacion_caja } = req.body;
  const upd = { empleados, proveedores };
  if (rubros_sync !== undefined) upd.rubros_sync = rubros_sync;
  if (dias_anticipacion_caja !== undefined) upd.dias_anticipacion_caja = Number(dias_anticipacion_caja);
  await CajaConfig.findByIdAndUpdate('main', { $set: upd }, { upsert: true });
  res.json({ ok: true });
}));

// Reconciliación: trae al día los ítems de caja auto-sincronizados (no confirmados)
// con el estado actual de su factura de origen. Corre SIEMPRE (incluso sin rubros
// sincronizados) para limpiar restos cuando se desactiva el sync.
//   • factura borrada / pagada / saldada → elimina el ítem de caja pendiente.
//   • cambió el saldo, el vencimiento o el concepto → actualiza el ítem.
// Sólo toca ítems auto-sync (auto_sync:true) o legacy con la firma del auto-sync
// (metodo null + movimiento_id), nunca gastos cargados a mano por el usuario.
//
// `autoItems` son TODOS los pendientes enlazados a una factura; el loop decide cuáles
// tocar: los auto-sync (auto_sync:true o firma legacy metodo:null) y, además,
// cualquiera cuya factura viva en un subrubro DEUDA (p. ej. gastos de remito que
// quedaron de antes de convertir el subrubro: su signo ya no corresponde).
// `ctx` son los movimientos, saldos y subrubros ya leídos por el auto-sync (ver
// cargarContextoSync): antes esta función hacía su propia lectura completa.
async function reconciliarAutoSync(autoItems, { movMap, saldoDe, subMap }) {
  if (autoItems.length === 0) return { actualizados: 0, eliminados: 0 };

  const facturaMap = new Map();
  for (const c of autoItems) {
    const f = movMap.get(c.movimiento_id);
    if (f) facturaMap.set(f._id, f);
  }

  const toDelete = [];
  const updateOps = [];
  for (const item of autoItems) {
    const f = facturaMap.get(item.movimiento_id);
    const subDe = f ? subMap[f.subrubro_id] : null;
    // Solo se tocan los ítems auto-generados (auto_sync / firma legacy) o los que
    // pertenecen a un subrubro DEUDA (restos con el signo viejo). Un gasto manual
    // vinculado a una factura de proveedor queda intacto.
    const esAuto = item.auto_sync || item.metodo == null;
    if (!esAuto && subDe?.tipo_subrubro !== 'deuda') continue;
    // Factura inexistente, ya no es factura, pagada o saldada → el pendiente sobra.
    if (!f || f.tipo !== 'factura' || f.pagado || saldoDe(f) <= 0.005) {
      toDelete.push(item._id);
      continue;
    }
    const sub = subMap[f.subrubro_id];
    const baseConcepto = sub?.nombre || 'Vencimiento';
    const concepto = f.concepto ? `${baseConcepto} — ${f.concepto}` : baseConcepto;
    const nuevoMonto = Number(saldoDe(f)) || 0;
    const nuevaFecha = f.fecha_vencimiento || item.fecha;
    const set = {};
    // El tipo del subrubro manda: deuda → ingreso pendiente de cobro; proveedor →
    // gasto. Si el subrubro cambió de tipo, el ítem pendiente corrige su signo.
    const tipoEsperado = sub?.tipo_subrubro === 'deuda' ? 'ingreso_extra' : 'gasto';
    if (item.tipo !== tipoEsperado) set.tipo = tipoEsperado;
    if (Math.abs((item.monto || 0) - nuevoMonto) > 0.005) set.monto = nuevoMonto;
    if (item.fecha !== nuevaFecha) set.fecha = nuevaFecha;
    if (item.concepto !== concepto) set.concepto = concepto;
    if (item.subrubro_id !== f.subrubro_id) set.subrubro_id = f.subrubro_id;
    // Método de pago: el subrubro manda. Si la factura tiene un método cargado y difiere
    // del ítem de Caja, se actualiza. Si la factura no tiene método (null), se respeta el
    // que el usuario haya puesto en la Caja (no se pisa).
    const metFactura = f.metodo_pago || null;
    if (metFactura && (item.metodo || null) !== metFactura) set.metodo = metFactura;
    if (!item.auto_sync) set.auto_sync = true; // backfill de la firma legacy
    if (Object.keys(set).length) {
      // Misma guarda que en el borrado: si el ítem se confirmó mientras corría el
      // reconciliador, no se le pisa monto/fecha/concepto — a partir de la
      // confirmación el dato autoritativo es el del pago real.
      updateOps.push({ updateOne: { filter: { _id: item._id, confirmado: false }, update: { $set: set } } });
    }
  }

  let eliminados = 0, actualizados = 0;
  if (toDelete.length) {
    // `confirmado: false` NO es redundante con el find de arriba: entre aquella
    // lectura y este borrado el usuario pudo haber confirmado el ítem, y confirmar
    // marca la factura como pagada — que es justamente la condición que lo puso en
    // toDelete. Sin esta guarda el reconciliador borraba pagos recién confirmados
    // (el ítem desaparecía de la Caja mientras el pago quedaba vivo en el Subrubro).
    const r = await CajaMovimiento.deleteMany({ _id: { $in: toDelete }, confirmado: false });
    eliminados = r.deletedCount || 0;
  }
  if (updateOps.length) {
    const r = await CajaMovimiento.bulkWrite(updateOps, { ordered: false });
    actualizados = r.modifiedCount || 0;
  }
  return { actualizados, eliminados };
}

// Lectura única que comparten la reconciliación y la creación de pendientes: todos
// los movimientos (solo CAMPOS_SALDO) de los subrubros sincronizados más los de las
// facturas que ya tienen un pendiente en Caja, sus saldos y sus subrubros. Antes cada
// paso leía por su cuenta el historial completo de casi los mismos subrubros, y esa
// doble lectura era lo más caro de abrir la Caja.
async function cargarContextoSync(autoItems, rubros_sync) {
  const [facturasRef, subrubrosSync] = await Promise.all([
    autoItems.length
      ? Movimiento.find({ _id: { $in: autoItems.map(c => c.movimiento_id) } }, { subrubro_id: 1 }).lean()
      : [],
    rubros_sync.length ? Subrubro.find({ rubro_id: { $in: rubros_sync } }).lean() : [],
  ]);
  const subIdsSync = subrubrosSync.map(s => s._id);
  const subIds = [...new Set([...subIdsSync, ...facturasRef.map(f => f.subrubro_id)])];

  // Saldo por factura = monto − pagos − NC (FIFO). Requiere TODOS los movimientos del
  // subrubro (NC/pagos pueden estar en otro mes), no solo las facturas vencidas.
  const [todos, subsExtra] = await Promise.all([
    subIds.length ? Movimiento.find({ subrubro_id: { $in: subIds } }, CAMPOS_SALDO).lean() : [],
    Subrubro.find({ _id: { $in: subIds.filter(id => !subIdsSync.includes(id)) } }).lean(),
  ]);
  const porSub = new Map();
  for (const m of todos) {
    if (!porSub.has(m.subrubro_id)) porSub.set(m.subrubro_id, []);
    porSub.get(m.subrubro_id).push(m);
  }
  const saldosPorSub = new Map();
  for (const [sid, lista] of porSub) saldosPorSub.set(sid, computeSaldosFacturas(lista));
  const saldoDe = (m) => saldosPorSub.get(m.subrubro_id)?.get(m._id) ?? m.monto;

  return {
    todos,
    movMap: new Map(todos.map(m => [m._id, m])),
    saldoDe,
    subMap: Object.fromEntries([...subrubrosSync, ...subsExtra].map(s => [s._id, s])),
    subIdsSync: new Set(subIdsSync),
  };
}

// POST /api/caja/auto-sync?fecha=YYYY-MM-DD
// Reconcilia los ítems existentes con su factura y crea los faltantes.
// Idempotente: crea CajaMovimiento (tipo='gasto', confirmado=false, metodo=null)
// por cada factura que vence dentro de la ventana en algún rubro sincronizado,
// siempre que no exista ya un caja item para ese movimiento_id.
router.post('/auto-sync', requireAdmin, asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'fecha requerida' });

  const [autoItems, cfg] = await Promise.all([
    CajaMovimiento.find({ confirmado: false, movimiento_id: { $ne: null } }).lean(),
    CajaConfig.findById('main').lean(),
  ]);
  const rubros_sync = cfg?.rubros_sync || [];
  const ctx = await cargarContextoSync(autoItems, rubros_sync);
  const { saldoDe, subMap } = ctx;

  // Reconciliar primero: refleja borrados/pagos/cambios de monto y vencimiento.
  // Corre SIEMPRE (incluso sin rubros sincronizados) para limpiar restos.
  const { actualizados, eliminados } = await reconciliarAutoSync(autoItems, ctx);
  const sinCreados = { creados: 0, actualizados, eliminados };

  if (rubros_sync.length === 0 || ctx.subIdsSync.size === 0) return res.json(sinCreados);

  // Crea también los que vencen dentro de la ventana de "próximos": viven en su
  // fecha de vencimiento (no se arrastran hacia atrás) y la Caja de hoy los lista
  // aparte para poder pagarlos por adelantado.
  // Incluye también los subrubros DEUDA: sus vencimientos entran a la Caja como
  // INGRESOS pendientes de cobro (tipo ingreso_extra, confirmado:false) en vez de
  // gastos. Al confirmarlos se registra el abono en el subrubro y suman al día.
  const hasta = sumarDias(fecha, diasVentana(cfg));

  // Incluye también vencidas (fecha_vencimiento <= hasta): si una factura venció
  // hace 5 días y no se pagó, queremos verla hoy en caja, no perderla. Se descartan
  // las que ya están saldadas por pagos/NC aunque conserven pagado === false.
  const vencimientos = ctx.todos
    .filter(m =>
      ctx.subIdsSync.has(m.subrubro_id) &&
      m.tipo === 'factura' && !m.pagado &&
      m.fecha_vencimiento != null && m.fecha_vencimiento <= hasta &&
      saldoDe(m) > 0.005
    )
    .sort((a, b) => (a.fecha_vencimiento || '').localeCompare(b.fecha_vencimiento || ''));

  if (vencimientos.length === 0) return res.json(sinCreados);

  // Dedupe global contra el PENDIENTE: si la factura ya tiene un ítem sin confirmar
  // (en cualquier fecha), no se crea otro; si no, una factura vencida no pagada
  // generaría un ítem nuevo cada día que se abre la caja. Los ítems confirmados no
  // cuentan: si la factura tuvo un pago parcial y le queda saldo, se crea el
  // pendiente por el resto (antes el saldo quedaba sin aparecer nunca en la Caja).
  const yaCreados = await CajaMovimiento.find({
    movimiento_id: { $in: vencimientos.map(v => v._id) },
    confirmado: false,
  }, { movimiento_id: 1 }).lean();
  const yaSet = new Set(yaCreados.map(c => c.movimiento_id));

  // Descartes del usuario para ESTA fecha: si borró el ítem hoy, no recrearlo hoy.
  // Al otro día (otra fecha, sin descarte) el vencimiento impago vuelve a aparecer.
  const descartados = await CajaDescarte.find({
    fecha,
    movimiento_id: { $in: vencimientos.map(v => v._id) },
  }, { movimiento_id: 1 }).lean();
  const descartadoSet = new Set(descartados.map(d => d.movimiento_id));

  const pendientes = vencimientos.filter(v => !yaSet.has(v._id) && !descartadoSet.has(v._id));
  if (pendientes.length === 0) return res.json(sinCreados);

  // Reservar IDs en bloque (solo se consumen si el upsert inserta).
  const startId = Counter.nextBatch
    ? await Counter.nextBatch('caja', pendientes.length)
    : null;

  // Upsert por movimiento_id: si dos llamadas al auto-sync corren en paralelo
  // (p. ej. el doble disparo de efectos de React en dev), ambas convergen al
  // mismo documento en vez de crear duplicados. El _id solo se fija al insertar.
  const ops = await Promise.all(pendientes.map(async (v, i) => {
    const sub = subMap[v.subrubro_id];
    const baseConcepto = sub?.nombre || 'Vencimiento';
    const concepto = v.concepto ? `${baseConcepto} — ${v.concepto}` : baseConcepto;
    // Deuda a cobrar → ingreso pendiente de cobro; factura de proveedor → gasto.
    const esDeuda = sub?.tipo_subrubro === 'deuda';
    const _id = startId != null ? startId + i : await Counter.next('caja');
    return {
      updateOne: {
        filter: { movimiento_id: v._id, confirmado: false },
        update: {
          $setOnInsert: {
            _id,
            // El caja item vive en la fecha de vencimiento. Si no se paga, el GET
            // lo arrastra hacia adelante mediante el lookback de fechas anteriores.
            fecha: v.fecha_vencimiento,
            tipo: esDeuda ? 'ingreso_extra' : 'gasto',
            concepto,
            monto: Number(saldoDe(v)) || 0,   // saldo actual, no monto original
            // Método heredado de la factura: si se cargó con efectivo/transferencia en
            // el subrubro, el ítem de Caja aparece ya con ese método (si no, sin definir).
            metodo: v.metodo_pago || null,
            subrubro_id: v.subrubro_id,
            movimiento_id: v._id,
            confirmado: false,
            auto_sync: true,
            es_especial: false,
            created_at: now(),
          },
        },
        upsert: true,
      },
    };
  }));

  // ordered:false + tolerancia a E11000: el índice único sobre movimiento_id es la
  // garantía final ante una carrera exacta; el duplicado perdedor se ignora.
  let creados = 0;
  try {
    const r = await CajaMovimiento.bulkWrite(ops, { ordered: false });
    creados = r.upsertedCount || 0;
  } catch (err) {
    if (err.code !== 11000 && !(err.writeErrors || []).every(e => e.code === 11000)) throw err;
    creados = err.result?.nUpserted ?? err.result?.result?.nUpserted ?? 0;
  }
  res.json({ creados, actualizados, eliminados });
}));

// GET /api/caja/facturas-pendientes?subrubro_id=X
router.get('/facturas-pendientes', asyncHandler(async (req, res) => {
  const { subrubro_id } = req.query;
  if (!subrubro_id) return res.status(400).json({ error: 'subrubro_id requerido' });

  // Saldo por factura: requiere TODOS los movimientos del subrubro (NC/pagos
  // pueden estar en otro mes). Así una 2da NC ve el saldo restante, no el original.
  const sid = Number(subrubro_id);
  const todos = await Movimiento.find({ subrubro_id: sid }).lean();
  const saldos = computeSaldosFacturas(todos);
  const movimientos = todos
    .filter(m => m.tipo === 'factura' && !m.pagado)
    .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

  res.json(movimientos.map(m => ({
    id: m._id,
    monto: m.monto,
    saldo: saldos.get(m._id) ?? m.monto,
    fecha: m.fecha,
    fecha_vencimiento: m.fecha_vencimiento,
    concepto: m.concepto || '',
  })));
}));

// Adjunta el tipo de comprobante de origen ('factura' | 'remito' | null) a cada
// ítem de caja enlazado a un movimiento. Es un campo DERIVADO de solo lectura: el
// dato vive en Movimiento.documento y la Caja lo muestra como badge. Los ítems
// manuales (movimiento_id null) quedan con documento null.
async function attachDocumento(movs) {
  const ids = [...new Set(movs.map(m => m.movimiento_id).filter(id => id != null))];
  if (ids.length === 0) return movs.map(m => ({ ...m, documento: null }));
  const facturas = await Movimiento.find({ _id: { $in: ids } }, { documento: 1 }).lean();
  const docMap = new Map(facturas.map(f => [f._id, f.documento || null]));
  return movs.map(m => ({ ...m, documento: docMap.get(m.movimiento_id) ?? null }));
}

// GET /api/caja/descuentos?desde=&hasta=&subrubro_id=
// Seguimiento de descuentos por pago aplicados en un rango. Alimenta el card del
// dashboard, el historial del subrubro y el filtro del historial de caja.
// Devuelve el detalle y los totales ya agregados (total descontado, cantidad de
// pagos y desglose por subrubro) para no recalcularlos en cada consumidor.
router.get('/descuentos', asyncHandler(async (req, res) => {
  const { desde, hasta, subrubro_id } = req.query;
  const filter = { descuento: { $gt: 0 } };
  if (desde) filter.fecha = { ...filter.fecha, $gte: desde };
  if (hasta) filter.fecha = { ...filter.fecha, $lte: hasta };
  if (subrubro_id) filter.subrubro_id = Number(subrubro_id);

  const items = await CajaMovimiento.find(filter).sort({ fecha: -1, _id: -1 }).lean();

  const subIds = [...new Set(items.map(i => i.subrubro_id).filter(id => id != null))];
  const subs = subIds.length ? await Subrubro.find({ _id: { $in: subIds } }, { nombre: 1 }).lean() : [];
  const nombreSub = new Map(subs.map(s => [s._id, s.nombre]));

  const porSubrubro = new Map();
  for (const i of items) {
    const k = i.subrubro_id ?? 0;
    const acc = porSubrubro.get(k) || { subrubro_id: i.subrubro_id ?? null, nombre: nombreSub.get(i.subrubro_id) || 'Sin subrubro', total: 0, count: 0 };
    acc.total += i.descuento || 0;
    acc.count += 1;
    porSubrubro.set(k, acc);
  }

  res.json({
    total: items.reduce((s, i) => s + (i.descuento || 0), 0),
    count: items.length,
    // Base bruta sobre la que se descontó — permite mostrar el % efectivo del período.
    total_bruto: items.reduce((s, i) => s + (Number(i.monto_bruto ?? i.monto) || 0), 0),
    por_subrubro: [...porSubrubro.values()].sort((a, b) => b.total - a.total),
    items: withIds(items).map(i => ({
      ...i,
      subrubro_nombre: nombreSub.get(i.subrubro_id) || null,
    })),
  });
}));

// GET /api/caja?fecha=YYYY-MM-DD
// Incluye vencimientos sincronizados de días anteriores que aún no fueron
// pagados ni confirmados — siguen pendientes hasta abonarse.
router.get('/', asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!esFechaValida(fecha)) return res.status(400).json({ error: 'fecha requerida (YYYY-MM-DD)' });
  res.json(await cajaDelDia(fecha));
}));

// Ítems que se ven en la Caja de `fecha`: los del día más los pendientes que se
// arrastran desde días anteriores.
async function cajaDelDia(fecha) {
  const movs = await CajaMovimiento.find({
    $or: [
      { fecha },
      {
        fecha: { $lt: fecha },
        // gasto = factura por pagar · ingreso_extra = deuda por cobrar: ambos se
        // arrastran hacia adelante mientras sigan sin confirmar.
        tipo: { $in: ['gasto', 'ingreso_extra'] },
        confirmado: false,
        movimiento_id: { $ne: null },
      },
      {
        // Gasto manual (sin factura) que quedó sin confirmar: también se arrastra,
        // así no hay que volver a su día para pagarlo. Solo los nuevos (ver
        // ARRASTRE_MANUAL_DESDE).
        fecha: { $lt: fecha },
        tipo: 'gasto',
        confirmado: false,
        movimiento_id: null,
        created_at: { $gte: ARRASTRE_MANUAL_DESDE },
      },
    ],
  }).sort({ fecha: 1, _id: 1 }).lean();
  return attachDocumento(withIds(movs));
}

// Pendientes que vencen después de `fecha`, dentro de la ventana de próximos.
async function proximosDe(fecha, cfg) {
  const hasta = sumarDias(fecha, diasVentana(cfg));
  const movs = await CajaMovimiento.find({
    fecha: { $gt: fecha, $lte: hasta },
    tipo: { $in: ['gasto', 'ingreso_extra'] },
    confirmado: false,
  }).sort({ fecha: 1, _id: 1 }).lean();
  return attachDocumento(withIds(movs));
}

// Saldo de efectivo con el que abre `fecha` (ver GET /saldo-anterior).
async function saldoAnteriorDe(fecha) {
  const ancla = await CajaMovimiento
    .findOne({ tipo: 'saldo_inicial', fecha: { $lte: fecha } })
    .sort({ fecha: -1, _id: -1 })
    .lean();
  // Sin ningún ancla no se puede afirmar un saldo: se devuelve null y la Caja muestra
  // "Sin datos" en lugar de un cero que se leería como un saldo real.
  if (!ancla) return { saldo: null, ancla_fecha: null, ancla_monto: null };

  // Desde el día del ancla inclusive (el saldo_inicial es la apertura de ese día)
  // hasta el día anterior al pedido.
  const movs = await CajaMovimiento.find(
    {
      fecha: { $gte: ancla.fecha, $lt: fecha },
      tipo: { $in: ['empleado', 'ingreso_extra', 'gasto'] },
      metodo: 'efectivo',
    },
    { tipo: 1, monto: 1, confirmado: 1 },
  ).lean();

  // confirmado === false = pendiente (gasto sin pagar / deuda sin cobrar): no movió plata.
  const saldo = movs.reduce(
    (s, m) => (m.confirmado === false ? s : s + (m.tipo === 'gasto' ? -1 : 1) * (m.monto || 0)),
    ancla.monto || 0,
  );
  return { saldo, ancla_fecha: ancla.fecha, ancla_monto: ancla.monto ?? 0 };
}

// GET /api/caja/dia?fecha=YYYY-MM-DD
// Todo lo que la Caja del Día necesita al abrir, en una sola request: los ítems
// del día, el saldo en cuenta de ayer, el saldo de efectivo de apertura y (si es
// hoy) los próximos vencimientos. Antes eran 4 requests en serie, y la de "ayer"
// traía la caja completa de ayer solo para leer un número.
router.get('/dia', asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!esFechaValida(fecha)) return res.status(400).json({ error: 'fecha requerida (YYYY-MM-DD)' });
  const esHoy = fecha === hoyLocal();
  const cfg = esHoy ? await CajaConfig.findById('main').lean() : null;
  const [movs, cuentaAyer, saldoAnterior, proximos] = await Promise.all([
    cajaDelDia(fecha),
    CajaMovimiento.findOne({ fecha: sumarDias(fecha, -1), tipo: 'saldo_cuenta' }, { monto: 1 }).lean(),
    saldoAnteriorDe(fecha),
    esHoy ? proximosDe(fecha, cfg) : Promise.resolve([]),
  ]);
  res.json({
    fecha,
    movs,
    saldo_cuenta_ayer: cuentaAyer?.monto ?? null,
    saldo_anterior: saldoAnterior,
    proximos,
  });
}));

// GET /api/caja/proximos?fecha=YYYY-MM-DD
// Pendientes (gastos por pagar y deudas por cobrar) que vencen DESPUÉS de `fecha`,
// dentro de la ventana de próximos. Viven en su fecha de vencimiento, así que el
// GET del día no los trae: la Caja de hoy los muestra en una sección aparte para
// poder pagarlos por adelantado desde hoy.
router.get('/proximos', asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!esFechaValida(fecha)) return res.status(400).json({ error: 'fecha requerida (YYYY-MM-DD)' });
  const cfg = await CajaConfig.findById('main').lean();
  res.json(await proximosDe(fecha, cfg));
}));

// GET /api/caja/saldo-anterior?fecha=YYYY-MM-DD
// Saldo de efectivo con el que abre `fecha`: parte del último saldo_inicial cargado a
// mano —en cualquier fecha anterior, SIN ventana— y le encadena los movimientos de
// efectivo confirmados hasta el día previo.
//
// Vive en el backend a propósito. El front lo resolvía trayendo los últimos 30 días y
// encadenándolos en el cliente; cuando el último ancla quedaba fuera de esa ventana la
// cadena arrancaba de CERO y el saldo se desplomaba de un día para el otro sin aviso.
router.get('/saldo-anterior', asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!esFechaValida(fecha)) return res.status(400).json({ error: 'fecha requerida (YYYY-MM-DD)' });
  res.json(await saldoAnteriorDe(fecha));
}));

// GET /api/caja/rango?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&page=&limit=
router.get('/rango', asyncHandler(async (req, res) => {
  const { desde, hasta } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = req.query.limit ? Math.min(2000, Math.max(1, Number(req.query.limit))) : null;

  const filter = {};
  if (desde) filter.fecha = { ...filter.fecha, $gte: desde };
  if (hasta) filter.fecha = { ...filter.fecha, $lte: hasta };

  let q = CajaMovimiento.find(filter).sort({ fecha: 1, _id: 1 });
  if (limit) q = q.skip((page - 1) * limit).limit(limit);
  const movs = await q.lean();

  if (limit) {
    const total = await CajaMovimiento.countDocuments(filter);
    return res.json({ items: withIds(movs), total, page, limit });
  }
  res.json(withIds(movs));
}));

// POST /api/caja
router.post('/', requireAdmin, audit('caja'), asyncHandler(async (req, res) => {
  const { fecha, tipo, concepto, monto, metodo, subrubro_id, es_especial, movimiento_id, confirmado, idempotency_key } = req.body;
  if (!fecha || !tipo || !concepto || !monto) return res.status(400).json({ error: 'Faltan campos' });
  const errorCampos = validarCamposCaja({ fecha, tipo, monto, metodo });
  if (errorCampos) return res.status(400).json({ error: errorCampos });
  // Guarda de idempotencia: una misma alta reintentada (doble clic / reenvío)
  // devuelve la entrada ya creada en lugar de duplicarla.
  if (idempotency_key) {
    const existente = await CajaMovimiento.findOne({ idempotency_key: String(idempotency_key) }).lean();
    if (existente) {
      logger.warn({ idempotency_key, caja_id: existente._id }, 'Alta de caja duplicada evitada (idempotency_key)');
      return res.json(withId(existente));
    }
  }
  const id = await Counter.next('caja');
  const confirmar = tipo === 'gasto'
    ? (confirmado !== undefined ? confirmado : false)
    : null;
  try {
    const mov = await CajaMovimiento.create({
      _id: id, fecha, tipo, concepto,
      monto: Number(monto),
      // Sólo aplica default si el cliente no mandó el campo; null explícito significa "sin definir".
      metodo: metodo === undefined ? 'efectivo' : metodo,
      subrubro_id: subrubro_id || null,
      movimiento_id: movimiento_id || null,
      confirmado: confirmar,
      es_especial: !!es_especial,
      idempotency_key: idempotency_key ? String(idempotency_key) : null,
      created_at: now(),
    });
    res.json(withId(mov.toObject()));
  } catch (err) {
    // Backstop de carrera ante el índice único.
    if (err.code === 11000 && idempotency_key) {
      const existente = await CajaMovimiento.findOne({ idempotency_key: String(idempotency_key) }).lean();
      if (existente) {
        logger.warn({ idempotency_key, caja_id: existente._id }, 'Alta de caja duplicada evitada por índice único (carrera)');
        return res.json(withId(existente));
      }
    }
    // La factura ya tiene su pendiente en la Caja (uno solo por factura): antes esto
    // devolvía un 500 con el mensaje interno de Mongo.
    if (err.code === 11000 && err.keyPattern?.movimiento_id) {
      return res.status(409).json({ error: 'Esa factura ya tiene un pago pendiente en la Caja: confirmalo (o pagá una parte) desde ahí' });
    }
    throw err;
  }
}));

// POST /api/caja/:id/confirmar   body: { descuento?: number, fecha?: 'YYYY-MM-DD' }
//
// Confirma un ítem de Caja como pagado/cobrado en UNA sola operación del servidor:
// registra el pago (o abono) en el subrubro de origen y, si se aplicó un descuento
// por pago, genera además la Nota de Crédito que lo respalda. Antes esto lo
// orquestaba el frontend con dos llamadas sueltas; centralizarlo acá es lo que
// permite que el pago y su NC no puedan quedar desparejos, y que la auditoría
// registre la operación completa (incluido quién descontó y cuánto).
//
// Semántica del descuento: el ítem de Caja pasa a valer el NETO efectivamente
// pagado (lo que sale de la caja), y el descuento se refleja en el subrubro como
// una NC vinculada a la factura. Saldo factura = monto − pago neto − NC = 0.
router.post('/:id/confirmar', requireAdmin, audit('caja'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const item = await CajaMovimiento.findById(id).lean();
  if (!item) return res.status(404).json({ error: 'Movimiento de caja no encontrado' });
  if (item.confirmado === true) return res.status(409).json({ error: 'El movimiento ya está confirmado' });
  if (!item.metodo) return res.status(400).json({ error: 'Definí el método de pago antes de confirmar' });

  // La fecha del pago la fija el servidor con el día de hoy en Argentina. Antes caía
  // en la fecha del ítem (su vencimiento) o en la que mandara el cliente, que es el
  // día que se estaba MIRANDO en la Caja: un pendiente arrastrado se confirmaba
  // desde mañana y el pago quedaba registrado mañana. Se admite una fecha pasada
  // (el front pide confirmación antes de mandarla), nunca una futura.
  const hoy = hoyLocal();
  const fecha = req.body.fecha || hoy;
  if (!esFechaValida(fecha)) return res.status(400).json({ error: 'Fecha de pago inválida' });
  if (fecha > hoy) {
    return res.status(400).json({ error: `No se puede confirmar un pago en una fecha futura (${fecha}). Hoy es ${hoy}.` });
  }
  // El bruto es el monto que la Caja muestra hoy; si por un reintento el ítem ya
  // tuviera monto_bruto, ese manda (no se descuenta dos veces sobre el neto).
  const bruto = Number(item.monto_bruto ?? item.monto) || 0;

  // Un pendiente auto-sync puede estar desactualizado: la Caja se muestra antes de
  // que termine el auto-sync, y la factura pudo pagarse, borrarse o cambiar de saldo
  // desde el Subrubro u otra pestaña. Confirmarlo así registraría un pago de más.
  if (item.auto_sync && item.movimiento_id != null) {
    const saldo = await db.saldoFactura(item.movimiento_id);
    if (saldo == null) {
      return res.status(409).json({ error: 'La factura de este vencimiento ya no existe. Refrescá la Caja.' });
    }
    if (saldo <= 0.005) {
      return res.status(409).json({ error: 'La factura de este vencimiento ya está saldada. Refrescá la Caja.' });
    }
    if (bruto > saldo + 0.005) {
      return res.status(409).json({ error: `El saldo de la factura cambió a $${saldo.toFixed(2)}. Refrescá la Caja.` });
    }
  }

  const sub = item.subrubro_id ? await Subrubro.findById(Number(item.subrubro_id)).lean() : null;

  // El descuento se puede cargar como monto fijo o como porcentaje. El % se resuelve
  // a pesos ACÁ (no en el cliente) para que el importe que termina en la NC sea el que
  // el servidor calculó, con un único criterio de redondeo a centavos.
  const pct = req.body.descuento_pct != null && req.body.descuento_pct !== ''
    ? Number(req.body.descuento_pct)
    : null;
  if (pct != null && (!Number.isFinite(pct) || pct <= 0 || pct >= 100)) {
    return res.status(400).json({ error: 'El porcentaje de descuento debe estar entre 0 y 100' });
  }
  const descuento = pct != null
    ? Math.round(bruto * (pct / 100) * 100) / 100
    : Number(req.body.descuento) || 0;

  if (descuento) {
    if (!sub?.aplica_descuento) return res.status(400).json({ error: 'El subrubro no admite descuentos por pago' });
    if (!item.movimiento_id)   return res.status(400).json({ error: 'Solo se puede descontar sobre un pago vinculado a una factura' });
    if (descuento < 0)         return res.status(400).json({ error: 'El descuento no puede ser negativo' });
    if (descuento >= bruto)    return res.status(400).json({ error: 'El descuento no puede ser mayor o igual al monto de la factura' });
  }

  // Pago parcial: `monto` = lo que se paga ahora, menor al saldo que muestra la Caja.
  // El resto queda como un pendiente nuevo de la misma factura (ver más abajo). Antes
  // esto se hacía editando el monto del ítem, y el saldo restante no volvía a
  // aparecer nunca en la Caja.
  const montoPedido = req.body.monto != null && req.body.monto !== '' ? Number(req.body.monto) : null;
  let parcial = false;
  if (montoPedido != null) {
    if (!Number.isFinite(montoPedido) || montoPedido <= 0) {
      return res.status(400).json({ error: 'El monto a pagar debe ser mayor a 0' });
    }
    if (montoPedido > bruto + 0.005) {
      return res.status(400).json({ error: `El monto a pagar no puede superar el saldo pendiente ($${bruto.toFixed(2)})` });
    }
    parcial = montoPedido < bruto - 0.005;
    if (parcial && item.movimiento_id == null) {
      return res.status(400).json({ error: 'El pago parcial es solo para ítems vinculados a una factura' });
    }
    if (parcial && descuento) {
      return res.status(400).json({ error: 'El descuento por pago se aplica pagando el total, no en un pago parcial' });
    }
  }
  const neto = parcial ? Math.round(montoPedido * 100) / 100 : bruto - descuento;

  const esCobro = item.tipo === 'ingreso_extra';
  let pagoId = null;
  let ncId = null;

  // Reserva ATÓMICA antes de tocar el subrubro. Registrar el pago marca la factura
  // como pagada, y el reconciliador del auto-sync borra los ítems pendientes cuya
  // factura ya está paga: si el ítem seguía en `confirmado: false` durante ese lapso,
  // un auto-sync concurrente (otra pestaña, otro usuario, el refresco por foco) lo
  // borraba y el pago quedaba huérfano, invisible para la Caja.
  // El filtro `$ne: true` cubre también los registros legacy con confirmado null.
  const claim = await CajaMovimiento.findOneAndUpdate(
    { _id: id, confirmado: { $ne: true } },
    { $set: { confirmado: true, fecha } },
  );
  if (!claim) return res.status(409).json({ error: 'El movimiento ya está confirmado' });

  try {
    if (item.subrubro_id) {
      // NC primero: si fallara, todavía no se registró el pago y el ítem vuelve atrás
      // en un estado reintentable. Al revés dejaría un pago sin su NC.
      if (descuento) {
        const nc = await db.createMovimiento(item.subrubro_id, {
          tipo: 'nota_credito',
          pago: descuento,
          fecha,
          concepto: `Descuento por pago${pct != null ? ` (${pct}%)` : ''}: ${item.concepto}`,
          facturas_vinculadas_ids: [Number(item.movimiento_id)],
          caja_mov_id: id,
          // Determinística: una entrada de caja genera como mucho UNA NC de descuento.
          idempotency_key: `caja-descuento-${id}`,
        });
        ncId = nc?.id ?? null;
      }
      const pago = await db.createMovimiento(item.subrubro_id, {
        tipo: 'pago',
        pago: neto,
        fecha,
        concepto: `${esCobro ? 'Abono caja' : 'Pago caja'}: ${item.concepto}`,
        metodo_pago: item.metodo,
        caja_mov_id: id,
        facturas_vinculadas_ids: item.movimiento_id ? [Number(item.movimiento_id)] : [],
        idempotency_key: `caja-confirm-${id}`,
      });
      pagoId = pago?.id ?? null;
    }
  } catch (err) {
    // Si la NC llegó a crearse pero el pago no, se borra: una NC sin su pago dejaba
    // la factura con menos saldo aunque la confirmación se hubiera caído.
    if (ncId != null) {
      try { await db.deleteMovimiento(ncId); }
      catch (e) { logger.error({ err: e.message, nc_mov_id: ncId, caja_id: id }, 'No se pudo borrar la NC de una confirmación fallida'); }
    }
    // Devolver el ítem a como estaba: si el pago no se registró, la Caja no puede
    // quedar diciendo que sí. Las idempotency_key liberadas permiten reintentar.
    await CajaMovimiento.updateOne(
      { _id: id },
      { $set: { confirmado: item.confirmado ?? null, fecha: item.fecha, nc_mov_id: null } },
    );
    throw err;
  }

  await CajaMovimiento.findByIdAndUpdate(id, {
    $set: {
      monto: neto,
      descuento,
      descuento_pct: descuento ? pct : null,
      monto_bruto: descuento ? bruto : null,
      pago_mov_id: pagoId,
      nc_mov_id: ncId,
    },
  });

  // Pago parcial: el resto de la factura queda como un pendiente nuevo, con los
  // mismos datos del ítem y su fecha original (sigue arrastrándose hasta pagarse).
  // Upsert contra el pendiente único de la factura por si el auto-sync ya lo creó.
  let pendienteRestante = null;
  if (parcial) {
    const saldo = await db.saldoFactura(item.movimiento_id);
    if (saldo != null && saldo > 0.005) {
      const nuevoId = await Counter.next('caja');
      try {
        await CajaMovimiento.updateOne(
          { movimiento_id: Number(item.movimiento_id), confirmado: false },
          {
            $set: { monto: saldo },
            $setOnInsert: {
              _id: nuevoId, fecha: item.fecha, tipo: item.tipo, concepto: item.concepto,
              metodo: item.metodo, subrubro_id: item.subrubro_id, movimiento_id: Number(item.movimiento_id),
              auto_sync: !!item.auto_sync, es_especial: false, created_at: now(),
            },
          },
          { upsert: true },
        );
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
      pendienteRestante = saldo;
    }
  }

  // Enriquece el diff de auditoría: deja explícito el descuento aplicado y la NC
  // generada, que es información que no se deduce del body de la request.
  res.json({ ok: true, id, monto: neto, monto_bruto: bruto, descuento, descuento_pct: pct, pago_mov_id: pagoId, nc_mov_id: ncId, parcial, pendiente_restante: pendienteRestante });
}));

// POST /api/caja/:id/revertir
// Deshace una confirmación: borra el pago y la NC de descuento generados en el
// subrubro y devuelve el ítem de Caja a su monto bruto, sin descuento.
router.post('/:id/revertir', requireAdmin, audit('caja'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const item = await CajaMovimiento.findById(id).lean();
  if (!item) return res.status(404).json({ error: 'Movimiento de caja no encontrado' });

  if (item.confirmado !== true) return res.status(409).json({ error: 'El movimiento no está confirmado' });

  // Borrar el pago y la NC es lo que libera sus idempotency_key, de modo que el
  // ítem pueda volver a confirmarse después. Borrar el pago ya borra su NC y reabre
  // el ítem (db.deleteMovimiento → reabrirItemCaja). Si algo falla, el error sube:
  // antes se tragaba y el ítem volvía a pendiente con el pago todavía vivo, y el
  // siguiente "confirmar" creaba un segundo pago.
  if (item.pago_mov_id != null) {
    await db.deleteMovimiento(item.pago_mov_id);
  } else {
    if (item.nc_mov_id != null) await db.deleteMovimiento(item.nc_mov_id);
  }
  const reabierto = await db.reabrirItemCaja(id);
  res.json({ ok: true, id, item: reabierto ? withId(reabierto) : null });
}));

// GET /api/caja/:id/boleta
// Datos de la factura/remito detrás de un ítem pendiente, para editarla desde la
// Caja sin ir al subrubro.
router.get('/:id/boleta', asyncHandler(async (req, res) => {
  const item = await CajaMovimiento.findById(Number(req.params.id)).lean();
  if (!item?.movimiento_id) return res.status(404).json({ error: 'El ítem no está vinculado a una factura' });
  const fac = await Movimiento.findById(Number(item.movimiento_id)).lean();
  if (!fac || fac.tipo !== 'factura') return res.status(404).json({ error: 'Factura no encontrada' });
  const saldo = await db.saldoFactura(fac._id);
  res.json({
    id: fac._id, monto: fac.monto, saldo, pagado: Math.round(((fac.monto || 0) - saldo) * 100) / 100,
    percepcion_iva: fac.percepcion_iva || 0, ingresos_brutos: fac.ingresos_brutos || 0,
    documento: fac.documento, fecha: fac.fecha, fecha_vencimiento: fac.fecha_vencimiento, concepto: fac.concepto || '',
  });
}));

// PUT /api/caja/:id/boleta   body: { monto, percepcion_iva?, ingresos_brutos? }
// Corrige la factura/remito de un ítem pendiente desde la Caja ("anoté 10 pero la
// boleta era de 11"). Se guarda en la FACTURA (la fuente de verdad) y el ítem pasa a
// valer el saldo nuevo: así la corrección nunca desincroniza Caja y subrubro.
router.put('/:id/boleta', requireAdmin, audit('caja_boleta'), asyncHandler(async (req, res) => {
  const item = await CajaMovimiento.findById(Number(req.params.id)).lean();
  if (!item?.movimiento_id) return res.status(400).json({ error: 'El ítem no está vinculado a una factura' });
  if (item.confirmado !== false) return res.status(400).json({ error: 'Solo se puede editar la boleta de un ítem pendiente' });
  const fac = await Movimiento.findById(Number(item.movimiento_id)).lean();
  if (!fac || fac.tipo !== 'factura') return res.status(404).json({ error: 'Factura no encontrada' });

  const num = (v, def) => (v === undefined || v === null || v === '' ? def : Number(v));
  const monto = num(req.body.monto, fac.monto);
  const percepcion_iva = num(req.body.percepcion_iva, fac.percepcion_iva || 0);
  const ingresos_brutos = num(req.body.ingresos_brutos, fac.ingresos_brutos || 0);
  if (!Number.isFinite(monto) || monto <= 0) return res.status(400).json({ error: 'El monto de la boleta debe ser mayor a 0' });
  if (![percepcion_iva, ingresos_brutos].every(n => Number.isFinite(n) && n >= 0)) {
    return res.status(400).json({ error: 'Las percepciones no pueden ser negativas' });
  }

  // updateMovimiento pisa todos los campos que recibe: se le pasan los actuales de
  // la factura y solo cambian monto y percepciones. Él mismo re-sincroniza el gasto
  // de Caja si es un remito.
  const factura = await db.updateMovimiento(fac._id, {
    monto, pago: fac.pago || 0, fecha: fac.fecha, fecha_vencimiento: fac.fecha_vencimiento,
    campos_extra: fac.campos_extra || {}, tipo: fac.tipo, concepto: fac.concepto || '',
    metodo_pago: fac.metodo_pago ?? null, documento: fac.documento ?? undefined,
    percepcion_iva, ingresos_brutos,
  });

  // El pendiente pasa a valer el saldo nuevo; si la corrección dejó la factura
  // saldada (boleta menor a lo ya pagado), el pendiente sobra.
  const saldo = await db.saldoFactura(fac._id);
  if (saldo != null && saldo > 0.005) {
    await CajaMovimiento.updateOne({ _id: item._id, confirmado: false }, { $set: { monto: saldo } });
  } else {
    await CajaMovimiento.deleteOne({ _id: item._id, confirmado: false });
  }
  const actualizado = await CajaMovimiento.findById(item._id).lean();
  res.json({ ok: true, factura, saldo, item: actualizado ? withId(actualizado) : null });
}));

// PUT /api/caja/:id
router.put('/:id', requireAdmin, audit('caja'), asyncHandler(async (req, res) => {
  const { fecha, tipo, concepto, monto, metodo, subrubro_id, es_especial, confirmado, pago_mov_id } = req.body;
  const actual = await CajaMovimiento.findById(Number(req.params.id)).lean();
  if (!actual) return res.status(404).json({ error: 'Movimiento de caja no encontrado' });

  // Validación anti-desincronización. Un ítem vinculado a una factura o a un pago
  // del subrubro representa un dato que vive en DOS lugares; cambiarlo acá sin tocar
  // el otro lado es lo que dejó 14 pares distintos en producción. Solo se rechazan
  // cambios reales (el formulario de edición manda todos los campos).
  const cambiaMonto = monto !== undefined && Math.abs((Number(monto) || 0) - (actual.monto || 0)) > 0.005;
  const cambiaFecha = fecha !== undefined && fecha !== actual.fecha;
  const cambiaTipo = tipo !== undefined && tipo !== actual.tipo;
  const conFactura = actual.movimiento_id != null;
  const conPago = actual.pago_mov_id != null || actual.origen === 'subrubro';
  if ((confirmado !== undefined && (confirmado ?? null) !== (actual.confirmado ?? null)) ||
      (pago_mov_id !== undefined && (pago_mov_id ?? null) !== (actual.pago_mov_id ?? null))) {
    return res.status(400).json({ error: 'Para confirmar o revertir un pago usá el botón ✓ (confirmar / revertir)' });
  }
  if (actual.origen === 'subrubro' && (cambiaMonto || cambiaFecha || cambiaTipo)) {
    return res.status(400).json({ error: 'Este pago se cargó en el subrubro: editalo desde ahí' });
  }
  if (actual.confirmado === true && conPago && (cambiaMonto || cambiaFecha || cambiaTipo)) {
    return res.status(400).json({ error: 'El pago ya está confirmado: revertí la confirmación para cambiar monto, fecha o tipo' });
  }
  if (actual.confirmado === false && conFactura && cambiaMonto) {
    return res.status(400).json({ error: 'Para pagar una parte usá "Pago parcial"; para corregir el importe, "Editar boleta"' });
  }
  if (conFactura && cambiaTipo) {
    return res.status(400).json({ error: 'No se puede cambiar el tipo de un ítem vinculado a una factura' });
  }
  const errorCampos = validarCamposCaja({ fecha, tipo, monto, metodo }, actual.tipo);
  if (errorCampos) return res.status(400).json({ error: errorCampos });

  const upd = {};
  if (fecha !== undefined) upd.fecha = fecha;
  if (tipo !== undefined) upd.tipo = tipo;
  if (concepto !== undefined) upd.concepto = concepto;
  if (monto !== undefined) upd.monto = Number(monto);
  if (metodo !== undefined) upd.metodo = metodo;
  if (subrubro_id !== undefined) upd.subrubro_id = subrubro_id;
  if (es_especial !== undefined) upd.es_especial = !!es_especial;
  await CajaMovimiento.findByIdAndUpdate(Number(req.params.id), upd);
  // Sync inverso del método (Caja → subrubro): si se cambió el método de un ítem
  // pendiente que representa una factura por vencer, se escribe también en la factura
  // para que ambos lados queden consistentes. No toca remitos (siempre efectivo) ni
  // ítems ya confirmados.
  if (metodo !== undefined) {
    const item = await CajaMovimiento.findById(Number(req.params.id)).lean();
    if (item?.movimiento_id && item.confirmado === false) {
      const fac = await Movimiento.findById(Number(item.movimiento_id));
      if (fac && fac.tipo === 'factura' && fac.documento !== 'remito' && (fac.metodo_pago || null) !== (metodo || null)) {
        fac.metodo_pago = metodo || null;
        await fac.save();
      }
    }
  }
  res.json({ ok: true });
}));

// DELETE /api/caja/:id?fecha=YYYY-MM-DD
router.delete('/:id', requireAdmin, audit('caja'), asyncHandler(async (req, res) => {
  const item = await CajaMovimiento.findById(Number(req.params.id)).lean();
  // Sólo los pendientes auto-generados (movimiento_id + no confirmados) dejan
  // "memoria" de descarte: si el usuario borra el vencimiento hoy, no debe volver a
  // recrearse hoy vía auto-sync. Se registra contra la fecha VISTA en la Caja (no la
  // del ítem, que vive en fecha_vencimiento y el GET arrastra hacia adelante).
  if (item?.movimiento_id && item.confirmado === false) {
    const fecha = req.query.fecha || item.fecha;
    await CajaDescarte.updateOne(
      { movimiento_id: item.movimiento_id, fecha },
      { $setOnInsert: { movimiento_id: item.movimiento_id, fecha, created_at: now() } },
      { upsert: true }
    );
  }
  await CajaMovimiento.findByIdAndDelete(Number(req.params.id));
  res.json({ ok: true });
}));

module.exports = router;
