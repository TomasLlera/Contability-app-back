const { Counter, Local, Rubro, Subrubro, Movimiento, Campo, Categoria, ImportConfig, AppConfig, CajaMovimiento } = require('./models');
const logger = require('./logger');

// Busca un movimiento ya creado con esta idempotency_key. Se usa como guarda de
// duplicados: si la misma alta se reintenta (doble clic, reenvío de red, doble
// disparo de efectos en React), devolvemos el existente en lugar de crear otro.
async function findMovByIdemKey(key) {
  if (!key) return null;
  return Movimiento.findOne({ idempotency_key: String(key) }).lean();
}

function now() {
  return new Date().toLocaleString('sv').replace('T', ' ');
}

function hoy() {
  return new Date().toISOString().split('T')[0];
}

// Mes anterior a `mes` (YYYY-MM) → YYYY-MM.
function prevMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m - 2, 1); // m-2: mes es 1-based, JS 0-based, y -1 al anterior
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Extrae un número de factura/comprobante de los campos_extra, sin importar cómo
// se haya llamado la columna mapeada ("Facturas", "Comprobante", "Nº", etc.).
function extraerNroFactura(campos_extra) {
  if (!campos_extra) return null;
  for (const [k, v] of Object.entries(campos_extra)) {
    if (/factura|comprobante|nro|n°|numero|número/i.test(k) && v != null && String(v).trim() !== '') {
      return String(v).trim();
    }
  }
  return null;
}

function validarFecha(fecha) {
  if (fecha && fecha > hoy()) throw new Error(`La fecha ${fecha} no puede ser posterior a hoy`);
}

// Normaliza el método de pago a 'efectivo' | 'transferencia' | null.
function normalizarMetodoPago(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'efectivo' || s === 'transferencia') return s;
  throw new Error(`metodo_pago inválido: ${v}`);
}

// Dada una fecha 'YYYY-MM-DD' y un plazo en días (N), devuelve la fecha + N días.
// El campo `dia_vencimiento` del subrubro representa la cantidad de días que
// transcurren desde la fecha de la factura hasta su vencimiento.
function calcularProximoVencimiento(fechaStr, dias) {
  const d = Number(dias);
  if (!d) return null;
  const date = new Date(fechaStr + 'T00:00:00');
  date.setDate(date.getDate() + d);
  return date.toISOString().split('T')[0];
}

// Dada una fecha 'YYYY-MM-DD' y un día de la semana objetivo (0=domingo … 6=sábado),
// devuelve la fecha del PRÓXIMO día de la semana indicado. Si la emisión cae justo en
// ese día, salta a la semana siguiente (nunca el mismo día de emisión).
function calcularProximoDiaSemana(fechaStr, diaSemana) {
  const target = Number(diaSemana);
  if (!Number.isInteger(target) || target < 0 || target > 6) return null;
  const date = new Date(fechaStr + 'T00:00:00');
  const actual = date.getDay();
  const diff = ((target - actual + 6) % 7) + 1; // siempre 1..7 → nunca el mismo día
  date.setDate(date.getDate() + diff);
  return date.toISOString().split('T')[0];
}

