#!/usr/bin/env node
// Backfill puntual: aplica el método de pago predeterminado del subrubro a TODOS
// sus pagos existentes. Solo afecta subrubros con metodo_pago_default fijo
// ('efectivo' o 'transferencia'); los que tienen 'ambas' se ignoran.
//
// Uso:
//   node scripts/backfill-metodo-pago.js            (modo real: escribe)
//   node scripts/backfill-metodo-pago.js --dry-run  (solo muestra qué haría)
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI no definida'); process.exit(1); }

  const dryRun = process.argv.includes('--dry-run');
  await mongoose.connect(uri);
  const { Subrubro, Movimiento } = require('../models');

  const subs = await Subrubro.find({
    metodo_pago_default: { $in: ['efectivo', 'transferencia'] },
  }).lean();

  console.log(`${dryRun ? '[DRY-RUN] ' : ''}Subrubros con método fijo: ${subs.length}\n`);

  let totalPagos = 0;
  for (const s of subs) {
    const metodo = s.metodo_pago_default;
    // Pagos del subrubro cuyo método difiere del configurado (incluye los que no tienen método).
    const filtro = {
      subrubro_id: s._id,
      tipo: 'pago',
      metodo_pago: { $ne: metodo },
    };
    const count = await Movimiento.countDocuments(filtro);
    if (count === 0) {
      console.log(`  ${s.nombre} → ${metodo}: ya está todo al día (0 pagos a cambiar)`);
      continue;
    }
    if (dryRun) {
      console.log(`  ${s.nombre} → ${metodo}: cambiaría ${count} pago(s)`);
    } else {
      const r = await Movimiento.updateMany(filtro, { $set: { metodo_pago: metodo } });
      console.log(`  ${s.nombre} → ${metodo}: ${r.modifiedCount} pago(s) actualizado(s)`);
    }
    totalPagos += count;
  }

  console.log(`\n${dryRun ? '[DRY-RUN] ' : ''}Total de pagos ${dryRun ? 'a cambiar' : 'actualizados'}: ${totalPagos}`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
