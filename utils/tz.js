// Fecha y hora en la zona horaria del negocio.
//
// El backend corre en Render (UTC), así que `new Date().toISOString()` devuelve un
// día distinto al del usuario entre las 21:00 y la medianoche de Argentina. Para los
// recordatorios eso no es cosmético: decide qué día de la semana es, si un
// recordatorio de "hoy" ya venció y a qué hora corresponde volver a mostrarlo. Por
// eso la zona se resuelve siempre explícita en vez de confiar en la del proceso.
const TZ = process.env.APP_TZ || 'America/Argentina/Buenos_Aires';

const partes = (d, opts) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts })
      .formatToParts(d)
      .map(p => [p.type, p.value])
  );

// 'YYYY-MM-DD' del día en curso.
function hoyLocal(d = new Date()) {
  const p = partes(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

// 0 = domingo … 6 = sábado. Mismo criterio que `dia_semana_vencimiento` del Subrubro.
const DIAS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function diaSemanaLocal(d = new Date()) {
  return DIAS.indexOf(partes(d, { weekday: 'short' }).weekday);
}

// Minutos transcurridos desde la medianoche local (0-1439).
function minutosDelDiaLocal(d = new Date()) {
  const p = partes(d, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return Number(p.hour) * 60 + Number(p.minute);
}

// Aritmética sobre 'YYYY-MM-DD'. Se hace en UTC puro a propósito: son días de
// calendario sin hora, así que no hay cambio de horario que corregir.
function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const restarDias = (fecha, n) => sumarDias(fecha, -n);

// Día de la semana (0-6) de una fecha 'YYYY-MM-DD'.
const diaSemanaDeFecha = (fecha) => new Date(`${fecha}T00:00:00Z`).getUTCDay();

module.exports = { TZ, hoyLocal, diaSemanaLocal, minutosDelDiaLocal, sumarDias, restarDias, diaSemanaDeFecha };
