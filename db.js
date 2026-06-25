const { Counter, Local, Rubro, Subrubro, Movimiento, Campo, Categoria, ImportConfig, AppConfig, CajaMovimiento } = require('./models');

function now() {
  return new Date().toLocaleString('sv').replace('T', ' ');
}

function hoy() {
  return new Date().toISOString().split('T')[0];
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

const withId = doc => doc ? { ...doc, id: doc._id } : doc;
const withIds = arr => arr.map(withId);

async function recalcularPagos(subrubroId) {
  const iid = Number(subrubroId);
  const movs = await Movimiento.find({ subrubro_id: iid }).lean();

  movs.sort((a, b) => {
    if (!a.fecha && !b.fecha) return a._id - b._id;
    if (!a.fecha) return 1;
    if (!b.fecha) return -1;
    return a.fecha.localeCompare(b.fecha) || a._id - b._id;
  });

  const pagadoNuevo = {};
  for (const m of movs) {
    if (m.tipo === 'factura') pagadoNuevo[m._id] = false;
  }

  const idsManual = new Set();
  for (const m of movs) {
    if ((m.tipo === 'pago' || m.tipo === 'nota_credito') && m.facturas_vinculadas_ids?.length > 0) {
      for (const fid of m.facturas_vinculadas_ids) idsManual.add(Number(fid));
    }
  }
  for (const m of movs) {
    if (m.tipo === 'factura' && idsManual.has(m._id)) pagadoNuevo[m._id] = true;
  }

  const pagosLibres = movs.filter(m =>
    (m.tipo === 'pago' || m.tipo === 'nota_credito') &&
    (!m.facturas_vinculadas_ids || m.facturas_vinculadas_ids.length === 0)
  );
  let libre = pagosLibres.reduce((s, m) => s + (m.pago || 0), 0);

  for (const m of movs) {
    if (m.tipo !== 'factura' || pagadoNuevo[m._id]) continue;
    if (Math.round(libre * 100) >= Math.round(m.monto * 100)) {
      pagadoNuevo[m._id] = true;
      libre -= m.monto;
    } else {
      break;
    }
  }

  const bulkOps = Object.entries(pagadoNuevo).map(([id, pagado]) => ({
    updateOne: { filter: { _id: Number(id) }, update: { $set: { pagado } } }
  }));
  if (bulkOps.length > 0) await Movimiento.bulkWrite(bulkOps);
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
    await Subrubro.findByIdAndUpdate(Number(id), upd);
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
    const filter = { subrubro_id: Number(subrubroId) };
    if (anio && mes) {
      const prefix = `${anio}-${String(mes).padStart(2, '0')}`;
      filter.fecha = { $regex: `^${prefix}` };
    }
    const movs = await Movimiento.find(filter).lean();
    return withIds(movs.sort((a, b) => {
      if (!a.fecha && !b.fecha) return a._id - b._id;
      if (!a.fecha) return 1;
      if (!b.fecha) return -1;
      return a.fecha.localeCompare(b.fecha) || a._id - b._id;
    }));
  },

  async createMovimiento(subrubroId, { monto = 0, pago = 0, fecha, fecha_vencimiento = null, campos_extra = {}, tipo, concepto = '', metodo_pago = null, caja_mov_id = null }) {
    const sub = await Subrubro.findById(Number(subrubroId));
    if (!sub) throw new Error('Subrubro no encontrado');
    validarFecha(fecha);
    const tipoFinal = tipo || (Number(monto) > 0 ? 'factura' : 'pago');
    // Auto-vencimiento: si es una factura sin fecha_vencimiento y el subrubro tiene dia_vencimiento configurado,
    // calcular el próximo día N del mes (en el mes corriente si todavía no pasó, sino el mes siguiente).
    let venc = fecha_vencimiento || null;
    if (!venc && tipoFinal === 'factura' && sub.dia_vencimiento && fecha) {
      venc = calcularProximoVencimiento(fecha, sub.dia_vencimiento);
    }
    // Validación de método_pago
    const metodo = normalizarMetodoPago(metodo_pago);
    const id = await Counter.next('movimientos');
    await Movimiento.create({
      _id: id, subrubro_id: Number(subrubroId), fecha,
      monto: Number(monto) || 0, pago: Number(pago) || 0,
      tipo: tipoFinal, facturas_vinculadas_ids: [], pagado: false,
      fecha_vencimiento: venc,
      campos_extra: campos_extra || {}, concepto: concepto || '',
      metodo_pago: metodo,
      caja_mov_id: caja_mov_id != null ? Number(caja_mov_id) : null,
      _ajuste_pago_id: null, created_at: now()
    });
    await recalcularPagos(subrubroId);
    return withId(await Movimiento.findById(id).lean());
  },

  async updateMovimiento(id, { monto = 0, pago = 0, fecha, fecha_vencimiento = null, campos_extra = {}, tipo, concepto = '', metodo_pago }) {
    const mov = await Movimiento.findById(Number(id));
    if (!mov) throw new Error('Movimiento no encontrado');
    validarFecha(fecha);
    mov.monto = Number(monto) || 0;
    mov.pago = Number(pago) || 0;
    mov.fecha = fecha;
    mov.fecha_vencimiento = fecha_vencimiento || null;
    mov.campos_extra = campos_extra || {};
    if (tipo) mov.tipo = tipo;
    if (concepto !== undefined) mov.concepto = concepto;
    if (metodo_pago !== undefined) mov.metodo_pago = normalizarMetodoPago(metodo_pago);
    await mov.save();
    await recalcularPagos(mov.subrubro_id);
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
    // Defensa adicional: por si el caja_mov_id quedó suelto, buscar cualquier
    // CajaMovimiento que apunte a este pago y limpiarlo.
    await CajaMovimiento.updateMany(
      { pago_mov_id: Number(id) },
      { $set: { confirmado: false, pago_mov_id: null } }
    );
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
    return { deleted: deletedCount };
  },

  async crearPagoVinculado(subrubroId, { fecha, monto_pago, tipo = 'pago', facturas_vinculadas_ids = [], concepto_diferencia = 'Diferencia', campos_extra = {}, metodo_pago = null, caja_mov_id = null }) {
    const sub = await Subrubro.findById(Number(subrubroId));
    if (!sub) throw new Error('Subrubro no encontrado');
    const idsNum = facturas_vinculadas_ids.map(Number);
    const facturas = await Movimiento.find({ _id: { $in: idsNum }, tipo: 'factura' }).lean();
    const totalFacturas = facturas.reduce((s, f) => s + (f.monto || 0), 0);
    const diferencia = Math.round((totalFacturas - Number(monto_pago)) * 100) / 100;
    const metodo = tipo === 'pago' ? normalizarMetodoPago(metodo_pago) : null;

    const id = await Counter.next('movimientos');
    await Movimiento.create({
      _id: id, subrubro_id: Number(subrubroId), fecha,
      monto: 0, pago: Number(monto_pago), tipo,
      facturas_vinculadas_ids: idsNum, pagado: false,
      fecha_vencimiento: null, campos_extra: campos_extra || {},
      concepto: '', metodo_pago: metodo,
      caja_mov_id: caja_mov_id != null ? Number(caja_mov_id) : null,
      _ajuste_pago_id: null, created_at: now()
    });

    if (diferencia > 0.005) {
      const ajusteId = await Counter.next('movimientos');
      await Movimiento.create({
        _id: ajusteId, subrubro_id: Number(subrubroId), fecha,
        monto: 0, pago: diferencia, tipo: 'ajuste',
        facturas_vinculadas_ids: [], _ajuste_pago_id: id,
        pagado: false, fecha_vencimiento: null, campos_extra: {},
        concepto: concepto_diferencia || 'Diferencia', created_at: now()
      });
    }

    await recalcularPagos(subrubroId);
    return withId(await Movimiento.findById(id).lean());
  },

  async actualizarPagoVinculado(movId, { fecha, monto_pago, facturas_vinculadas_ids = [], concepto_diferencia = 'Diferencia', campos_extra = {}, metodo_pago }) {
    const mov = await Movimiento.findById(Number(movId));
    if (!mov) throw new Error('Movimiento no encontrado');
    await Movimiento.deleteMany({ _ajuste_pago_id: Number(movId) });

    const idsNum = facturas_vinculadas_ids.map(Number);
    const facturas = await Movimiento.find({ _id: { $in: idsNum }, tipo: 'factura' }).lean();
    const totalFacturas = facturas.reduce((s, f) => s + (f.monto || 0), 0);
    const diferencia = Math.round((totalFacturas - Number(monto_pago)) * 100) / 100;

    mov.fecha = fecha;
    mov.pago = Number(monto_pago);
    mov.facturas_vinculadas_ids = idsNum;
    mov.campos_extra = campos_extra || {};
    if (metodo_pago !== undefined && mov.tipo === 'pago') {
      mov.metodo_pago = normalizarMetodoPago(metodo_pago);
    }
    await mov.save();

    if (diferencia > 0.005) {
      const ajusteId = await Counter.next('movimientos');
      await Movimiento.create({
        _id: ajusteId, subrubro_id: mov.subrubro_id, fecha,
        monto: 0, pago: diferencia, tipo: 'ajuste',
        facturas_vinculadas_ids: [], _ajuste_pago_id: Number(movId),
        pagado: false, fecha_vencimiento: null, campos_extra: {},
        concepto: concepto_diferencia || 'Diferencia', created_at: now()
      });
    }

    await recalcularPagos(mov.subrubro_id);
    return withId(mov.toObject());
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

  async getVencimientos(diasAdelante = 30) {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const movs = await Movimiento.find({ fecha_vencimiento: { $exists: true, $ne: null }, tipo: 'factura', pagado: { $ne: true } }).lean();
    const subIds = [...new Set(movs.map(m => m.subrubro_id))];
    const subs = await Subrubro.find({ _id: { $in: subIds } }).lean();
    const rubroIds = [...new Set(subs.map(s => s.rubro_id))];
    const rubros = await Rubro.find({ _id: { $in: rubroIds } }).lean();
    const subMap = Object.fromEntries(subs.map(s => [s._id, { ...s, id: s._id }]));
    const rubroMap = Object.fromEntries(rubros.map(r => [r._id, { ...r, id: r._id }]));
    return movs
      .map(m => {
        const venc = new Date(m.fecha_vencimiento + 'T00:00:00');
        const diasRestantes = Math.ceil((venc - hoy) / (1000 * 60 * 60 * 24));
        const sub = subMap[m.subrubro_id];
        const rubro = sub ? rubroMap[sub.rubro_id] : null;
        return { ...m, id: m._id, subrubro: sub, rubro, dias_restantes: diasRestantes };
      })
      .filter(m => m.dias_restantes <= diasAdelante)
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
    const movs = await Movimiento.find({ subrubro_id: Number(subrubroId) }, { fecha: 1, monto: 1, campos_extra: 1 }).lean();
    const nros = new Set(movs.map(m => m.campos_extra?.nro_factura).filter(Boolean));
    const fechaMontos = new Set(movs.filter(m => m.fecha).map(m => `${m.fecha}|${m.monto}`));
    return { nros, fechaMontos };
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

  async getComparacionSubrubros(rubroId) {
    const subs = await Subrubro.find({ rubro_id: Number(rubroId) }).lean();
    if (subs.length === 0) return [];
    const subIds = subs.map(s => s._id);
    const agg = await Movimiento.aggregate([
      { $match: { subrubro_id: { $in: subIds } } },
      {
        $group: {
          _id: '$subrubro_id',
          facturado: { $sum: { $cond: [{ $eq: ['$tipo', 'factura'] }, '$monto', 0] } },
          pagado: { $sum: '$pago' },
        }
      }
    ]);
    const aggMap = Object.fromEntries(agg.map(d => [d._id, d]));
    return subs.map(s => {
      const facturado = aggMap[s._id]?.facturado ?? 0;
      const pagado = aggMap[s._id]?.pagado ?? 0;
      const pendiente = facturado - pagado;
      const saldo = (s.monto_base || 0) + pendiente;
      return {
        id: s._id,
        nombre: s.nombre,
        icon: s.icon || null,
        facturado,
        pagado,
        pendiente,
        saldo,
        diferencia: pendiente,
      };
    }).sort((a, b) => b.saldo - a.saldo);
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
