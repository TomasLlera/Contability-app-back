require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { errorHandler } = require('./middleware/errorHandler');
const logger = require('./logger');

const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  logger.error({ missing }, 'Faltan variables de entorno requeridas');
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  logger.error('JWT_SECRET debe tener al menos 32 caracteres');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = allowedOrigins.length
  ? {
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`Origin ${origin} no permitido por CORS`));
      },
      credentials: true,
    }
  : { origin: '*' };
app.use(cors(corsOptions));

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (req, res) => {
  const dbState = mongoose.connection.readyState; // 1 = connected
  res.status(dbState === 1 ? 200 : 503).json({
    status: dbState === 1 ? 'ok' : 'degraded',
    db: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] || 'unknown',
    uptime: Math.round(process.uptime()),
  });
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Demasiados intentos. Intentá de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  // En tests cada caso hace login en su beforeEach; el limiter no debe cortar la suite.
  skip: () => process.env.NODE_ENV === 'test',
});

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', require('./routes/auth'));

// JWT middleware — protege todas las rutas siguientes
const jwt = require('jsonwebtoken');
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
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
app.use('/api/config', require('./routes/config'));
app.use('/api/users', require('./routes/users'));
app.use('/api/stock', require('./routes/stock'));
app.use('/api/iva', require('./routes/iva'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/reportes', require('./routes/reportes'));
app.use('/api/backup', require('./routes/backup'));

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;

app.use(errorHandler);

async function start() {
  try {
    await mongoose.connect(MONGODB_URI);
    logger.info('MongoDB conectado');
    // Asegura que los índices estén creados antes de servir. Incluye los únicos
    // parciales de idempotencia (Movimiento / CajaMovimiento), que son el backstop
    // ante altas concurrentes con la misma idempotency_key.
    try {
      const { Movimiento, CajaMovimiento } = require('./models');
      await Promise.all([Movimiento.createIndexes(), CajaMovimiento.createIndexes()]);
    } catch (err) {
      logger.warn({ err: err.message }, 'No se pudieron crear todos los índices');
    }
    // Migración one-shot de roles: promueve admins existentes a superadmin si no hay ninguno.
    try {
      await require('./routes/auth').ensureSuperAdmin();
    } catch (err) {
      logger.warn({ err: err.message }, 'No se pudo ejecutar la migración de superadmin');
    }
    const server = app.listen(PORT, () => logger.info(`Backend corriendo en http://localhost:${PORT}`));

    const shutdown = async (signal) => {
      logger.info({ signal }, 'Cerrando servidor');
      server.close(() => mongoose.connection.close(false).then(() => process.exit(0)));
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error({ err: err.message }, 'Error conectando a MongoDB');
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  start();
}

module.exports = app;
