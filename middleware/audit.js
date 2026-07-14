const models = require('../models');
const { Audit, Counter } = models;
const logger = require('../logger');

const SENSITIVE_KEYS = new Set(['password', 'password_hash', 'token', 'jwt_secret']);

// Mapa recurso → modelo para capturar el estado "antes" en updates/deletes.
// Solo recursos de documento único con :id numérico estándar; los bulk/import/config
// no tienen un único doc previo y quedan fuera (se registran sin `before`).
const MODEL_MAP = {
  movimiento: models.Movimiento,
  caja: models.CajaMovimiento,
  campo: models.Campo,
  categoria: models.Categoria,
  local: models.Local,
  rubro: models.Rubro,
  subrubro: models.Subrubro,
  producto: models.Producto,
  user: models.User,
  iva_compra: models.IvaCompra,
  iva_venta: models.IvaVenta,
  venta_sistema: models.VentaSistema,
  tarjeta: models.TarjetaTransaccion,
};

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) out[k] = '[REDACTED]';
    else if (v && typeof v === 'object') out[k] = redact(v);
    else out[k] = v;
  }
  return out;
}

async function writeAudit(entry) {
  try {
    const id = await Counter.next('audit');
    await Audit.create({ _id: id, ...entry });
  } catch (err) {
    logger.error({ err: err.message }, 'No se pudo escribir audit log');
  }
}

// Middleware: registra mutaciones (POST/PUT/DELETE) sobre el recurso indicado.
// Usar como: router.post('/...', audit('movimiento'), handler)
function audit(recurso, opts = {}) {
  return async (req, res, next) => {
    const method = req.method;
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return next();

    const accion = method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update';

    // Captura del estado "antes" para updates/deletes de documento único. Se hace
    // ANTES de ejecutar el handler para que refleje el valor previo real. Es tolerante
    // a fallos: cualquier error deja `before` en null sin interrumpir la request.
    let before = null;
    if ((accion === 'update' || accion === 'delete') && req.params.id && MODEL_MAP[recurso]) {
      try {
        const prev = await MODEL_MAP[recurso].findById(req.params.id).lean();
        if (prev) before = redact(prev);
      } catch (err) {
        logger.warn({ err: err.message, recurso, id: req.params.id }, 'No se pudo capturar estado previo para audit');
      }
    }

    const originalJson = res.json.bind(res);

    res.json = async (body) => {
      if (res.statusCode < 400) {
        const recurso_id = opts.idFromBody?.(req, body)
          ?? req.params.id
          ?? body?.id
          ?? body?._id
          ?? null;

        const diff = {
          before: before ?? undefined,
          payload: req.body && Object.keys(req.body).length ? redact(req.body) : undefined,
          response: accion === 'delete' ? undefined : redact(body),
        };

        await writeAudit({
          usuario: req.user?.usuario || 'desconocido',
          user_id: req.user?.userId || null,
          accion,
          recurso,
          recurso_id,
          diff,
          ip: req.ip,
        });
      }
      return originalJson(body);
    };

    next();
  };
}

module.exports = { audit, writeAudit, redact };
