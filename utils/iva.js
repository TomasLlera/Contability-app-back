// Regla de IVA compartida por Registro (tarjetas / venta sistema) y por el cruce
// mensual de IVA. Vive acá para que la alícuota esté definida UNA sola vez: si
// cambia, cambia en los dos lados juntos.
//
// Se aplica directo sobre el total (total × 0,21), no se despeja de un precio final
// (total ÷ 1,21 × 0,21): es el criterio con el que se cargan los totales.
const IVA_ALICUOTA = 0.21;

const round2 = (n) => Math.round(((n || 0) + Number.EPSILON) * 100) / 100;
const ivaDe = (total) => round2((total || 0) * IVA_ALICUOTA);

module.exports = { IVA_ALICUOTA, round2, ivaDe };
