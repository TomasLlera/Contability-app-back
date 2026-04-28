require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/locales', require('./routes/locales'));
app.use('/api/rubros', require('./routes/rubros'));
app.use('/api/campos', require('./routes/campos'));
app.use('/api/categorias', require('./routes/categorias'));
app.use('/api/subrubros', require('./routes/subrubros'));
app.use('/api/movimientos', require('./routes/movimientos'));

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI no está definida en .env');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('MongoDB conectado');
    app.listen(PORT, () => console.log(`Backend corriendo en http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('Error conectando a MongoDB:', err.message);
    process.exit(1);
  });
