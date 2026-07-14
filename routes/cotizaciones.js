const express = require('express');
const router = express.Router();
const logger = require('../logger');

// Fuente: dolarapi.com — pública, sin API key, actualizada durante la rueda cambiaria.
const API = 'https://dolarapi.com/v1';
const CASAS_DOLAR = ['oficial', 'blue', 'bolsa', 'contadoconliqui', 'tarjeta', 'mayorista'];

// Caché en memoria: la cotización no cambia por segundo y la API es de terceros,
// así que un TTL corto evita pegarle en cada render del Settings.
const TTL_MS = 5 * 60 * 1000;
let cache = null; // { data, expira }

async function fetchJson(url) {
  // Sin timeout, una caída de la API dejaría la request colgada hasta el timeout del cliente.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Normaliza la respuesta de dolarapi a nuestra forma: { clave, nombre, compra, venta, actualizado }
function normalizar(item, clave, nombre) {
  return {
    clave,
    nombre,
    compra: item?.compra ?? null,
    venta: item?.venta ?? null,
    actualizado: item?.fechaActualizacion ?? null,
  };
}

async function traerCotizaciones() {
  const [dolares, euro] = await Promise.all([
    fetchJson(`${API}/dolares`),
    fetchJson(`${API}/cotizaciones/eur`),
  ]);

  // La API devuelve más casas de las que mostramos; respetamos el orden de CASAS_DOLAR.
  const lista = Array.isArray(dolares) ? dolares : [];
  const dolar = CASAS_DOLAR
    .map(casa => {
      const item = lista.find(d => d.casa === casa);
      return item ? normalizar(item, casa, item.nombre) : null;
    })
    .filter(Boolean);

  return {
    dolar,
    euro: normalizar(euro, 'oficial', euro?.nombre || 'Euro'),
    consultado: new Date().toISOString(),
  };
}

// GET /api/cotizaciones — dólar (por casa) y euro, compra/venta. `?refresh=1` saltea el caché.
router.get('/', async (req, res, next) => {
  try {
    const ahora = Date.now();
    if (!req.query.refresh && cache && cache.expira > ahora) {
      return res.json({ ...cache.data, cacheado: true });
    }

    const data = await traerCotizaciones();
    cache = { data, expira: ahora + TTL_MS };
    res.json({ ...data, cacheado: false });
  } catch (err) {
    // Si la API de terceros falla pero tenemos algo cacheado, servimos eso antes que un error:
    // una cotización de hace un rato es más útil que una pantalla rota.
    if (cache) {
      logger.warn({ err: err.message }, 'dolarapi falló, sirviendo caché vencido');
      return res.json({ ...cache.data, cacheado: true, desactualizado: true });
    }
    logger.error({ err: err.message }, 'dolarapi falló y no hay caché');
    res.status(503).json({ error: 'No se pudo obtener la cotización. Intentá de nuevo en unos minutos.' });
  }
});

module.exports = router;
