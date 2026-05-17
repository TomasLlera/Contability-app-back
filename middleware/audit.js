const { Audit, Counter } = require('../models');
const logger = require('../logger');

const SENSITIVE_KEYS = new Set(['password', 'password_hash', 'token', 'jwt_secret']);

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
  return (req, res, next) => {
    const method = req.method;
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return next();

    const accion = method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update';
    const originalJson = res.json.bind(res);

    res.json = async (body) => {
      if (res.statusCode < 400) {
        const recurso_id = opts.idFromBody?.(req, body)
          ?? req.params.id
          ?? body?.id
          ?? body?._id
          ?? null;

        const diff = {
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
