#!/usr/bin/env node
// Backfill one-shot: completa fecha_vencimiento en facturas pendientes cuyo
// subrubro tiene dia_vencimiento configurado.
//
// Uso:
//   node scripts/backfill-vencimientos.js          # aplica cambios
//   node scripts/backfill-vencimientos.js --dry    # solo muestra qué actualizaría
require('dotenv').config();
const mongoose = require('mongoose');
const { Subrubro, Movimiento } = require('../models');
const { calcularProximoVencimiento } = require('../db');

async function main() {
  const dry = process.argv.includes('--dry');
  const recompute = process.argv.includes('--recompute');
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI no definida'); process.exit(1); }

  await mongoose.connect(uri);
  console.log(`Conectado a Mongo${dry ? ' (DRY RUN)' : ''}${recompute ? ' (RECOMPUTE)' : ''}`);

  const subs = await Subrubro.find(
    { dia_vencimiento: { $ne: null } },
    { _id: 1, nombre: 1, dia_vencimiento: 1 }
  ).lean();
  const subMap = new Map(subs.map(s => [s._id, s]));
  console.log(`Subrubros con dia_vencimiento: ${subs.length}`);

  if (subs.length === 0) {
    await mongoose.disconnect();
    return;
  }

  const baseFilter = {
    subrubro_id: { $in: subs.map(s => s._id) },
    tipo: 'factura',
    pagado: { $ne: true },
    fecha: { $exists: true, $ne: null, $ne: '' },
  };
  if (!recompute) {
    baseFilter.$or = [{ fecha_vencimiento: null }, { fecha_vencimiento: { $exists: false } }];
  }
  const movs = await Movimiento.find(baseFilter, { _id: 1, subrubro_id: 1, fecha: 1, monto: 1, fecha_vencimiento: 1 }).lean();

  console.log(`Facturas candidatas: ${movs.length}`);

  const ops = [];
  const ejemplos = [];
  for (const m of movs) {
    const sub = subMap.get(m.subrubro_id);
    if (!sub) continue;
    const venc = calcularProximoVencimiento(m.fecha, sub.dia_vencimiento);
    if (!venc) continue;
    ops.push({
      updateOne: {
        filter: { _id: m._id },
        update: { $set: { fecha_vencimiento: venc } },
      },
    });
    if (ejemplos.length < 10) {
      ejemplos.push({ id: m._id, sub: sub.nombre, fecha: m.fecha, dia: sub.dia_vencimiento, venc, monto: m.monto });
    }
  }

  console.log(`Updates a aplicar: ${ops.length}`);
  if (ejemplos.length) {
    console.log('Ejemplos:');
    for (const e of ejemplos) console.log(`  #${e.id} [${e.sub}] fecha=${e.fecha} dia=${e.dia} → venc=${e.venc} ($${e.monto})`);
  }

  if (!dry && ops.length) {
    const res = await Movimiento.bulkWrite(ops, { ordered: false });
    console.log(`bulkWrite: matched=${res.matchedCount} modified=${res.modifiedCount}`);
  } else if (dry) {
    console.log('DRY RUN: no se aplicaron cambios.');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
