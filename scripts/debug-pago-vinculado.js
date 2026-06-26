require('dotenv').config();
const mongoose = require('mongoose');
const { Audit } = require('../models');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  // Buscar todo audit que tenga 187062 en cualquier parte del diff
  const all = await Audit.find().sort({ _id: 1 }).lean();
  console.log(`Total audits: ${all.length}`);

  const mention = all.filter(a => JSON.stringify(a).includes('187062'));
  console.log(`\nAudits que mencionan 187062 en cualquier lugar:`);
  mention.forEach(a => console.log({
    id: a._id, accion: a.accion, recurso: a.recurso, recurso_id: a.recurso_id,
    diff: a.diff,
  }));

  // Cualquier audit del recurso 'movimiento_pago_vinculado'
  const pagoVinc = all.filter(a => String(a.recurso).includes('pago_vinculado'));
  console.log(`\nAudits de pago_vinculado: ${pagoVinc.length}`);
  pagoVinc.forEach(a => console.log({
    id: a._id, accion: a.accion, recurso: a.recurso, recurso_id: a.recurso_id,
    payload: a.diff?.payload,
    response: typeof a.diff?.response === 'object' ? { id: a.diff.response.id || a.diff.response._id, monto: a.diff.response.monto, pago: a.diff.response.pago, tipo: a.diff.response.tipo, facturas_vinculadas_ids: a.diff.response.facturas_vinculadas_ids } : a.diff?.response,
  }));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
