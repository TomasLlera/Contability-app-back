require('dotenv').config();
const mongoose = require('mongoose');
const { Audit } = require('../models');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const total = await Audit.countDocuments();
  const max = await Audit.findOne().sort({ _id: -1 }).lean();
  const min = await Audit.findOne().sort({ _id: 1 }).lean();
  console.log({ total, minId: min?._id, maxId: max?._id });

  // Conteo por recurso
  const byRecurso = await Audit.aggregate([
    { $group: { _id: '$recurso', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  console.log('\nAudits por recurso:', byRecurso);

  // Últimos 20 audits
  console.log('\nÚltimos 20 audits:');
  const last = await Audit.find().sort({ _id: -1 }).limit(20).lean();
  last.forEach(a => console.log({ id: a._id, accion: a.accion, recurso: a.recurso, recurso_id: a.recurso_id, usuario: a.usuario }));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
