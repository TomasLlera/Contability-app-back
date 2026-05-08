require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Demasiados intentos. Intentá de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', require('./routes/auth'));

// JWT middleware — protege todas las rutas siguientes
const jwt = require('jsonwebtoken');
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
});

app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/locales', require('./routes/locales'));
app.use('/api/rubros', require('./routes/rubros'));
app.use('/api/campos', require('./routes/campos'));
app.use('/api/categorias', require('./routes/categorias'));
app.use('/api/subrubros', require('./routes/subrubros'));
app.use('/api/movimientos', require('./routes/movimientos'));
app.use('/api/caja', require('./routes/caja'));

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI no está definida en .env');
  process.exit(1);
}

app.use(errorHandler);

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('MongoDB conectado');
    app.listen(PORT, () => console.log(`Backend corriendo en http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('Error conectando a MongoDB:', err.message);
    process.exit(1);
  });