// Dada una fecha 'YYYY-MM-DD' y un día del mes objetivo (1..31), devuelve la fecha
// de vencimiento en ese día fijo del mes:
//   • si el día todavía no pasó en el mes de emisión (día objetivo >= día de emisión)
//     → vence ese día del mes de emisión (incluye el mismo día de emisión);
//   • si ya pasó (día objetivo < día de emisión) → vence ese día del mes siguiente.
// Si el mes destino no tiene ese día (p. ej. 31 en un mes de 30, o 30/31 en febrero),
// se ajusta al ÚLTIMO día de ese mes (28/29-feb, 30-abr, etc.).
function calcularProximoDiaMes(fechaStr, diaMes) {
  const target = Number(diaMes);
  if (!Number.isInteger(target) || target < 1 || target > 31) return null;
  const date = new Date(fechaStr + 'T00:00:00');
  const emisionDia = date.getDate();
  let anio = date.getFullYear();
  let mes = date.getMonth(); // 0-based
  // Si el día objetivo ya pasó este mes, saltar al mes siguiente.
  if (target < emisionDia) {
    mes += 1;
    if (mes > 11) { mes = 0; anio += 1; }
  }
  // Último día del mes destino: día 0 del mes siguiente.
  const ultimoDia = new Date(anio, mes + 1, 0).getDate();
  const dia = Math.min(target, ultimoDia);
  return `${anio}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// Calcula el vencimiento de una factura según el modo configurado en el subrubro.
// 'dia_semana' usa `dia_semana_vencimiento`; 'dia_mes' usa `dia_mes_vencimiento`;
// cualquier otro valor (incluyendo el default/legacy 'dias' o ausente) usa
// `dia_vencimiento` (N días desde la emisión).
function calcularVencimientoSub(fechaStr, sub) {
  if (!fechaStr || !sub) return null;
  if (sub.modo_vencimiento === 'dia_semana') {
    if (sub.dia_semana_vencimiento == null) return null;
    return calcularProximoDiaSemana(fechaStr, sub.dia_semana_vencimiento);
  }
  if (sub.modo_vencimiento === 'dia_mes') {
    if (sub.dia_mes_vencimiento == null) return null;
    return calcularProximoDiaMes(fechaStr, sub.dia_mes_vencimiento);
  }
  if (!sub.dia_vencimiento) return null;
  return calcularProximoVencimiento(fechaStr, sub.dia_vencimiento);
}

// Recalcula fecha_vencimiento de TODAS las facturas pendientes (impagas, con fecha)
// de un subrubro según su config de vencimiento actual. Se usa al cambiar la config
// del subrubro para que las facturas ya cargadas reflejen la regla nueva.
// Devuelve la cantidad de facturas modificadas.
async function recomputarVencimientosSubrubro(subId) {
  const iid = Number(subId);
  const sub = await Subrubro.findById(iid).lean();
  if (!sub) return 0;
  const facturas = await Movimiento.find(
    { subrubro_id: iid, tipo: 'factura', pagado: { $ne: true }, fecha: { $exists: true, $ne: null, $ne: '' } },
    { _id: 1, fecha: 1, fecha_vencimiento: 1 }
  ).lean();

  const ops = [];
  for (const m of facturas) {
    const venc = calcularVencimientoSub(m.fecha, sub) || null;
    if ((m.fecha_vencimiento || null) === venc) continue; // sin cambios
    ops.push({ updateOne: { filter: { _id: m._id }, update: { $set: { fecha_vencimiento: venc } } } });
  }
  if (ops.length) await Movimiento.bulkWrite(ops, { ordered: false });
  return ops.length;
}

const withId = doc => doc ? { ...doc, id: doc._id } : doc;
const withIds = arr => arr.map(withId);

const r2 = (n) => Math.round((n || 0) * 100) / 100;

// Calcula el SALDO pendiente de cada factura del subrubro a partir de la lista
// completa de movimientos. Al monto original le resta, en este orden:
//   1) pagos / notas de crédito VINCULADOS explícitamente a esa factura, y
//   2) pagos "libres" (sin vinculación) aplicados FIFO por antigüedad.
// Una NC o un pago parcial dejan la factura con saldo > 0 (sigue pendiente por el
// resto); si lo aplicado cubre el total, el saldo queda en 0 (factura saldada).
// Devuelve un Map fid -> saldo (>= 0). No modifica el monto original.
function computeSaldosFacturas(movs) {
  const ordenadas = [...movs].sort((a, b) => {
    if (!a.fecha && !b.fecha) return a._id - b._id;
    if (!a.fecha) return 1;
    if (!b.fecha) return -1;
    return a.fecha.localeCompare(b.fecha) || a._id - b._id;
  });

  const saldo = new Map();
  for (const m of ordenadas) {
    if (m.tipo === 'factura') saldo.set(m._id, r2(m.monto));
  }

  // 1) Pagos / NC vinculados a facturas puntuales (respeta la elección manual).
  for (const m of ordenadas) {
    if ((m.tipo !== 'pago' && m.tipo !== 'nota_credito') || !m.facturas_vinculadas_ids?.length) continue;
    let restante = r2(m.pago);
    const vinc = new Set(m.facturas_vinculadas_ids.map(Number));
    for (const f of ordenadas) {
      if (restante <= 0) break;
      if (f.tipo !== 'factura' || !vinc.has(f._id)) continue;
      const s = saldo.get(f._id) || 0;
      const aplicar = Math.min(restante, s);
      saldo.set(f._id, r2(s - aplicar));
      restante = r2(restante - aplicar);
    }
  }

  // 2) Pagos libres (sin vinculación) → FIFO sobre las facturas con saldo.
  let libre = ordenadas
    .filter(m => (m.tipo === 'pago' || m.tipo === 'nota_credito') && !(m.facturas_vinculadas_ids?.length))
    .reduce((s, m) => s + (m.pago || 0), 0);
  libre = r2(libre);
  for (const m of ordenadas) {
    if (m.tipo !== 'factura' || libre <= 0) continue;
    const s = saldo.get(m._id) || 0;
    if (s <= 0) continue;
    const aplicar = Math.min(libre, s);
    saldo.set(m._id, r2(s - aplicar));
    libre = r2(libre - aplicar);
  }

  return saldo;
}

async function recalcularPagos(subrubroId) {
  const iid = Number(subrubroId);
  const movs = await Movimiento.find({ subrubro_id: iid }).lean();
  const saldo = computeSaldosFacturas(movs);

  // Una factura está saldada cuando su saldo llegó a 0 (con tolerancia de centavos).
  const bulkOps = [];
  for (const m of movs) {
    if (m.tipo !== 'factura') continue;
    bulkOps.push({
      updateOne: { filter: { _id: m._id }, update: { $set: { pagado: (saldo.get(m._id) || 0) <= 0.005 } } }
    });
  }
  if (bulkOps.length > 0) await Movimiento.bulkWrite(bulkOps);
}

// Valida que una nota de crédito vinculada no supere el saldo pendiente de las
// facturas a las que se aplica. `saldos` es el Map fid → saldo contra el que la
// NC va a aplicarse (un pago sí puede exceder: el excedente queda como crédito
// libre FIFO; una NC no — el proveedor no emite crédito por más de lo adeudado).
function validarSaldoNC(saldos, idsNum, montoNC) {
  const saldoVinc = r2(idsNum.reduce((s, fid) => s + (saldos.get(fid) || 0), 0));
  if (r2(Number(montoNC) || 0) > saldoVinc + 0.005) {
    const e = new Error(`La nota de crédito supera el saldo pendiente de la factura vinculada ($${saldoVinc.toFixed(2)})`);
    e.statusCode = 400;
    throw e;
  }
}

// Detalle de aplicación por factura vinculada: saldo anterior → monto aplicado →
// saldo posterior. Viaja en la respuesta del alta/edición del pago/NC, por lo que
// el middleware de auditoría lo persiste en `Audit.diff.response.aplicaciones`.
function armarAplicaciones(idsNum, saldosAntes, movsPost) {
  const saldosDespues = computeSaldosFacturas(movsPost);
  return idsNum.map(fid => {
    const antes = r2(saldosAntes.get(fid) || 0);
    const despues = r2(saldosDespues.get(fid) || 0);
    const fact = movsPost.find(m => m._id === fid);
    return {
      factura_id: fid,
      monto_original: fact?.monto ?? null,
      saldo_anterior: antes,
      aplicado: r2(antes - despues),
      saldo_posterior: despues,
      saldada: despues <= 0.005,
    };
  });
}

// Borra el gasto de Caja del Día de un remito (enlazado por movimiento_id) y, si
// llegó a confirmarse en Caja, también el pago que esa confirmación generó en el
// subrubro. El índice único sobre movimiento_id garantiza que hay a lo sumo un ítem,
// así que basta filtrar por movimiento_id.
async function borrarCajaRemito(movId) {
  const items = await CajaMovimiento.find({ movimiento_id: Number(movId) }).lean();
  for (const it of items) {
    if (it.pago_mov_id) await Movimiento.deleteOne({ _id: Number(it.pago_mov_id) });
  }
  await CajaMovimiento.deleteMany({ movimiento_id: Number(movId) });
}

// Sincroniza el ítem de Caja del Día que representa un remito. Un remito se paga en
// efectivo, así que su factura genera automáticamente un gasto en la Caja (efectivo)
// enlazado por movimiento_id, para que aparezca solo bajo la sección de Efectivo.
// El gasto se agenda en la FECHA DE VENCIMIENTO del remito (cuándo hay que pagarlo);
// si el remito no tiene vencimiento se cae a la fecha de emisión.
// El gasto queda SIN CONFIRMAR: aparece en la Caja pero no descuenta hasta que el
// usuario lo confirme con el ✓. Se marca auto_sync:false a propósito para quedar
// fuera del reconciliador de vencimientos (que si no le reescribiría el concepto).
//   • esRemito=true  → crea/actualiza el gasto (fecha, monto, concepto, efectivo).
//   • esRemito=false → borra el gasto auto-generado del remito (si lo había).
// El llamador solo invoca la rama de borrado cuando el movimiento ES o FUE un remito,
// para no tocar vencimientos auto-sync ni gastos manuales de una factura normal.
async function syncCajaRemito(mov, sub, esRemito) {
  const movId = Number(mov._id);
  if (!esRemito) {
    await borrarCajaRemito(movId);
    return;
  }
  // La Caja refleja el SALDO pendiente del remito (monto − pagos − NC vía FIFO),
  // NO el monto original. Requiere todos los movimientos del subrubro (pagos/NC
  // pueden estar en otro mes). Si el saldo quedó en 0 el remito está saldado y no
  // debe figurar como gasto pendiente: se borra el ítem sin confirmar (nunca uno
  // ya confirmado, que tiene su pago real enlazado).
  const movsSub = await Movimiento.find({ subrubro_id: Number(mov.subrubro_id) }).lean();
  const saldo = computeSaldosFacturas(movsSub).get(movId) ?? (Number(mov.monto) || 0);
  if (saldo <= 0.005) {
    await CajaMovimiento.deleteMany({ movimiento_id: movId, confirmado: false });
    return;
  }
  const set = {
    // El gasto va en la caja del día en que vence el remito, no en el de emisión.
    fecha: mov.fecha_vencimiento || mov.fecha,
    tipo: 'gasto',
    concepto: `Remito — ${sub?.nombre || 'Proveedor'}`,
    monto: saldo,
    metodo: 'efectivo',
    subrubro_id: Number(mov.subrubro_id),
    confirmado: false,
    auto_sync: false,
    es_especial: false,
  };
  // Upsert por movimiento_id (índice único parcial): si el remito ya tenía su gasto
  // lo actualiza; si no, lo crea reservando un _id nuevo. No se pisa `confirmado` si
  // el usuario ya lo confirmó a mano (solo se refresca fecha/monto/concepto).
  const existente = await CajaMovimiento.findOne({ movimiento_id: movId });
  if (existente) {
    const { confirmado, ...refresh } = set;
    await CajaMovimiento.updateOne({ _id: existente._id }, { $set: refresh });
  } else {
    const cajaId = await Counter.next('caja');
    try {
      await CajaMovimiento.create({ _id: cajaId, movimiento_id: movId, created_at: now(), ...set });
    } catch (err) {
      // Carrera contra el índice único (dos altas simultáneas): el ítem ya existe.
      if (err.code !== 11000) throw err;
    }
  }
}

// Espeja en la Caja del Día un pago registrado desde un Subrubro (sincronización
// Subrubro → Caja). Un pago del subrubro es una salida de caja real, así que se
// refleja como un gasto CONFIRMADO en la Caja, en la FECHA REAL del pago y con su
// método. Se enlaza por pago_mov_id + origen:'subrubro' para poder mantenerlo en
// sync (editar) o eliminarlo en espejo cuando el pago cambia o se borra.
//   • activo=true  → crea/actualiza el gasto espejo.
//   • activo=false → borra el gasto espejo (si lo había: p. ej. el pago dejó de serlo).
// NO se invoca para pagos que vinieron de la Caja (traen caja_mov_id): esos ya tienen
// su propio ítem en la Caja y crear otro los duplicaría.
async function syncCajaPago(pago, sub, activo) {
  const pagoId = Number(pago._id);
  if (!activo) {
    await CajaMovimiento.deleteMany({ pago_mov_id: pagoId, origen: 'subrubro' });
    return;
  }
  // En un subrubro de tipo DEUDA (dinero a cobrar) el "pago" es un ABONO recibido:
  // entra a la Caja como INGRESO (suma al saldo del día bajo su método), no como
  // gasto. Los ingresos no tienen ciclo de confirmación (confirmado null).
  const esDeuda = sub?.tipo_subrubro === 'deuda';
  const set = {
    // La fecha del gasto/ingreso en Caja es la fecha real del pago (no un vencimiento).
    fecha: pago.fecha,
    tipo: esDeuda ? 'ingreso_extra' : 'gasto',
    concepto: esDeuda ? `Abono — ${sub?.nombre || 'Deuda'}` : `Pago — ${sub?.nombre || 'Subrubro'}`,
    monto: Number(pago.pago) || 0,
    // Un pago sin método definido cae a 'efectivo' (misma convención que la Caja).
    metodo: pago.metodo_pago || 'efectivo',
    subrubro_id: Number(pago.subrubro_id),
    // Un pago concretado entra confirmado y descuenta; un ingreso no lleva confirmación.
    confirmado: esDeuda ? null : true,
    origen: 'subrubro',
    auto_sync: false,
    es_especial: false,
  };
  const existente = await CajaMovimiento.findOne({ pago_mov_id: pagoId, origen: 'subrubro' });
  if (existente) {
    await CajaMovimiento.updateOne({ _id: existente._id }, { $set: set });
  } else {
    const cajaId = await Counter.next('caja');
    try {
      await CajaMovimiento.create({
        _id: cajaId, pago_mov_id: pagoId, created_at: now(),
        // Clave determinística: un pago genera a lo sumo un ítem de caja espejo.
        idempotency_key: `pago-sync-${pagoId}`, ...set,
      });
    } catch (err) {
      // Carrera contra el índice único (idempotency_key): el ítem ya existe.
      if (err.code !== 11000) throw err;
    }
  }
}

const db = {
  // --- LOCALES ---
  async getLocales() {
    return withIds(await Local.find().sort({ nombre: 1 }).lean());
  },
  async createLocal(nombre, icon = '🏠') {
    const id = await Counter.next('locales');
    return withId((await Local.create({ _id: id, nombre, icon, created_at: now() })).toObject());
  },
  async updateLocal(id, nombre, icon) {
    const upd = {};
    if (nombre !== undefined) upd.nombre = nombre;
    if (icon !== undefined) upd.icon = icon;
    await Local.findByIdAndUpdate(Number(id), upd);
  },
  async deleteLocal(id) {
    const iid = Number(id);
    const rubros = await Rubro.find({ local_id: iid }, { _id: 1 }).lean();
    const rubroIds = rubros.map(r => r._id);
    const subs = await Subrubro.find({ rubro_id: { $in: rubroIds } }, { _id: 1 }).lean();
    const subIds = subs.map(s => s._id);
    await Movimiento.deleteMany({ subrubro_id: { $in: subIds } });
    await Subrubro.deleteMany({ rubro_id: { $in: rubroIds } });
    await Campo.deleteMany({ rubro_id: { $in: rubroIds } });
    await Categoria.deleteMany({ rubro_id: { $in: rubroIds } });
    await ImportConfig.deleteMany({ rubro_id: { $in: rubroIds } });
    await Rubro.deleteMany({ local_id: iid });
    await Local.findByIdAndDelete(iid);
  },

  // --- RUBROS ---
  async getRubros(localId) {
    const filter = localId !== undefined ? { local_id: Number(localId) } : {};
    return withIds(await Rubro.find(filter).sort({ nombre: 1 }).lean());
  },
  async createRubro(nombre, localId) {
    const existing = await Rubro.findOne({ local_id: Number(localId), nombre: { $regex: new RegExp(`^${nombre}$`, 'i') } });
    if (existing) throw new Error('El rubro ya existe en este local');
    const id = await Counter.next('rubros');
    return withId((await Rubro.create({ _id: id, nombre, local_id: Number(localId), created_at: now() })).toObject());
  },
  async updateRubro(id, nombre, icon) {
    const upd = {};
    if (nombre !== undefined) upd.nombre = nombre;
    if (icon !== undefined) upd.icon = icon;
    await Rubro.findByIdAndUpdate(Number(id), upd);
  },
  async deleteRubro(id) {
    const iid = Number(id);
    const subs = await Subrubro.find({ rubro_id: iid }, { _id: 1 }).lean();
    const subIds = subs.map(s => s._id);
    await Movimiento.deleteMany({ subrubro_id: { $in: subIds } });
    await Subrubro.deleteMany({ rubro_id: iid });
    await Campo.deleteMany({ rubro_id: iid });
    await Categoria.deleteMany({ rubro_id: iid });
    await ImportConfig.deleteMany({ rubro_id: iid });
    await Rubro.findByIdAndDelete(iid);
  },
  async getRubro(id) {
    return Rubro.findById(Number(id)).lean();
  },

  // --- IMPORT CONFIGS ---
  async getImportConfig(rubroId) {
    return ImportConfig.findOne({ rubro_id: Number(rubroId) }).lean();
  },
  async saveImportConfig(rubroId, mapping, mode) {
    const cfg = { rubro_id: Number(rubroId), mapping, mode, updated_at: now() };
    await ImportConfig.findOneAndUpdate({ rubro_id: Number(rubroId) }, cfg, { upsert: true });
    return cfg;
  },

  // --- CAMPOS ---
  async getCampos(rubroId) {
    return withIds(await Campo.find({ rubro_id: Number(rubroId) }).sort({ orden: 1 }).lean());
  },
  async createCampo(rubroId, nombre, tipo = 'texto', orden = 0) {
    const id = await Counter.next('campos_rubro');
    return withId((await Campo.create({ _id: id, rubro_id: Number(rubroId), nombre, tipo, orden: Number(orden) })).toObject());
  },
  async updateCampo(id, nombre, tipo, orden) {
    const upd = { nombre, tipo };
    if (orden !== undefined) upd.orden = Number(orden);
    await Campo.findByIdAndUpdate(Number(id), upd);
  },
  async deleteCampo(id) {
    await Campo.findByIdAndDelete(Number(id));
  },

  // --- CATEGORIAS ---
  async getCategorias(rubroId) {
    return withIds(await Categoria.find({ rubro_id: Number(rubroId) }).lean());
  },
  async createCategoria(rubroId, nombre, operacion, tipo_calculo = 'fijo', porcentaje_default = null) {
    const id = await Counter.next('categorias_movimiento');
    return withId((await Categoria.create({ _id: id, rubro_id: Number(rubroId), nombre, operacion, tipo_calculo, porcentaje_default: porcentaje_default ? Number(porcentaje_default) : null })).toObject());
  },
  async updateCategoria(id, nombre, operacion, tipo_calculo = 'fijo', porcentaje_default = null) {
    await Categoria.findByIdAndUpdate(Number(id), { nombre, operacion, tipo_calculo, porcentaje_default: porcentaje_default ? Number(porcentaje_default) : null });
  },
  async deleteCategoria(id) {
    await Categoria.findByIdAndDelete(Number(id));
  },

  // --- SUBRUBROS ---
  async getSubrubros(rubroId) {
    return withIds(await Subrubro.find({ rubro_id: Number(rubroId) }).sort({ nombre: 1 }).lean());
  },
  async createSubrubro(rubroId, nombre, montoBase = 0, extra = {}) {
    const id = await Counter.next('subrubros');
    const doc = {
      _id: id, rubro_id: Number(rubroId), nombre,
      monto_base: Number(montoBase), created_at: now(),
    };
    if (extra.cuit !== undefined) doc.cuit = String(extra.cuit || '').trim();
    if (extra.cbu !== undefined) doc.cbu = String(extra.cbu || '').trim();
    if (extra.alias !== undefined) doc.alias = String(extra.alias || '').trim();
    if (extra.razon_social !== undefined) doc.razon_social = String(extra.razon_social || '').trim();
    if (extra.notas !== undefined) doc.notas = String(extra.notas || '').trim();
    if (extra.dia_vencimiento !== undefined && extra.dia_vencimiento !== null && extra.dia_vencimiento !== '') {
      const d = Number(extra.dia_vencimiento);
      if (!Number.isInteger(d) || d < 1 || d > 365) throw new Error('dia_vencimiento debe ser un entero entre 1 y 365');
      doc.dia_vencimiento = d;
    }
    if (extra.modo_vencimiento !== undefined && extra.modo_vencimiento !== null && extra.modo_vencimiento !== '') {
      if (!['dias', 'dia_semana', 'dia_mes'].includes(extra.modo_vencimiento)) throw new Error("modo_vencimiento debe ser 'dias', 'dia_semana' o 'dia_mes'");
      doc.modo_vencimiento = extra.modo_vencimiento;
    }
    if (extra.dia_semana_vencimiento !== undefined && extra.dia_semana_vencimiento !== null && extra.dia_semana_vencimiento !== '') {
      const w = Number(extra.dia_semana_vencimiento);
      if (!Number.isInteger(w) || w < 0 || w > 6) throw new Error('dia_semana_vencimiento debe ser un entero entre 0 (domingo) y 6 (sábado)');
      doc.dia_semana_vencimiento = w;
    }
    if (extra.dia_mes_vencimiento !== undefined && extra.dia_mes_vencimiento !== null && extra.dia_mes_vencimiento !== '') {
      const dm = Number(extra.dia_mes_vencimiento);
      if (!Number.isInteger(dm) || dm < 1 || dm > 31) throw new Error('dia_mes_vencimiento debe ser un entero entre 1 y 31');
      doc.dia_mes_vencimiento = dm;
    }
    if (extra.metodo_pago_default !== undefined && extra.metodo_pago_default !== null && extra.metodo_pago_default !== '') {
      if (!['efectivo', 'transferencia', 'ambas'].includes(extra.metodo_pago_default)) throw new Error("metodo_pago_default debe ser 'efectivo', 'transferencia' o 'ambas'");
      doc.metodo_pago_default = extra.metodo_pago_default;
    }
    if (extra.tipo_subrubro !== undefined && extra.tipo_subrubro !== null && extra.tipo_subrubro !== '') {
      if (!['factura', 'deuda'].includes(extra.tipo_subrubro)) throw new Error("tipo_subrubro debe ser 'factura' o 'deuda'");
      doc.tipo_subrubro = extra.tipo_subrubro;
    }
    // El descuento por pago no aplica a las deudas a cobrar: se fuerza false.
    if (extra.aplica_descuento !== undefined) {
      doc.aplica_descuento = doc.tipo_subrubro === 'deuda' ? false : Boolean(extra.aplica_descuento);
    }
    return withId((await Subrubro.create(doc)).toObject());
  },
  async updateSubrubro(id, fields = {}) {
    const upd = {};
    if (fields.nombre !== undefined) upd.nombre = fields.nombre;
    if (fields.monto_base !== undefined) upd.monto_base = Number(fields.monto_base);
    if (fields.icon !== undefined) upd.icon = fields.icon;
    if (fields.cuit !== undefined) upd.cuit = String(fields.cuit || '').trim();
    if (fields.cbu !== undefined) upd.cbu = String(fields.cbu || '').trim();
    if (fields.alias !== undefined) upd.alias = String(fields.alias || '').trim();
    if (fields.razon_social !== undefined) upd.razon_social = String(fields.razon_social || '').trim();
    if (fields.notas !== undefined) upd.notas = String(fields.notas || '').trim();
    if (fields.dia_vencimiento !== undefined) {
      if (fields.dia_vencimiento === null || fields.dia_vencimiento === '') {
        upd.dia_vencimiento = null;
      } else {
        const d = Number(fields.dia_vencimiento);
        if (!Number.isInteger(d) || d < 1 || d > 365) throw new Error('dia_vencimiento debe ser un entero entre 1 y 365');
        upd.dia_vencimiento = d;
      }
    }
    if (fields.modo_vencimiento !== undefined) {
      const m = fields.modo_vencimiento || 'dias';
      if (!['dias', 'dia_semana', 'dia_mes'].includes(m)) throw new Error("modo_vencimiento debe ser 'dias', 'dia_semana' o 'dia_mes'");
      upd.modo_vencimiento = m;
    }
    if (fields.dia_semana_vencimiento !== undefined) {
      if (fields.dia_semana_vencimiento === null || fields.dia_semana_vencimiento === '') {
        upd.dia_semana_vencimiento = null;
      } else {
        const w = Number(fields.dia_semana_vencimiento);
        if (!Number.isInteger(w) || w < 0 || w > 6) throw new Error('dia_semana_vencimiento debe ser un entero entre 0 (domingo) y 6 (sábado)');
        upd.dia_semana_vencimiento = w;
      }
    }
    if (fields.dia_mes_vencimiento !== undefined) {
      if (fields.dia_mes_vencimiento === null || fields.dia_mes_vencimiento === '') {
        upd.dia_mes_vencimiento = null;
      } else {
        const dm = Number(fields.dia_mes_vencimiento);
        if (!Number.isInteger(dm) || dm < 1 || dm > 31) throw new Error('dia_mes_vencimiento debe ser un entero entre 1 y 31');
        upd.dia_mes_vencimiento = dm;
      }
    }
    if (fields.metodo_pago_default !== undefined) {
      const mp = fields.metodo_pago_default || 'ambas';
      if (!['efectivo', 'transferencia', 'ambas'].includes(mp)) throw new Error("metodo_pago_default debe ser 'efectivo', 'transferencia' o 'ambas'");
      upd.metodo_pago_default = mp;
    }
    if (fields.tipo_subrubro !== undefined) {
      const ts = fields.tipo_subrubro || 'factura';
      if (!['factura', 'deuda'].includes(ts)) throw new Error("tipo_subrubro debe ser 'factura' o 'deuda'");
      upd.tipo_subrubro = ts;
    }
    if (fields.aplica_descuento !== undefined) upd.aplica_descuento = Boolean(fields.aplica_descuento);
    // Una deuda a cobrar nunca lleva descuento por pago: si el subrubro pasa a 'deuda'
    // (ahora o ya lo era y no se está cambiando), el flag se apaga.
    if (upd.tipo_subrubro === 'deuda') upd.aplica_descuento = false;
    await Subrubro.findByIdAndUpdate(Number(id), upd);
    // Si se fijó un método de pago ('efectivo'/'transferencia'), aplicarlo a TODOS los
    // pagos existentes del subrubro (el método del subrubro manda). Con 'ambas' no se toca nada.
    if (upd.metodo_pago_default === 'efectivo' || upd.metodo_pago_default === 'transferencia') {
      await Movimiento.updateMany(
        { subrubro_id: Number(id), tipo: 'pago', metodo_pago: { $ne: upd.metodo_pago_default } },
        { $set: { metodo_pago: upd.metodo_pago_default } }
      );
    }
    // Si cambió algún campo de vencimiento, regenerar el vencimiento de las facturas
    // pendientes del subrubro para que reflejen la regla nueva (la regla del subrubro manda).
    const cambioVenc = ['modo_vencimiento', 'dia_vencimiento', 'dia_semana_vencimiento', 'dia_mes_vencimiento']
      .some(k => fields[k] !== undefined);
    if (cambioVenc) await recomputarVencimientosSubrubro(Number(id));
    // Si cambió el tipo de subrubro, re-espejar en Caja todos los pagos existentes
    // (no originados en la Caja): un abono de deuda es un INGRESO, un pago de
    // proveedor es un gasto. El espejo viejo con el signo equivocado se reescribe.
    if (upd.tipo_subrubro !== undefined) {
      const iid = Number(id);
      const subNuevo = await Subrubro.findById(iid).lean();
      const pagos = await Movimiento.find({ subrubro_id: iid, tipo: 'pago', caja_mov_id: null }).lean();
      for (const p of pagos) await syncCajaPago(p, subNuevo, true);
      // Conversión a DEUDA: limpiar la "memoria" de proveedor que quedó en Caja.
      //   • Los remitos dejan de serlo (una deuda a cobrar nunca es un remito) y
      //   • los GASTOS sin confirmar que apuntaban a facturas de este subrubro
      //     (remitos + vencimientos auto-sync) se borran: el próximo auto-sync los
      //     recrea con el signo correcto (ingreso pendiente de cobro).
      if (upd.tipo_subrubro === 'deuda') {
        await Movimiento.updateMany(
          { subrubro_id: iid, tipo: 'factura', documento: 'remito' },
          { $set: { documento: 'factura' } }
        );
        const factIds = (await Movimiento.find({ subrubro_id: iid, tipo: 'factura' }, { _id: 1 }).lean()).map(m => m._id);
        if (factIds.length) {
          await CajaMovimiento.deleteMany({ movimiento_id: { $in: factIds }, tipo: 'gasto', confirmado: false });
        }
      }
    }
  },
  async deleteSubrubro(id) {
    const iid = Number(id);
    await Movimiento.deleteMany({ subrubro_id: iid });
    await Subrubro.findByIdAndDelete(iid);
  },
  async getSubrubro(id) {
    return Subrubro.findById(Number(id)).lean();
  },

  // --- MOVIMIENTOS ---
  async getMovimientos(subrubroId, anio, mes) {
    const iid = Number(subrubroId);
    const filter = { subrubro_id: iid };
    if (anio && mes) {
      const prefix = `${anio}-${String(mes).padStart(2, '0')}`;
      filter.fecha = { $regex: `^${prefix}` };
    }
    const movs = await Movimiento.find(filter).lean();
    // El saldo por factura necesita TODOS los movimientos del subrubro: una NC o
    // un pago vinculado puede estar en un mes distinto al de la factura.
    const todos = (anio && mes) ? await Movimiento.find({ subrubro_id: iid }).lean() : movs;
    const saldo = computeSaldosFacturas(todos);
    const conSaldo = movs.map(m =>
      m.tipo === 'factura' ? { ...m, saldo: saldo.get(m._id) ?? (m.monto || 0) } : m
    );
    // Dentro de cada día: primero facturas (ingresos, +), luego pagos/NC/ajustes
    // (egresos, −). Misma detección de "factura" que usa el frontend.
    const rankTipo = (m) => (m.tipo === 'factura' || (!m.tipo && (m.monto || 0) > 0)) ? 0 : 1;
    return withIds(conSaldo.sort((a, b) => {
      if (!a.fecha && !b.fecha) return rankTipo(a) - rankTipo(b) || a._id - b._id;
      if (!a.fecha) return 1;
      if (!b.fecha) return -1;
      return a.fecha.localeCompare(b.fecha) || rankTipo(a) - rankTipo(b) || a._id - b._id;
    }));
  },

  async createMovimiento(subrubroId, { monto = 0, pago = 0, fecha, fecha_vencimiento = null, campos_extra = {}, tipo, concepto = '', metodo_pago = null, caja_mov_id = null, documento = null, facturas_vinculadas_ids = [], percepcion_iva = 0, ingresos_brutos = 0, idempotency_key = null }) {
    const sub = await Subrubro.findById(Number(subrubroId));
    if (!sub) throw new Error('Subrubro no encontrado');
    // Guarda de idempotencia: si ya existe un movimiento con esta clave, es un
    // reintento de la misma alta → devolver el existente sin crear un duplicado.
    if (idempotency_key) {
      const existente = await findMovByIdemKey(idempotency_key);
      if (existente) {
        logger.warn({ idempotency_key, movimiento_id: existente._id, subrubro_id: existente.subrubro_id }, 'Alta de movimiento duplicada evitada (idempotency_key)');
        return withId(existente);
      }
    }
    // Los pagos programados desde Caja se fechan en el vencimiento de la factura,
    // que puede ser futuro; en ese caso no aplicamos la validación de "no posterior
    // a hoy". El resto de los movimientos sí la conservan.
    if (caja_mov_id == null) validarFecha(fecha);
    const tipoFinal = tipo || (Number(monto) > 0 ? 'factura' : 'pago');
    // Auto-vencimiento: si es una factura sin fecha_vencimiento y el subrubro tiene
    // configurado un criterio de vencimiento, calcularlo según el modo activo
    // ('dias' = N días desde la emisión / 'dia_semana' = próximo día fijo de la semana).
    let venc = fecha_vencimiento || null;
    // Un vencimiento manual nunca puede ser anterior a la emisión (el automático
    // ya lo garantiza por construcción).
    if (venc && fecha && venc < fecha) {
      const e = new Error('La fecha de vencimiento no puede ser anterior a la fecha de emisión');
      e.statusCode = 400;
      throw e;
    }
    if (!venc && tipoFinal === 'factura' && fecha) {
      venc = calcularVencimientoSub(fecha, sub);
    }
    // Validación de método_pago
    let metodo = normalizarMetodoPago(metodo_pago);
    const id = await Counter.next('movimientos');
    // documento (factura/remito) solo tiene sentido para tipo='factura'. En un
    // subrubro DEUDA no existe el remito (es dinero a cobrar, no un gasto en
    // efectivo): se fuerza 'factura' para que nunca dispare syncCajaRemito.
    const docFinal = tipoFinal === 'factura'
      ? (sub.tipo_subrubro === 'deuda' ? 'factura' : (documento || 'factura'))
      : null;
    // Remito: se paga en efectivo en el acto y el método no es editable.
    if (docFinal === 'remito') metodo = 'efectivo';
    // Vinculación explícita de facturas: solo aplica a pagos / notas de crédito.
    // Si el pago se vincula a una factura puntual, `recalcularPagos` marca esa
    // factura como pagada respetando la elección del usuario (sin tocar las
    // facturas anteriores pendientes).
    const vinculadas = tipoFinal === 'factura' ? [] : (facturas_vinculadas_ids || []).map(Number);
    // Pago/NC vinculado: capturar los saldos previos (alimentan el detalle de
    // aplicación para auditoría) y validar que una NC no supere el saldo pendiente.
    let saldosAntes = null;
    if (vinculadas.length && (tipoFinal === 'pago' || tipoFinal === 'nota_credito')) {
      const movsPrev = await Movimiento.find({ subrubro_id: Number(subrubroId) }).lean();
      saldosAntes = computeSaldosFacturas(movsPrev);
      if (tipoFinal === 'nota_credito') validarSaldoNC(saldosAntes, vinculadas, pago);
    }
    try {
      await Movimiento.create({
        _id: id, subrubro_id: Number(subrubroId), fecha,
        monto: Number(monto) || 0, pago: Number(pago) || 0,
        tipo: tipoFinal, facturas_vinculadas_ids: vinculadas, pagado: false,
        fecha_vencimiento: venc,
        campos_extra: campos_extra || {}, concepto: concepto || '',
        // Percepciones/retenciones: solo tienen sentido en facturas/NC, pero se
        // guardan siempre (0 por defecto). No afectan el `monto`. Un remito nunca
        // lleva percepciones.
        percepcion_iva: docFinal === 'remito' ? 0 : (Number(percepcion_iva) || 0),
        ingresos_brutos: docFinal === 'remito' ? 0 : (Number(ingresos_brutos) || 0),
        metodo_pago: metodo,
        documento: docFinal,
        caja_mov_id: caja_mov_id != null ? Number(caja_mov_id) : null,
        idempotency_key: idempotency_key ? String(idempotency_key) : null,
        _ajuste_pago_id: null, created_at: now()
      });
    } catch (err) {
      // Backstop de carrera: dos altas con la misma clave en paralelo. El índice
      // único garantiza que solo una gane; la perdedora recupera la ganadora.
      if (err.code === 11000 && idempotency_key) {
        const existente = await findMovByIdemKey(idempotency_key);
        if (existente) {
          logger.warn({ idempotency_key, movimiento_id: existente._id }, 'Alta de movimiento duplicada evitada por índice único (carrera)');
          return withId(existente);
        }
      }
      throw err;
    }
    await recalcularPagos(subrubroId);
    // Remito → gasto automático (sin confirmar) en la Caja del Día, en efectivo.
    if (docFinal === 'remito' && caja_mov_id == null) {
      await syncCajaRemito({ _id: id, fecha, fecha_vencimiento: venc, monto, subrubro_id: subrubroId }, sub, true);
    }
    // Pago registrado desde el Subrubro → reflejarlo como gasto confirmado en la
    // Caja del Día (sincronización Subrubro → Caja). Solo si NO vino de la Caja
    // (caja_mov_id null): un pago originado en la Caja ya tiene allí su ítem.
    if (tipoFinal === 'pago' && caja_mov_id == null) {
      await syncCajaPago({ _id: id, fecha, pago: Number(pago) || 0, metodo_pago: metodo, subrubro_id: subrubroId }, sub, true);
    }
    const creado = withId(await Movimiento.findById(id).lean());
    // Detalle de aplicación por factura (queda en Audit vía la respuesta).
    if (saldosAntes) {
      const movsPost = await Movimiento.find({ subrubro_id: Number(subrubroId) }).lean();
      creado.aplicaciones = armarAplicaciones(vinculadas, saldosAntes, movsPost);
    }
    return creado;
  },

  async updateMovimiento(id, { monto = 0, pago = 0, fecha, fecha_vencimiento = null, campos_extra = {}, tipo, concepto = '', metodo_pago, documento, percepcion_iva, ingresos_brutos }) {
    const mov = await Movimiento.findById(Number(id));
    if (!mov) throw new Error('Movimiento no encontrado');
    // Estado previo: para saber si hay que limpiar el gasto de caja de un remito
    // que dejó de serlo (o quedó como pago/NC), o el espejo de Caja de un pago.
    const eraRemito = mov.tipo === 'factura' && mov.documento === 'remito';
    const eraPago = mov.tipo === 'pago';
    const veniaDeCaja = mov.caja_mov_id != null;
    validarFecha(fecha);
    // Misma regla que en el alta: el vencimiento nunca puede ser anterior a la emisión.
    if (fecha_vencimiento && fecha && fecha_vencimiento < fecha) {
      const e = new Error('La fecha de vencimiento no puede ser anterior a la fecha de emisión');
      e.statusCode = 400;
      throw e;
    }
    mov.monto = Number(monto) || 0;
    mov.pago = Number(pago) || 0;
    mov.fecha = fecha;
    mov.fecha_vencimiento = fecha_vencimiento || null;
    mov.campos_extra = campos_extra || {};
    // Percepciones/retenciones: solo se actualizan si vienen en el payload (no pisar con 0).
    if (percepcion_iva !== undefined) mov.percepcion_iva = Number(percepcion_iva) || 0;
    if (ingresos_brutos !== undefined) mov.ingresos_brutos = Number(ingresos_brutos) || 0;
    if (tipo) mov.tipo = tipo;
    if (concepto !== undefined) mov.concepto = concepto;
    if (metodo_pago !== undefined) mov.metodo_pago = normalizarMetodoPago(metodo_pago);
    if (documento !== undefined) {
      mov.documento = mov.tipo === 'factura' ? (documento || 'factura') : null;
    }
    // En un subrubro DEUDA no existe el remito (misma regla que en el alta).
    if (mov.documento === 'remito') {
      const subDoc = await Subrubro.findById(mov.subrubro_id).lean();
      if (subDoc?.tipo_subrubro === 'deuda') mov.documento = 'factura';
    }
    const esRemito = mov.tipo === 'factura' && mov.documento === 'remito';
    // Remito: sin percepciones y siempre en efectivo (no editable).
    if (esRemito) {
      mov.percepcion_iva = 0;
      mov.ingresos_brutos = 0;
      mov.metodo_pago = 'efectivo';
    }
    await mov.save();
    await recalcularPagos(mov.subrubro_id);
    // Mantener en sync el gasto de Caja del Día solo si el movimiento es o fue un
    // remito: crear/actualizar si lo es, o eliminar el gasto auto-generado si dejó
    // de serlo. Para una factura normal no se toca nada (ni vencimientos ni gastos
    // manuales enlazados).
    if (esRemito || eraRemito) {
      // syncCajaRemito refleja el SALDO y, si el remito quedó saldado (saldo 0, p. ej.
      // pagado con un pago del subrubro), borra el ítem pendiente en vez de re-generarlo.
      // Así editar un remito ya pagado no lo revive en la Caja como pendiente.
      const sub = await Subrubro.findById(mov.subrubro_id).lean();
      await syncCajaRemito(mov, sub, esRemito);
    }
    // Mantener en sync el espejo de Caja de un pago del subrubro: actualizar si sigue
    // siendo pago, o borrarlo si dejó de serlo. No aplica a pagos que vinieron de la
    // Caja (esos ya tienen su propio ítem y no llevan espejo).
    if (!veniaDeCaja && (mov.tipo === 'pago' || eraPago)) {
      const subP = await Subrubro.findById(mov.subrubro_id).lean();
      await syncCajaPago(mov, subP, mov.tipo === 'pago');
    }
    return withId(mov.toObject());
  },

  async deleteMovimiento(id) {
    const mov = await Movimiento.findById(Number(id));
    if (!mov) return;
    const subrubroId = mov.subrubro_id;
    if (mov.tipo === 'pago' || mov.tipo === 'nota_credito') {
      await Movimiento.deleteMany({ _ajuste_pago_id: Number(id) });
    }
    // Sync inverso: si este pago vino de una entrada de caja, desconfirmarla.
    // No la borramos — el gasto queda registrado en caja pero como pendiente, así el
    // usuario puede volver a confirmarlo o decidir qué hacer con él.
    if (mov.caja_mov_id) {
      await CajaMovimiento.updateOne(
        { _id: Number(mov.caja_mov_id), pago_mov_id: Number(id) },
        { $set: { confirmado: false, pago_mov_id: null } }
      );
    }
    // Espejo de Caja de un pago del subrubro (sincronización Subrubro → Caja): se
    // borra junto con el pago. Va ANTES del updateMany de abajo para que se elimine
    // de verdad (no que quede como gasto pendiente desligado).
    if (mov.tipo === 'pago') {
      await CajaMovimiento.deleteMany({ pago_mov_id: Number(id), origen: 'subrubro' });
    }
    // Defensa adicional: por si el caja_mov_id quedó suelto, buscar cualquier
    // CajaMovimiento que apunte a este pago y limpiarlo.
    await CajaMovimiento.updateMany(
      { pago_mov_id: Number(id) },
      { $set: { confirmado: false, pago_mov_id: null } }
    );
    // Si era una factura, eliminar el ítem de caja auto-sincronizado pendiente que
    // la representaba (apunta a ella por movimiento_id). Sin esto, el vencimiento
    // borrado seguiría arrastrándose en la Caja del Día día a día.
    if (mov.tipo === 'factura') {
      if (mov.documento === 'remito') {
        await borrarCajaRemito(Number(id));
      } else {
        await CajaMovimiento.deleteMany({ movimiento_id: Number(id), confirmado: false });
      }
    }
    await Movimiento.findByIdAndDelete(Number(id));
    await recalcularPagos(subrubroId);
  },

  async clearMovimientos(subrubroId) {
    const iid = Number(subrubroId);
    const sub = await Subrubro.findById(iid);
    if (!sub) throw new Error('Subrubro no encontrado');
    const { deletedCount } = await Movimiento.deleteMany({ subrubro_id: iid });
    return { deleted: deletedCount };
  },

  async clearAllMovimientos(rubroId) {
    const rid = Number(rubroId);
    const subs = await Subrubro.find({ rubro_id: rid }, { _id: 1 }).lean();
    const subIds = subs.map(s => s._id);
    const { deletedCount } = await Movimiento.deleteMany({ subrubro_id: { $in: subIds } });
    // Barrido de huérfanos: movimientos cuyo subrubro fue borrado y quedaron sueltos
    // (importaciones viejas que no cascadeaban). Evita que "Vaciar todo" deje datos.
    const allSubIds = (await Subrubro.find({}, { _id: 1 }).lean()).map(s => s._id);
    const { deletedCount: huerfanos } = await Movimiento.deleteMany({ subrubro_id: { $nin: allSubIds } });
    return { deleted: deletedCount + huerfanos };
  },

  async crearPagoVinculado(subrubroId, { fecha, monto_pago, tipo = 'pago', facturas_vinculadas_ids = [], concepto_diferencia = 'Diferencia', campos_extra = {}, metodo_pago = null, caja_mov_id = null, percepcion_iva = 0, ingresos_brutos = 0, idempotency_key = null }) {
    const sub = await Subrubro.findById(Number(subrubroId));
    if (!sub) throw new Error('Subrubro no encontrado');
    // Guarda de idempotencia (mismo criterio que createMovimiento).
    if (idempotency_key) {
      const existente = await findMovByIdemKey(idempotency_key);
      if (existente) {
        logger.warn({ idempotency_key, movimiento_id: existente._id, subrubro_id: existente.subrubro_id }, 'Alta de pago vinculado duplicada evitada (idempotency_key)');
        return withId(existente);
      }
    }
    const idsNum = facturas_vinculadas_ids.map(Number);
    const metodo = tipo === 'pago' ? normalizarMetodoPago(metodo_pago) : null;

    // Saldos ANTES de aplicar este pago/NC: validan el monto de la NC (nunca mayor
    // al saldo pendiente de la factura vinculada) y alimentan el detalle de
    // aplicación saldo_anterior → saldo_posterior para la auditoría.
    let saldosAntes = null;
    if (idsNum.length) {
      const movsPrev = await Movimiento.find({ subrubro_id: Number(subrubroId) }).lean();
      saldosAntes = computeSaldosFacturas(movsPrev);
      if (tipo === 'nota_credito') validarSaldoNC(saldosAntes, idsNum, monto_pago);
    }

    // Con el modelo de saldo por factura, un pago/NC parcial deja la factura con
    // saldo pendiente; NO se genera un "ajuste" por la diferencia (eso saldaría la
    // factura por error y descuadraría el total del subrubro).
    const id = await Counter.next('movimientos');
    try {
      await Movimiento.create({
        _id: id, subrubro_id: Number(subrubroId), fecha,
        monto: 0, pago: Number(monto_pago), tipo,
        facturas_vinculadas_ids: idsNum, pagado: false,
        fecha_vencimiento: null, campos_extra: campos_extra || {},
        concepto: '', metodo_pago: metodo,
        // Percepciones: solo la NC las lleva (el pago no). No suman al monto.
        percepcion_iva: tipo === 'nota_credito' ? (Number(percepcion_iva) || 0) : 0,
        ingresos_brutos: tipo === 'nota_credito' ? (Number(ingresos_brutos) || 0) : 0,
        caja_mov_id: caja_mov_id != null ? Number(caja_mov_id) : null,
        idempotency_key: idempotency_key ? String(idempotency_key) : null,
        _ajuste_pago_id: null, created_at: now()
      });
    } catch (err) {
      if (err.code === 11000 && idempotency_key) {
        const existente = await findMovByIdemKey(idempotency_key);
        if (existente) {
          logger.warn({ idempotency_key, movimiento_id: existente._id }, 'Alta de pago vinculado duplicada evitada por índice único (carrera)');
          return withId(existente);
        }
      }
      throw err;
    }

    await recalcularPagos(subrubroId);
    // Pago vinculado registrado desde el Subrubro → espejo en la Caja del Día
    // (Subrubro → Caja). Solo si no vino de la Caja (caja_mov_id null).
    if (tipo === 'pago' && caja_mov_id == null) {
      await syncCajaPago({ _id: id, fecha, pago: Number(monto_pago) || 0, metodo_pago: metodo, subrubro_id: subrubroId }, sub, true);
    }
    const creado = withId(await Movimiento.findById(id).lean());
    // Detalle de aplicación por factura (queda en Audit vía la respuesta).
    if (saldosAntes) {
      const movsPost = await Movimiento.find({ subrubro_id: Number(subrubroId) }).lean();
      creado.aplicaciones = armarAplicaciones(idsNum, saldosAntes, movsPost);
    }
    return creado;
  },

  async actualizarPagoVinculado(movId, { fecha, monto_pago, facturas_vinculadas_ids = [], concepto_diferencia = 'Diferencia', campos_extra = {}, metodo_pago, percepcion_iva, ingresos_brutos }) {
    const mov = await Movimiento.findById(Number(movId));
    if (!mov) throw new Error('Movimiento no encontrado');
    await Movimiento.deleteMany({ _ajuste_pago_id: Number(movId) });

    const idsNum = facturas_vinculadas_ids.map(Number);

    // Saldos previos reales (para auditoría) y saldos SIN este movimiento (para
    // validar el nuevo monto de una NC: su aplicación anterior se reemplaza).
    let saldosAntes = null;
    if (idsNum.length) {
      const movsPrev = await Movimiento.find({ subrubro_id: mov.subrubro_id }).lean();
      saldosAntes = computeSaldosFacturas(movsPrev);
      if (mov.tipo === 'nota_credito') {
        const saldosSinEste = computeSaldosFacturas(movsPrev.filter(m => m._id !== Number(movId)));
        validarSaldoNC(saldosSinEste, idsNum, monto_pago);
      }
    }

    mov.fecha = fecha;
    mov.pago = Number(monto_pago);
    mov.facturas_vinculadas_ids = idsNum;
    mov.campos_extra = campos_extra || {};
    if (metodo_pago !== undefined && mov.tipo === 'pago') {
      mov.metodo_pago = normalizarMetodoPago(metodo_pago);
    }
    // Percepciones: solo se tocan si vienen en el payload (y solo tienen sentido en NC).
    if (percepcion_iva !== undefined) mov.percepcion_iva = mov.tipo === 'nota_credito' ? (Number(percepcion_iva) || 0) : 0;
    if (ingresos_brutos !== undefined) mov.ingresos_brutos = mov.tipo === 'nota_credito' ? (Number(ingresos_brutos) || 0) : 0;
    await mov.save();

    // Sin ajuste por diferencia: el saldo pendiente vive en la factura (modelo de
    // saldo). El deleteMany de arriba limpia ajustes viejos de pagos previos.
    await recalcularPagos(mov.subrubro_id);
    // Mantener el espejo de Caja en sync (fecha/monto/método) si es un pago del
    // subrubro. No aplica a pagos originados en la Caja.
    if (mov.caja_mov_id == null && mov.tipo === 'pago') {
      const subP = await Subrubro.findById(mov.subrubro_id).lean();
      await syncCajaPago(mov, subP, true);
    }
    const actualizado = withId(mov.toObject());
    // Detalle de aplicación por factura (queda en Audit vía la respuesta).
    if (saldosAntes) {
      const movsPost = await Movimiento.find({ subrubro_id: mov.subrubro_id }).lean();
      actualizado.aplicaciones = armarAplicaciones(idsNum, saldosAntes, movsPost);
    }
    return actualizado;
  },

  async getSaldoTotal(subrubroId) {
    const sub = await Subrubro.findById(Number(subrubroId)).lean();
    if (!sub) return null;
    const campos = await Campo.find({ rubro_id: sub.rubro_id }).lean();
    const camposSuma = new Set(campos.filter(c => c.tipo === 'suma').map(c => c.nombre));
    const camposResta = new Set(campos.filter(c => c.tipo === 'resta').map(c => c.nombre));
    const movs = await Movimiento.find({ subrubro_id: Number(subrubroId) }).lean();
    let saldo = sub.monto_base || 0;
    for (const m of movs) {
      saldo += (m.monto || 0);
      saldo -= (m.pago || 0);
      for (const [k, v] of Object.entries(m.campos_extra || {})) {
        const n = Number(v);
        if (!isNaN(n) && n !== 0) {
          if (camposSuma.has(k)) saldo += n;
          if (camposResta.has(k)) saldo -= n;
        }
      }
    }
    return saldo;
  },

  // Saldo acumulado de todos los movimientos ANTERIORES al mes indicado
  async getSaldoAnterior(subrubroId, anio, mes) {
    const sub = await Subrubro.findById(Number(subrubroId)).lean();
    if (!sub) return 0;
    const campos = await Campo.find({ rubro_id: sub.rubro_id }).lean();
    const camposSuma = new Set(campos.filter(c => c.tipo === 'suma').map(c => c.nombre));
    const camposResta = new Set(campos.filter(c => c.tipo === 'resta').map(c => c.nombre));
    const prefix = `${anio}-${String(mes).padStart(2, '0')}`;
    // Movimientos anteriores al mes: fecha existe y es menor al primer día del mes
    const movs = await Movimiento.find({
      subrubro_id: Number(subrubroId),
      fecha: { $lt: `${prefix}-01` },
    }).lean();
    let saldo = sub.monto_base || 0;
    for (const m of movs) {
      saldo += (m.monto || 0);
      saldo -= (m.pago || 0);
      for (const [k, v] of Object.entries(m.campos_extra || {})) {
        const n = Number(v);
        if (!isNaN(n) && n !== 0) {
          if (camposSuma.has(k)) saldo += n;
          if (camposResta.has(k)) saldo -= n;
        }
      }
    }
    return saldo;
  },

  // `tipoSubrubro` filtra por el tipo del subrubro dueño de la factura:
  //   'factura' (default) → boletas a PAGAR a proveedores (excluye deudas a cobrar,
  //               así no aparecen como "facturas vencidas" en dashboard/alertas/caja).
  //   'deuda'   → deudas a COBRAR próximas a vencer (informativas).
  async getVencimientos(diasAdelante = 30, tipoSubrubro = 'factura') {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    let candidatas = await Movimiento.find({ fecha_vencimiento: { $exists: true, $ne: null }, tipo: 'factura', pagado: { $ne: true } }).lean();
    if (candidatas.length === 0) return [];

    // Filtro por tipo de subrubro (los legacy sin campo cuentan como 'factura').
    const subsTipo = await Subrubro.find(
      { _id: { $in: [...new Set(candidatas.map(m => m.subrubro_id))] } },
      { tipo_subrubro: 1 }
    ).lean();
    const tipoDe = new Map(subsTipo.map(s => [s._id, s.tipo_subrubro || 'factura']));
    candidatas = candidatas.filter(m => (tipoDe.get(m.subrubro_id) || 'factura') === tipoSubrubro);
    if (candidatas.length === 0) return [];

    const subIds = [...new Set(candidatas.map(m => m.subrubro_id))];
    // Para cada subrubro necesitamos TODOS sus movimientos (facturas + pagos + NC),
    // no solo las facturas por vencer, porque el saldo real de una factura sale de
    // descontarle los pagos y notas de crédito (vinculados o aplicados FIFO).
    const movsSub = await Movimiento.find({ subrubro_id: { $in: subIds } }).lean();
    const porSub = new Map();
    for (const m of movsSub) {
      if (!porSub.has(m.subrubro_id)) porSub.set(m.subrubro_id, []);
      porSub.get(m.subrubro_id).push(m);
    }
    const saldosPorSub = new Map(); // subId -> Map(facturaId -> saldo)
    for (const [sid, lista] of porSub) saldosPorSub.set(sid, computeSaldosFacturas(lista));

    const subs = await Subrubro.find({ _id: { $in: subIds } }).lean();
    const rubroIds = [...new Set(subs.map(s => s.rubro_id))];
    const rubros = await Rubro.find({ _id: { $in: rubroIds } }).lean();
    const subMap = Object.fromEntries(subs.map(s => [s._id, { ...s, id: s._id }]));
    const rubroMap = Object.fromEntries(rubros.map(r => [r._id, { ...r, id: r._id }]));
    return candidatas
      .map(m => {
        const venc = new Date(m.fecha_vencimiento + 'T00:00:00');
        const diasRestantes = Math.ceil((venc - hoy) / (1000 * 60 * 60 * 24));
        const sub = subMap[m.subrubro_id];
        const rubro = sub ? rubroMap[sub.rubro_id] : null;
        const saldoCalc = saldosPorSub.get(m.subrubro_id)?.get(m._id);
        // Saldo pendiente real. Si por algún motivo no se pudo calcular, cae al monto.
        const saldo = saldoCalc == null ? r2(m.monto) : saldoCalc;
        // `monto` se expone como el saldo pendiente porque es lo que todos los
        // consumidores (dashboard, panel, email) muestran como "lo que se debe".
        // El monto original de la factura queda en `monto_original`.
        return { ...m, id: m._id, subrubro: sub, rubro, dias_restantes: diasRestantes, saldo, monto: saldo, monto_original: m.monto };
      })
      .filter(m => m.dias_restantes <= diasAdelante)
      // Una NC o pagos que cubren todo dejan saldo 0: ya no es un vencimiento pendiente.
      .filter(m => (m.saldo || 0) > 0.005)
      .sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento));
  },

  // --- IMPORT BATCH ---
  async findOrCreateSubrubroForImport(rubroId, nombre) {
    const n = nombre.trim();
    let sub = await Subrubro.findOne({ rubro_id: Number(rubroId), nombre: { $regex: new RegExp(`^${n}$`, 'i') } }).lean();
    if (!sub) {
      const id = await Counter.next('subrubros');
      sub = await Subrubro.create({ _id: id, rubro_id: Number(rubroId), nombre: n, monto_base: 0, created_at: now() });
      sub = sub.toObject();
    }
    return sub;
  },

  async getMovsForDedup(subrubroId) {
    const movs = await Movimiento.find({ subrubro_id: Number(subrubroId) }, { fecha: 1, monto: 1, pago: 1, tipo: 1, campos_extra: 1 }).lean();
    const nros = new Set(movs.map(m => extraerNroFactura(m.campos_extra)).filter(Boolean));
    const fechaMontos = new Set(movs.filter(m => m.fecha && m.tipo !== 'pago').map(m => `${m.fecha}|${m.monto}`));
    const pagosFechaMonto = new Set(movs.filter(m => m.fecha && (m.pago || 0) > 0).map(m => `${m.fecha}|${m.pago}`));
    return { nros, fechaMontos, pagosFechaMonto };
  },

  async bulkInsertMovimientos(movsList) {
    if (movsList.length === 0) return;
    const startId = await Counter.nextBatch('movimientos', movsList.length);
    const docs = movsList.map((m, i) => ({ ...m, _id: startId + i, created_at: now() }));
    await Movimiento.insertMany(docs);
  },

  async recalcularPagosSub(subrubroId) {
    await recalcularPagos(subrubroId);
  },

  async recalcularPagosMultiple(subrubroIds) {
    for (const id of subrubroIds) await recalcularPagos(id);
  },

  async searchMovimientos(q, limit = 25) {
    const query = String(q).trim();
    if (query.length < 2) return [];
    const re = { $regex: query, $options: 'i' };
    const matchingSubs = await Subrubro.find({ nombre: re }, { _id: 1 }).lean();
    const matchingSubIds = matchingSubs.map(s => s._id);
    const camposExtra = [
      'nro_factura','descripcion','razon_social','proveedor','detalle',
      'numero','factura','numero_factura','importe','referencia','concepto_extra',
    ];
    const movs = await Movimiento.find({
      $or: [
        { concepto: re },
        { subrubro_id: { $in: matchingSubIds } },
        ...camposExtra.map(k => ({ [`campos_extra.${k}`]: re })),
      ]
    })
    .sort({ fecha: -1 })
    .limit(Math.min(Number(limit), 50))
    .lean();
    if (movs.length === 0) return [];
    const subIds = [...new Set(movs.map(m => m.subrubro_id))];
    const subs = await Subrubro.find({ _id: { $in: subIds } }).lean();
    const rubroIds = [...new Set(subs.map(s => s.rubro_id))];
    const rubros = await Rubro.find({ _id: { $in: rubroIds } }).lean();
    const subMap = Object.fromEntries(subs.map(s => [s._id, { ...s, id: s._id }]));
    const rubroMap = Object.fromEntries(rubros.map(r => [r._id, { ...r, id: r._id }]));
    return movs.map(m => ({
      ...m, id: m._id,
      subrubro: subMap[m.subrubro_id] || null,
      rubro: subMap[m.subrubro_id] ? rubroMap[subMap[m.subrubro_id].rubro_id] || null : null,
    }));
  },

  // Deuda total acumulada de toda la app = suma de los saldos pendientes de todas
  // las facturas. computeSaldosFacturas se aplica por subrubro (la imputación FIFO
  // y las vinculaciones son por subrubro), y se suman los saldos de cada uno.
  // Excluye los subrubros de tipo 'deuda': eso es plata a COBRAR, no deuda propia.
  async getDeudaTotal() {
    const subsDeuda = await Subrubro.find({ tipo_subrubro: 'deuda' }, { _id: 1 }).lean();
    const excluidos = new Set(subsDeuda.map(s => s._id));
    const movs = await Movimiento.find({}, { subrubro_id: 1, fecha: 1, monto: 1, pago: 1, tipo: 1, facturas_vinculadas_ids: 1 }).lean();
    const porSub = new Map();
    for (const m of movs) {
      if (excluidos.has(m.subrubro_id)) continue;
      if (!porSub.has(m.subrubro_id)) porSub.set(m.subrubro_id, []);
      porSub.get(m.subrubro_id).push(m);
    }
    let deuda = 0;
    for (const lista of porSub.values()) {
      for (const s of computeSaldosFacturas(lista).values()) deuda += s;
    }
    return r2(deuda);
  },

  // Resumen de DEUDAS POR COBRAR (subrubros tipo 'deuda'): total pendiente,
  // cantidad de deudas abiertas y detalle por subrubro con su próximo vencimiento.
  // Alimenta la card del dashboard.
  async getDeudasPorCobrar() {
    const subs = await Subrubro.find({ tipo_subrubro: 'deuda' }).lean();
    if (subs.length === 0) return { total: 0, cantidad: 0, subrubros: [] };
    const subIds = subs.map(s => s._id);
    const movs = await Movimiento.find({ subrubro_id: { $in: subIds } }).lean();
    const porSub = new Map(subIds.map(id => [id, []]));
    for (const m of movs) porSub.get(m.subrubro_id)?.push(m);

    const rubros = await Rubro.find({ _id: { $in: [...new Set(subs.map(s => s.rubro_id))] } }).lean();
    const rubroMap = Object.fromEntries(rubros.map(r => [r._id, { ...r, id: r._id }]));

    let total = 0, cantidad = 0;
    const detalle = subs.map(s => {
      const lista = porSub.get(s._id) || [];
      const saldos = computeSaldosFacturas(lista);
      let pendiente = 0, abiertas = 0, prox = null;
      for (const m of lista) {
        if (m.tipo !== 'factura') continue;
        const sal = saldos.get(m._id) ?? (m.monto || 0);
        if (sal <= 0.005) continue;
        pendiente += sal;
        abiertas++;
        if (m.fecha_vencimiento && (!prox || m.fecha_vencimiento < prox)) prox = m.fecha_vencimiento;
      }
      total += pendiente;
      cantidad += abiertas;
      return {
        id: s._id,
        nombre: s.nombre,
        rubro: rubroMap[s.rubro_id] || null,
        saldo: r2(pendiente),
        deudas_abiertas: abiertas,
        proximo_vencimiento: prox,
      };
    }).filter(d => d.saldo > 0.005)
      .sort((a, b) => b.saldo - a.saldo);

    return { total: r2(total), cantidad, subrubros: detalle };
  },

  // Tendencia mensual para los subrubros indicados. Por cada mes con actividad
  // devuelve: facturado del mes, pagado del mes y la DEUDA = suma de los saldos
  // pendientes de todas las facturas al cierre de ese mes (incluye el arrastre de
  // meses anteriores). La deuda se calcula con computeSaldosFacturas, así que un
  // sobrepago o una NC nunca deja una factura en negativo ni netea contra otras.
  async getTendenciaDeuda(subIds, meses) {
    const ids = subIds.map(Number);
    const movs = await Movimiento.find({ subrubro_id: { $in: ids } }).lean();

    // Meses con al menos un movimiento fechado, ordenados ascendentemente.
    const conFecha = movs.filter(m => typeof m.fecha === 'string' && m.fecha);
    const mesesOrden = [...new Set(conFecha.map(m => m.fecha.slice(0, 7)))].sort();
    const mesesMostrar = mesesOrden.slice(-Math.max(1, meses));

    return mesesMostrar.map(mes => {
      let facturado = 0, pagado = 0;
      for (const m of conFecha) {
        if (m.fecha.slice(0, 7) !== mes) continue;
        if (m.tipo === 'factura') facturado += m.monto || 0;
        pagado += m.pago || 0;
      }
      // Saldos pendientes considerando toda la historia hasta el cierre del mes.
      const hasta = conFecha.filter(m => m.fecha.slice(0, 7) <= mes);
      let deuda = 0;
      for (const s of computeSaldosFacturas(hasta).values()) deuda += s;
      return { mes, facturado: r2(facturado), pagado: r2(pagado), diferencia: r2(deuda) };
    });
  },

  async getComparacionSubrubros(rubroId) {
    const subs = await Subrubro.find({ rubro_id: Number(rubroId) }).lean();
    if (subs.length === 0) return [];
    const subIds = subs.map(s => s._id);
    // Cargamos todos los movimientos del rubro una vez para poder calcular, además
    // de los totales, el próximo vencimiento (con su saldo real) y el método de pago
    // habitual por subrubro.
    const movs = await Movimiento.find({ subrubro_id: { $in: subIds } }).lean();
    const porSub = new Map(subIds.map(id => [id, []]));
    for (const m of movs) porSub.get(m.subrubro_id)?.push(m);

    const hoyStr = hoy();

    return subs.map(s => {
      const lista = porSub.get(s._id) || [];
      const facturado = lista.reduce((a, m) => a + (m.tipo === 'factura' ? (m.monto || 0) : 0), 0);
      const pagado = lista.reduce((a, m) => a + (m.pago || 0), 0);

      // Saldo pendiente real por factura (descuenta pagos y NC vinculados/FIFO).
      const saldos = computeSaldosFacturas(lista);

      // Deuda = suma de saldos pendientes (no facturado − pagado: así un sobrepago
      // o una NC no deja una factura en negativo ni netea contra otras).
      const pendiente = r2([...saldos.values()].reduce((a, v) => a + v, 0));
      const saldo = (s.monto_base || 0) + pendiente;

      // Próxima factura a vencer: impaga, con fecha_vencimiento definida y saldo > 0,
      // la de vencimiento más cercano (incluye vencidas: lo más urgente primero).
      let prox = null;
      for (const m of lista) {
        if (m.tipo !== 'factura' || m.pagado === true) continue;
        if (!m.fecha_vencimiento) continue;
        const sal = saldos.get(m._id) ?? (m.monto || 0);
        if (sal <= 0.005) continue;
        if (!prox || m.fecha_vencimiento < prox.fecha) prox = { fecha: m.fecha_vencimiento, importe: r2(sal) };
      }

      // Forma de pago habitual: método más frecuente entre los pagos que lo registran.
      const cont = {};
      for (const m of lista) {
        if ((m.pago || 0) > 0 && m.metodo_pago) cont[m.metodo_pago] = (cont[m.metodo_pago] || 0) + 1;
      }
      let metodo_habitual = null, max = 0;
      for (const [k, v] of Object.entries(cont)) if (v > max) { max = v; metodo_habitual = k; }

      return {
        id: s._id,
        nombre: s.nombre,
        icon: s.icon || null,
        facturado,
        pagado,
        pendiente,
        saldo,
        diferencia: pendiente,
        proximo_vencimiento: prox?.fecha ?? null,
        importe_proximo_vencimiento: prox?.importe ?? null,
        vencido: prox ? prox.fecha < hoyStr : false,
        metodo_habitual,
      };
    }).sort((a, b) => b.saldo - a.saldo);
  },

  // Análisis mes-a-mes de los subrubros de un rubro (S1). Para el mes objetivo
  // `mes` (YYYY-MM) devuelve, por subrubro: saldo (deuda acumulada) al cierre del
  // mes anterior y del mes actual, facturado/pagado del mes, diferencia, % de cambio
  // y tendencia. `subrubroId` opcional restringe a un solo subrubro.
  async getSubrubrosMensual(rubroId, mes, subrubroId = null) {
    const filtro = { rubro_id: Number(rubroId) };
    if (subrubroId) filtro._id = Number(subrubroId);
    const subs = await Subrubro.find(filtro).lean();
    if (subs.length === 0) return { mes, mesAnterior: prevMes(mes), subrubros: [] };

    const subIds = subs.map(s => s._id);
    const movs = await Movimiento.find({ subrubro_id: { $in: subIds } }).lean();
    const porSub = new Map(subIds.map(id => [id, []]));
    for (const m of movs) {
      if (typeof m.fecha === 'string' && m.fecha) porSub.get(m.subrubro_id)?.push(m);
    }

    const mesAnterior = prevMes(mes);
    const saldoHasta = (lista, mesTope) => {
      const hasta = lista.filter(m => m.fecha.slice(0, 7) <= mesTope);
      let d = 0;
      for (const s of computeSaldosFacturas(hasta).values()) d += s;
      return r2(d);
    };

    const subrubros = subs.map(s => {
      const lista = porSub.get(s._id) || [];
      const saldoActual = (s.monto_base || 0) + saldoHasta(lista, mes);
      const saldoAnterior = (s.monto_base || 0) + saldoHasta(lista, mesAnterior);
      let facturadoMes = 0, pagadoMes = 0;
      for (const m of lista) {
        if (m.fecha.slice(0, 7) !== mes) continue;
        if (m.tipo === 'factura') facturadoMes += m.monto || 0;
        pagadoMes += m.pago || 0;
      }
      const diferencia = r2(saldoActual - saldoAnterior);
      const pctCambio = saldoAnterior !== 0 ? r2((diferencia / Math.abs(saldoAnterior)) * 100) : null;
      const tendencia = Math.abs(diferencia) < 0.01 ? 'igual' : diferencia > 0 ? 'sube' : 'baja';
      return {
        id: s._id,
        nombre: s.nombre,
        saldoAnterior,
        saldoActual,
        facturadoMes: r2(facturadoMes),
        pagadoMes: r2(pagadoMes),
        diferencia,
        pctCambio,
        tendencia,
      };
    }).sort((a, b) => b.saldoActual - a.saldoActual);

    return { mes, mesAnterior, subrubros };
  },

  async getConfig() {
    let cfg = await AppConfig.findById('main').lean();
    if (!cfg) cfg = await AppConfig.create({ _id: 'main' }).then(d => d.toObject());
    return { ...cfg, id: cfg._id };
  },

  async updateConfig(data) {
    const cfg = await AppConfig.findByIdAndUpdate('main', { $set: data }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    return { ...cfg, id: cfg._id };
  },
};

module.exports = db;
module.exports.calcularProximoVencimiento = calcularProximoVencimiento;
module.exports.calcularProximoDiaSemana = calcularProximoDiaSemana;
module.exports.calcularProximoDiaMes = calcularProximoDiaMes;
module.exports.calcularVencimientoSub = calcularVencimientoSub;
module.exports.recomputarVencimientosSubrubro = recomputarVencimientosSubrubro;
module.exports.computeSaldosFacturas = computeSaldosFacturas;
