#!/usr/bin/env node
// Migración one-shot: deja como mucho UN ítem de caja por factura (movimiento_id)
// y prepara la colección para el índice único parcial sobre movimiento_id.
//
// 1) Por cada movimiento_id con varios caja items, conserva el preferido
//    (confirmado si lo hay; si no, el de menor _id) y borra el resto.
// 2) Dropea el índice viejo no-único `movimiento_id_1` para que el modelo pueda
//    recrearlo como único parcial al levantar (autoIndex).
//
// Uso:
//   node scripts/fix-caja-duplicados.js --dry   # solo lista
//   node scripts/fix-caja-duplicados.js         # aplica
require('dotenv').config();
const mongoose = require('mongoose');
const { CajaMovimiento } = require('../models');

async function main() {
  const dry = process.argv.includes('--dry');
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI no definida'); process.exit(1); }

  await mongoose.connect(uri);
  console.log(`Conectado a Mongo${dry ? ' (DRY RUN)' : ''}`);

  // --- 1) Deduplicar por movimiento_id (incluye confirmados) ---
  const items = await CajaMovimiento.find({ movimiento_id: { $ne: null } }).sort({ _id: 1 }).lean();
  const porMov = new Map();
  for (const it of items) {
    if (!porMov.has(it.movimiento_id)) porMov.set(it.movimiento_id, []);
    porMov.get(it.movimiento_id).push(it);
  }

  const aBorrar = [];
  for (const [movId, group] of porMov) {
    if (group.length <= 1) continue;
    // Preferimos conservar el confirmado (tiene pago real asociado); si no, el menor _id.
    const keep = group.find(g => g.confirmado === true) || group[0];
    const dupes = group.filter(g => g._id !== keep._id);
    console.log(`  mov#${movId}: ${group.length} copias → conservar caja#${keep._id} (${keep.fecha}, confirmado=${keep.confirmado}), borrar ${dupes.map(d => `#${d._id}(${d.fecha})`).join(', ')}`);
    aBorrar.push(...dupes.map(d => d._id));
  }
  console.log(`Duplicados a borrar: ${aBorrar.length}`);

  if (!dry && aBorrar.length) {
    const r = await CajaMovimiento.deleteMany({ _id: { $in: aBorrar } });
    console.log(`Borrados: ${r.deletedCount}`);
  }

  // --- 2) Dropear el índice viejo no-único, si existe ---
  const coll = mongoose.connection.db.collection('cajamovimientos');
  const idx = await coll.indexes();
  const viejo = idx.find(i => i.name === 'movimiento_id_1' && !i.unique);
  if (viejo) {
    console.log('Índice viejo no-único movimiento_id_1 encontrado.');
    if (!dry) {
      await coll.dropIndex('movimiento_id_1');
      console.log('Índice viejo dropeado. El modelo lo recreará como único parcial al levantar.');
    }
  } else {
    console.log('No hay índice viejo no-único que dropear.');
  }

  if (dry) console.log('DRY RUN: no se modificó nada.');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
