require('dotenv').config();
const mongoose = require('mongoose');
const { Audit, Movimiento } = require('../models');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  // Audits 13–34 con payload + response chico
  const audits = await Audit.find({ _id: { $gte: 13 } }).sort({ _id: 1 }).lean();
  for (const a of audits) {
    const r = a.diff?.response;
    const small = r && typeof r === 'object'
      ? { id: r.id ?? r._id, tipo: r.tipo, monto: r.monto, pago: r.pago, fecha: r.fecha, venc: r.fecha_vencimiento, subrubro_id: r.subrubro_id, movimiento_id: r.movimiento_id, _ajuste_pago_id: r._ajuste_pago_id, facturas_vinculadas_ids: r.facturas_vinculadas_ids, confirmado: r.confirmado, pago_mov_id: r.pago_mov_id, caja_mov_id: r.caja_mov_id, metodo: r.metodo }
      : r;
    console.log(`#${a._id} ${a.accion.toUpperCase()} ${a.recurso} ${a.recurso_id || ''}`);
    if (a.diff?.payload) console.log('   payload:', a.diff.payload);
    if (small) console.log('   response:', small);
    console.log();
  }

  // Listar TODAS las facturas del subrubro 115
  console.log('=== TODAS las facturas en subrubro 115 ===');
  const facts = await Movimiento.find({ subrubro_id: 115, tipo: 'factura' }).sort({ _id: 1 }).lean();
  facts.forEach(f => console.log({ id: f._id, monto: f.monto, fecha: f.fecha, venc: f.fecha_vencimiento, pagado: f.pagado }));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
