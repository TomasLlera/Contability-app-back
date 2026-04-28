require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('ERROR: MONGODB_URI no definida en .env'); process.exit(1); }

  const dataPath = path.join(__dirname, 'contability.json');
  if (!fs.existsSync(dataPath)) { console.error('ERROR: contability.json no encontrado'); process.exit(1); }

  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  await mongoose.connect(uri);
  console.log('MongoDB conectado');
  const db = mongoose.connection.db;

  // Drop using raw driver to avoid Mongoose interference
  const colNames = ['counters','locals','rubros','subrubros','movimientos','campos','categorias','importconfigs'];
  for (const c of colNames) { try { await db.collection(c).drop(); } catch {} }
  console.log('Colecciones limpiadas');

  const locales = data.locales || [];
  const rubros = data.rubros || [];
  const subrubros = data.subrubros || [];
  const movimientos = data.movimientos || [];
  const campos = data.campos || [];
  const categorias = data.categorias || [];
  const importConfigs = data.import_configs || [];

  // Insert everything using raw driver so numeric _id is preserved exactly
  const id = x => Number(x.id ?? x._id);

  if (locales.length > 0) {
    await db.collection('locals').insertMany(locales.map(l => ({
      _id: id(l), nombre: l.nombre, icon: l.icon || '🏠', created_at: l.created_at || new Date().toISOString()
    })));
    console.log(`Locales migrados: ${locales.length}`);
  }

  if (rubros.length > 0) {
    await db.collection('rubros').insertMany(rubros.map(r => ({
      _id: id(r), nombre: r.nombre, local_id: Number(r.local_id), icon: r.icon || null, created_at: r.created_at || new Date().toISOString()
    })));
    console.log(`Rubros migrados: ${rubros.length}`);
  }

  if (subrubros.length > 0) {
    await db.collection('subrubros').insertMany(subrubros.map(s => ({
      _id: id(s), rubro_id: Number(s.rubro_id), nombre: s.nombre,
      monto_base: s.monto_base || 0, icon: s.icon || null, created_at: s.created_at || new Date().toISOString()
    })));
    console.log(`Subrubros migrados: ${subrubros.length}`);
  }

  if (movimientos.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < movimientos.length; i += BATCH) {
      const batch = movimientos.slice(i, i + BATCH).map(m => ({
        _id: id(m), subrubro_id: Number(m.subrubro_id), fecha: m.fecha || null,
        monto: m.monto || 0, pago: m.pago || 0, tipo: m.tipo || 'factura',
        facturas_vinculadas_ids: (m.facturas_vinculadas_ids || []).map(Number),
        pagado: !!m.pagado, fecha_vencimiento: m.fecha_vencimiento || null,
        campos_extra: m.campos_extra || {}, concepto: m.concepto || '',
        _ajuste_pago_id: m._ajuste_pago_id ? Number(m._ajuste_pago_id) : null,
        created_at: m.created_at || new Date().toISOString()
      }));
      await db.collection('movimientos').insertMany(batch);
      console.log(`Movimientos migrados: ${Math.min(i + BATCH, movimientos.length)} / ${movimientos.length}`);
    }
  }

  if (campos.length > 0) {
    await db.collection('campos').insertMany(campos.map(c => ({
      _id: id(c), rubro_id: Number(c.rubro_id), nombre: c.nombre,
      tipo: c.tipo || 'texto', orden: c.orden || 0
    })));
    console.log(`Campos migrados: ${campos.length}`);
  }

  if (categorias.length > 0) {
    await db.collection('categorias').insertMany(categorias.map(c => ({
      _id: id(c), rubro_id: Number(c.rubro_id), nombre: c.nombre, operacion: c.operacion,
      tipo_calculo: c.tipo_calculo || 'fijo', porcentaje_default: c.porcentaje_default ?? null
    })));
    console.log(`Categorías migradas: ${categorias.length}`);
  }

  if (importConfigs.length > 0) {
    await db.collection('importconfigs').insertMany(importConfigs.map(ic => ({
      rubro_id: Number(ic.rubro_id), mapping: ic.mapping || {}, mode: ic.mode || 'skip_duplicates',
      updated_at: ic.updated_at || new Date().toISOString()
    })));
    console.log(`ImportConfigs migrados: ${importConfigs.length}`);
  }

  const seq = data._seq || {};
  const counters = [
    { _id: 'locales', seq: seq.locales || (locales.length > 0 ? Math.max(...locales.map(id)) : 0) },
    { _id: 'rubros', seq: seq.rubros || (rubros.length > 0 ? Math.max(...rubros.map(id)) : 0) },
    { _id: 'subrubros', seq: seq.subrubros || (subrubros.length > 0 ? Math.max(...subrubros.map(id)) : 0) },
    { _id: 'movimientos', seq: seq.movimientos || (movimientos.length > 0 ? Math.max(...movimientos.map(id)) : 0) },
    { _id: 'campos', seq: seq.campos || (campos.length > 0 ? Math.max(...campos.map(id)) : 0) },
    { _id: 'categorias', seq: seq.categorias || (categorias.length > 0 ? Math.max(...categorias.map(id)) : 0) },
  ];
  await db.collection('counters').insertMany(counters);
  console.log('Contadores configurados:', counters.map(c => `${c._id}=${c.seq}`).join(', '));

  console.log('\n✅ Migración completa');
  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('Error en migración:', err);
  process.exit(1);
});
