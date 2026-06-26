require('dotenv').config();
const mongoose = require('mongoose');
const { Audit, Subrubro, Rubro } = require('../models');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const sub = await Subrubro.findById(115).lean();
  console.log('Subrubro 115:', sub);
  if (sub) {
    const rubro = await Rubro.findById(sub.rubro_id).lean();
    console.log('Rubro padre:', rubro);
  }

  console.log('\n--- Audits relevantes desde el 2026-06-24 ---');
  const audits = await Audit.find({
    _id: { $gte: 13 },
    recurso: { $in: ['movimientos_bulk', 'subrubro', 'rubro', 'local'] },
  }).sort({ _id: 1 }).lean();
  console.log(`Total: ${audits.length}`);
  audits.forEach(a => console.log({
    id: a._id, accion: a.accion, recurso: a.recurso, recurso_id: a.recurso_id, usuario: a.usuario,
    diffSnip: a.diff?.payload ? JSON.stringify(a.diff.payload).slice(0, 200) : (a.diff?.response ? JSON.stringify(a.diff.response).slice(0, 200) : '-'),
  }));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
