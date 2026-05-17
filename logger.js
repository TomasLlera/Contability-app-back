// Logger estructurado. Usa pino si está instalado; si no, cae a console.
let logger;
try {
  const pino = require('pino');
  logger = pino({
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    redact: ['password', 'password_hash', 'token', '*.password', '*.password_hash', '*.token', 'req.headers.authorization'],
  });
} catch {
  const fmt = (lvl, args) => {
    const [first, ...rest] = args;
    const ts = new Date().toISOString();
    if (typeof first === 'object' && first !== null) {
      return `[${ts}] ${lvl} ${rest.join(' ')} ${JSON.stringify(first)}`;
    }
    return `[${ts}] ${lvl} ${[first, ...rest].join(' ')}`;
  };
  logger = {
    info: (...a) => console.log(fmt('INFO', a)),
    warn: (...a) => console.warn(fmt('WARN', a)),
    error: (...a) => console.error(fmt('ERROR', a)),
    debug: (...a) => process.env.LOG_LEVEL === 'debug' && console.log(fmt('DEBUG', a)),
    child: () => logger,
  };
}

module.exports = logger;
