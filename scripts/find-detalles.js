require('dotenv').config();
const mongoose = require('mongoose');
const { Campo } = require('../models');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const todos = await Campo.find({}).lean();
  console.log('Total campos:', todos.length);
  for (const c of todos) {
    console.log(`  #${c._id} rubro=${c.rubro_id} nombre="${c.nombre}" tipo=${c.tipo}`);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
