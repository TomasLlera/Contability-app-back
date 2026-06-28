const mongoose = require('mongoose');

// --- Counter (auto-increment) ---
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
counterSchema.statics.next = async function (name) {
  const r = await this.findByIdAndUpdate(name, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true });
  return r.seq;
};
counterSchema.statics.nextBatch = async function (name, count) {
  if (count === 0) return 1;
  const r = await this.findByIdAndUpdate(name, { $inc: { seq: count } }, { returnDocument: 'after', upsert: true });
  return r.seq - count + 1;
};
const Counter = mongoose.model('Counter', counterSchema);

// --- Local ---
const Local = mongoose.model('Local', new mongoose.Schema({
  _id: Number, nombre: String, icon: { type: String, default: '🏠' }, created_at: String
}));

// --- Rubro ---
const rubroSchema = new mongoose.Schema({
  _id: Number, nombre: String, local_id: Number, icon: String, created_at: String
});
rubroSchema.index({ local_id: 1 });
const Rubro = mongoose.model('Rubro', rubroSchema);

// --- Subrubro ---
const subrubroSchema = new mongoose.Schema({
  _id: Number, rubro_id: Number, nombre: String,
  monto_base: { type: Number, default: 0 }, icon: String, created_at: String,
  // Metadata fiscal/bancaria
  cuit: { type: String, default: '' },
  cbu: { type: String, default: '' },
  alias: { type: String, default: '' },
  razon_social: { type: String, default: '' },
  notas: { type: String, default: '' },
  // Modo de cálculo del vencimiento de cada factura:
  //   'dias'      → vence `dia_vencimiento` días después de la fecha de emisión (modo por defecto / legacy).
  //   'dia_semana'→ vence el próximo `dia_semana_vencimiento` (0=domingo … 6=sábado) posterior a la emisión.
  modo_vencimiento: { type: String, enum: ['dias', 'dia_semana'], default: 'dias' },
  // Días de plazo desde la fecha de cada factura hasta su vencimiento (1-365). null = sin plazo definido.
  dia_vencimiento: { type: Number, default: null, min: 1, max: 365 },
  // Día fijo de la semana de vencimiento (0=domingo … 6=sábado). null = no configurado.
  dia_semana_vencimiento: { type: Number, default: null, min: 0, max: 6 },
});
subrubroSchema.index({ rubro_id: 1 });
const Subrubro = mongoose.model('Subrubro', subrubroSchema);

// --- Movimiento ---
const movimientoSchema = new mongoose.Schema({
  _id: Number,
  subrubro_id: Number,
  fecha: String,
  monto: { type: Number, default: 0 },
  pago: { type: Number, default: 0 },
  tipo: String,
  facturas_vinculadas_ids: { type: [Number], default: [] },
  pagado: { type: Boolean, default: false },
  fecha_vencimiento: String,
  campos_extra: { type: mongoose.Schema.Types.Mixed, default: {} },
  concepto: { type: String, default: '' },
  // Método de pago: efectivo, transferencia o null (sin definir)
  metodo_pago: { type: String, enum: ['efectivo', 'transferencia', null], default: null },
  // Tipo de documento de respaldo (solo aplica si tipo='factura'): factura o remito.
  documento: { type: String, enum: ['factura', 'remito', null], default: null },
  // Link inverso a la entrada de caja que originó este pago (si vino de caja)
  caja_mov_id: { type: Number, default: null },
  _ajuste_pago_id: { type: Number, default: null },
  created_at: String
});
movimientoSchema.index({ subrubro_id: 1, fecha: 1 });
movimientoSchema.index({ subrubro_id: 1, tipo: 1, pagado: 1 });
movimientoSchema.index({ fecha_vencimiento: 1, pagado: 1 });
movimientoSchema.index({ _ajuste_pago_id: 1 });
movimientoSchema.index({ caja_mov_id: 1 });
const Movimiento = mongoose.model('Movimiento', movimientoSchema);

// --- Campo de Rubro ---
const campoSchema = new mongoose.Schema({
  _id: Number, rubro_id: Number, nombre: String,
  tipo: { type: String, default: 'texto' }, orden: { type: Number, default: 0 }
});
campoSchema.index({ rubro_id: 1, orden: 1 });
const Campo = mongoose.model('Campo', campoSchema);

// --- Categoría (compatibilidad) ---
const categoriaSchema = new mongoose.Schema({
  _id: Number, rubro_id: Number, nombre: String, operacion: String,
  tipo_calculo: { type: String, default: 'fijo' },
  porcentaje_default: { type: Number, default: null }
});
categoriaSchema.index({ rubro_id: 1 });
const Categoria = mongoose.model('Categoria', categoriaSchema);

