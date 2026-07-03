#!/usr/bin/env node
// Backfill one-shot: reagenda el gasto de Caja del Día de los remitos ya cargados a
// su FECHA DE VENCIMIENTO (antes se agendaban en la fecha de emisión). Solo toca
// ítems SIN CONFIRMAR: los confirmados ya se contabilizaron en un día y moverlos
// distorsionaría el histórico (usar --all para incluirlos igual, bajo tu criterio).
//
// Uso:
//   node scripts/backfill-remitos-caja.js          # aplica cambios (solo sin confirmar)
//   node scripts/backfill-remitos-caja.js --dry    # solo muestra qué reagendaría
//   node scripts/backfill-remitos-caja.js --all    # incluye también los confirmados
require('dotenv').config();
const mongoose = require('mongoose');
const { Movimiento, CajaMovimiento } = require('../models');

async function main() {
  const dry = process.argv.includes('--dry');
  const all = process.argv.includes('--all');
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI no definida'); process.exit(1); }

  await mongoose.connect(uri);
  console.log(`Conectado a Mongo${dry ? ' (DRY RUN)' : ''}${all ? ' (INCLUYE CONFIRMADOS)' : ''}`);

  // Todos los remitos (una factura con documento='remito').
  const remitos = await Movimiento.find(
    { tipo: 'factura', documento: 'remito' },
    { _id: 1, fecha: 1, fecha_vencimiento: 1 }
  ).lean();
  console.log(`Remitos encontrados: ${remitos.length}`);

  const remMap = new Map(remitos.map(r => [r._id, r]));

  // Sus ítems de Caja enlazados por movimiento_id.
  const items = await CajaMovimiento.find(
    { movimiento_id: { $in: remitos.map(r => r._id) } },
    { _id: 1, movimiento_id: 1, fecha: 1, confirmado: true }
  ).lean();

  const ops = [];
  const ejemplos = [];
  let saltadosConfirmados = 0;
  for (const it of items) {
    const rem = remMap.get(it.movimiento_id);
    if (!rem) continue;
    // Confirmado (confirmado === true): se contó en un día concreto → no lo movemos
    // salvo --all. null/false se tratan como no confirmados (pendientes).
    if (it.confirmado === true && !all) { saltadosConfirmados++; continue; }
    const objetivo = rem.fecha_vencimiento || rem.fecha;
    if (!objetivo || it.fecha === objetivo) continue; // ya está bien agendado
    ops.push({ updateOne: { filter: { _id: it._id }, update: { $set: { fecha: objetivo } } } });
    if (ejemplos.length < 15) ejemplos.push({ caja: it._id, mov: it.movimiento_id, de: it.fecha, a: objetivo });
  }

  console.log(`Reagendas a aplicar: ${ops.length}` + (saltadosConfirmados ? ` (${saltadosConfirmados} confirmados salteados; usá --all para incluirlos)` : ''));
  for (const e of ejemplos) console.log(`  caja#${e.caja} (remito#${e.mov}) ${e.de} → ${e.a}`);

  if (!dry && ops.length) {
    const res = await CajaMovimiento.bulkWrite(ops, { ordered: false });
    console.log(`bulkWrite: matched=${res.matchedCount} modified=${res.modifiedCount}`);
  } else if (dry) {
    console.log('DRY RUN: no se aplicaron cambios.');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