// --- Caja ---
const cajaSchema = new mongoose.Schema({
  _id: Number,
  fecha: String,
  tipo: { type: String, enum: ['saldo_inicial', 'saldo_cuenta', 'ingreso_extra', 'empleado', 'gasto'], default: 'gasto' },
  concepto: String,
  monto: { type: Number, default: 0 },
  // null = sin método (típicamente auto-sync de vencimientos; el usuario lo define al confirmar)
  metodo: { type: String, enum: ['efectivo', 'transferencia', null], default: null },
  subrubro_id: { type: Number, default: null },
  movimiento_id: { type: Number, default: null },
  confirmado: { type: Boolean, default: null }, // null = registro viejo (se trata como confirmado); false = pendiente; true = confirmado
  pago_mov_id: { type: Number, default: null }, // ID del movimiento de pago creado en el subrubro al confirmar
  es_especial: { type: Boolean, default: false },
  created_at: String,
});
cajaSchema.index({ fecha: 1 });
// Único parcial: cada factura (movimiento_id) puede generar como mucho UN ítem de
// caja. Garantiza idempotencia del auto-sync ante llamadas concurrentes (p. ej. el
// doble disparo de efectos en React dev). Los ítems manuales tienen movimiento_id
// null y quedan fuera del índice gracias al partialFilterExpression.
cajaSchema.index(
  { movimiento_id: 1 },
  { unique: true, partialFilterExpression: { movimiento_id: { $type: 'number' } } }
);
const CajaMovimiento = mongoose.model('CajaMovimiento', cajaSchema);

// --- Caja Config ---
const CajaConfig = mongoose.model('CajaConfig', new mongoose.Schema({
  _id: { type: String, default: 'main' },
  empleados: [{ nombre: String }],
  proveedores: [{ nombre: String, subrubro_id: { type: Number, default: null } }],
  rubros_sync: { type: [Number], default: [] },       // rubros cuyos vencimientos se sincronizan
  dias_anticipacion_caja: { type: Number, default: 3 }, // días hacia adelante para mostrar vencimientos
}));

// --- Import Config ---
const ImportConfig = mongoose.model('ImportConfig', new mongoose.Schema({
  rubro_id: { type: Number, unique: true },
  mapping: mongoose.Schema.Types.Mixed,
  mode: String,
  updated_at: String
}));

// --- User ---
const User = mongoose.model('User', new mongoose.Schema({
  _id: Number,
  usuario: { type: String, unique: true },
  password_hash: String,
  role: { type: String, enum: ['admin', 'viewer'], default: 'viewer' },
  activo: { type: Boolean, default: true },
  created_at: String,
}));

// --- App Config (configuración global de la app) ---
const AppConfig = mongoose.model('AppConfig', new mongoose.Schema({
  _id: { type: String, default: 'main' },
  email_alertas: { type: String, default: '' },
  alertas_activas: { type: Boolean, default: false },
  dias_anticipacion: { type: Number, default: 7 },
}));

// --- Stock ---
const productoSchema = new mongoose.Schema({
  _id: Number,
  nombre: String,
  categoria: { type: String, default: '' },
  descripcion: { type: String, default: '' },
  unidad: { type: String, default: 'unidad' },
  codigo_barra: { type: String, default: '' },
  precio_costo: { type: Number, default: 0 },
  iva: { type: Number, default: 0 },
  precio_venta: { type: Number, default: 0 },
  stock_actual: { type: Number, default: 0 },
  stock_minimo: { type: Number, default: 0 },
  // Vínculo opcional a un subrubro (proveedor). Sin este campo en el schema,
  // Mongoose (strict por defecto) descartaba el valor al guardar y el vínculo
  // nunca persistía.
  subrubro_id: { type: Number, default: null },
  activo: { type: Boolean, default: true },
  created_at: String,
});
productoSchema.index({ activo: 1 });
productoSchema.index({ codigo_barra: 1 });
productoSchema.index({ subrubro_id: 1 });
const Producto = mongoose.model('Producto', productoSchema);

const movStockSchema = new mongoose.Schema({
  _id: Number,
  producto_id: Number,
  tipo: { type: String, enum: ['entrada', 'salida', 'ajuste'], default: 'entrada' },
  cantidad: Number,
  precio_costo: { type: Number, default: null },
  precio_venta: { type: Number, default: null },
  observacion: { type: String, default: '' },
  fecha: String,
  created_at: String,
});
movStockSchema.index({ producto_id: 1, fecha: -1 });
const MovimientoStock = mongoose.model('MovimientoStock', movStockSchema);

// --- Audit Log ---
const auditSchema = new mongoose.Schema({
  _id: Number,
  fecha: { type: String, default: () => new Date().toISOString() },
  usuario: String,
  user_id: Number,
  accion: { type: String, enum: ['create', 'update', 'delete', 'login', 'logout', 'login_failed'] },
  recurso: String,           // ej: 'movimiento', 'caja', 'user'
  recurso_id: mongoose.Schema.Types.Mixed,
  diff: { type: mongoose.Schema.Types.Mixed, default: null }, // { before, after } o payload
  ip: String,
});
auditSchema.index({ fecha: -1 });
auditSchema.index({ recurso: 1, recurso_id: 1 });
auditSchema.index({ usuario: 1, fecha: -1 });
const Audit = mongoose.model('Audit', auditSchema);

module.exports = { Counter, Local, Rubro, Subrubro, Movimiento, Campo, Categoria, ImportConfig, CajaMovimiento, CajaConfig, AppConfig, User, Producto, MovimientoStock, Audit };
