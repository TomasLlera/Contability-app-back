const express = require('express');
const router = express.Router();
const { Recordatorio, RecordatorioEvento, Rubro, Subrubro, User, Counter } = require('../models');
const { asyncHandler } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const { audit } = require('../middleware/audit');
const { hoyLocal, diaSemanaLocal, minutosDelDiaLocal, sumarDias, restarDias, diaSemanaDeFecha } = require('../utils/tz');

const nowTs = () => new Date().toISOString();
const withId = doc => (doc ? { ...doc, id: doc._id } : doc);
const withIds = docs => docs.map(withId);

// Ventana en la que se reparten los recordatorios de tipo 'n_veces'. Son avisos
// operativos (hacer pedidos, controlar caja): fuera del horario del local no hay
// nadie para atenderlos.
const LABORAL_DESDE = 8 * 60;   // 08:00
const LABORAL_HASTA = 15 * 60;  // 15:00

// Cuánto espera un "Recordar más tarde" en un recordatorio 'una_vez'. Sin este piso,
// postergarlo equivaldría a silenciarlo, que es lo contrario de lo que pidió el
// usuario. Los demás tipos ya tienen su propio intervalo.
const POSTERGAR_MS = 60 * 60 * 1000;

const TIPOS_PROGRAMACION = ['unico', 'semanal', 'hoy'];
const TIPOS_FRECUENCIA = ['una_vez', 'cada_x_horas', 'n_veces', 'horarios_fijos'];

// --- Helpers de horarios ---------------------------------------------------

// 'HH:MM' → minutos desde medianoche. null si no es un horario válido.
function hhmmAMinutos(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const minutosAHhmm = (n) =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

// Horarios (en minutos) en los que corresponde reaparecer, para las frecuencias que
// se expresan como momentos del día. Las otras dos ('una_vez', 'cada_x_horas') no
// tienen horarios: devuelven [].
function horariosDe(rec) {
  if (rec.frecuencia_tipo === 'horarios_fijos') {
    return [...new Set((rec.horarios || []).map(hhmmAMinutos).filter(n => n !== null))].sort((a, b) => a - b);
  }
  if (rec.frecuencia_tipo === 'n_veces') {
    const n = Math.max(1, Math.min(24, Number(rec.frecuencia_valor) || 1));
    if (n === 1) return [LABORAL_DESDE];
    const paso = (LABORAL_HASTA - LABORAL_DESDE) / (n - 1);
    return Array.from({ length: n }, (_, i) => Math.round(LABORAL_DESDE + i * paso));
  }
  return [];
}

// --- Programación: ¿este recordatorio corresponde a este día? ---------------

function activoEnFecha(rec, fecha) {
  if (!rec.activo || rec.archivado) return false;
  if (rec.tipo_programacion === 'semanal') {
    return (rec.dias_semana || []).includes(diaSemanaDeFecha(fecha));
  }
  // 'unico' y 'hoy' son lo mismo una vez guardados: una fecha exacta.
  return rec.fecha_especifica === fecha;
}

// Próxima fecha (y horario) en que el recordatorio va a aparecer, para mostrarlo en
// Configuración. Es el dato de la PROGRAMACIÓN, no del estado de cada usuario: si hoy
// ya lo completó, igual se anuncia la próxima vez que el recordatorio se activa.
function proximaAparicion(rec, hoy, ahoraMin) {
  if (!rec.activo || rec.archivado) return { fecha: null, hora: null };
  const horarios = horariosDe(rec);

  // Primer horario del día que todavía no pasó; null = ya pasaron todos.
  const pendienteHoy = horarios.find(h => h > ahoraMin) ?? null;

  if (activoEnFecha(rec, hoy)) {
    // Sin horarios (una_vez / cada_x_horas) el próximo momento es "cuando entres".
    if (!horarios.length) return { fecha: hoy, hora: null };
    if (pendienteHoy !== null) return { fecha: hoy, hora: minutosAHhmm(pendienteHoy) };
  }

  if (rec.tipo_programacion === 'semanal') {
    const dias = rec.dias_semana || [];
    if (!dias.length) return { fecha: null, hora: null };
    for (let i = 1; i <= 7; i++) {
      const f = sumarDias(hoy, i);
      if (dias.includes(diaSemanaDeFecha(f))) {
        return { fecha: f, hora: horarios.length ? minutosAHhmm(horarios[0]) : null };
      }
    }
    return { fecha: null, hora: null };
  }

  // 'unico' / 'hoy' cuya fecha es futura.
  if (rec.fecha_especifica && rec.fecha_especifica > hoy) {
    return { fecha: rec.fecha_especifica, hora: horarios.length ? minutosAHhmm(horarios[0]) : null };
  }
  return { fecha: null, hora: null };
}

// A qué hora vuelve hoy si el usuario lo posterga ahora. Es lo que el popup anuncia
// junto a "Más tarde": sin esto nadie sabe qué está posponiendo. null = no vuelve hoy
// (ya pasaron todos sus horarios, o la espera cae después de medianoche).
function proximaVuelta(rec, ahoraMin) {
  const finDelDia = 24 * 60;
  if (rec.frecuencia_tipo === 'una_vez') {
    const m = ahoraMin + POSTERGAR_MS / 60000;
    return m < finDelDia ? minutosAHhmm(m) : null;
  }
  if (rec.frecuencia_tipo === 'cada_x_horas') {
    const horas = Math.max(1, Math.min(24, Number(rec.frecuencia_valor) || 1));
    const m = ahoraMin + horas * 60;
    return m < finDelDia ? minutosAHhmm(m) : null;
  }
  const sig = horariosDe(rec).find(h => h > ahoraMin);
  return sig != null ? minutosAHhmm(sig) : null;
}

// --- Frecuencia: ¿toca mostrarlo AHORA? -------------------------------------

/**
 * @param evento  estado de hoy para este usuario (null = todavía no se mostró)
 * @param motivo  'login' = primera consulta desde que se abrió la app. Fuerza la
 *                aparición salvo que ya esté completado (regla "siempre se muestra
 *                una vez al iniciar sesión"). 'intervalo' = tick del heartbeat.
 */
function tocaMostrar(rec, evento, { motivo, ahora, ahoraMin }) {
  if (!evento) return true;                          // primera aparición del día
  if (evento.accion === 'completado') return false;  // silenciado hasta mañana
  if (motivo === 'login') return true;

  const ahoraMs = ahora.getTime();
  const ultimaMs = Date.parse(evento.mostrado_at) || 0;

  if (rec.frecuencia_tipo === 'una_vez') {
    return evento.accion === 'postergado'
      && ahoraMs - (Date.parse(evento.accion_at) || ultimaMs) >= POSTERGAR_MS;
  }

  if (rec.frecuencia_tipo === 'cada_x_horas') {
    const horas = Math.max(1, Math.min(24, Number(rec.frecuencia_valor) || 1));
    return ahoraMs - ultimaMs >= horas * 60 * 60 * 1000;
  }

  // 'n_veces' y 'horarios_fijos': se reaparece al cruzar un horario nuevo, es decir
  // uno que ya llegó y que es posterior a la última vez que se mostró.
  const ultimaMin = evento.mostrado_at ? minutosDelDiaLocal(new Date(evento.mostrado_at)) : -1;
  return horariosDe(rec).some(h => h <= ahoraMin && h > ultimaMin);
}

// --- Saneado del payload ----------------------------------------------------

async function sanitizar(body = {}, { esAlta, user }) {
  const out = {};

  if (body.titulo !== undefined || esAlta) {
    const titulo = String(body.titulo || '').trim();
    if (!titulo) throw Object.assign(new Error('El título es obligatorio'), { statusCode: 400 });
    if (titulo.length > 120) throw Object.assign(new Error('El título no puede superar los 120 caracteres'), { statusCode: 400 });
    out.titulo = titulo;
  }
  if (body.mensaje !== undefined) out.mensaje = String(body.mensaje || '').trim().slice(0, 2000);

  if (body.tipo_programacion !== undefined || esAlta) {
    const tipo = body.tipo_programacion || 'hoy';
    if (!TIPOS_PROGRAMACION.includes(tipo)) {
      throw Object.assign(new Error(`tipo_programacion debe ser ${TIPOS_PROGRAMACION.join(', ')}`), { statusCode: 400 });
    }
    out.tipo_programacion = tipo;

    if (tipo === 'semanal') {
      const dias = [...new Set((body.dias_semana || []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
      if (!dias.length) throw Object.assign(new Error('Elegí al menos un día de la semana'), { statusCode: 400 });
      out.dias_semana = dias.sort();
      out.fecha_especifica = null;
    } else if (tipo === 'unico') {
      const f = String(body.fecha_especifica || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) throw Object.assign(new Error('Elegí la fecha del recordatorio'), { statusCode: 400 });
      out.fecha_especifica = f;
      out.dias_semana = [];
    } else {
      // 'hoy': la fecha la fija el servidor, no el cliente.
      out.fecha_especifica = hoyLocal();
      out.dias_semana = [];
    }
    // Reprogramarlo lo saca del archivo: si la fecha nueva no pasó, vuelve a servir.
    out.archivado = out.fecha_especifica != null && out.fecha_especifica < hoyLocal();
  }

  if (body.frecuencia_tipo !== undefined || esAlta) {
    const fr = body.frecuencia_tipo || 'una_vez';
    if (!TIPOS_FRECUENCIA.includes(fr)) {
      throw Object.assign(new Error(`frecuencia_tipo debe ser ${TIPOS_FRECUENCIA.join(', ')}`), { statusCode: 400 });
    }
    out.frecuencia_tipo = fr;

    if (fr === 'cada_x_horas' || fr === 'n_veces') {
      const v = Number(body.frecuencia_valor);
      if (!Number.isInteger(v) || v < 1 || v > 24) {
        throw Object.assign(new Error('La frecuencia debe ser un entero entre 1 y 24'), { statusCode: 400 });
      }
      out.frecuencia_valor = v;
      out.horarios = [];
    } else if (fr === 'horarios_fijos') {
      const hs = [...new Set((body.horarios || []).map(h => String(h).trim()).filter(h => hhmmAMinutos(h) !== null))];
      if (!hs.length) throw Object.assign(new Error('Agregá al menos un horario (HH:MM)'), { statusCode: 400 });
      out.horarios = hs.sort();
      out.frecuencia_valor = hs.length;
    } else {
      out.frecuencia_valor = 1;
      out.horarios = [];
    }
  }

  if (body.rubro_id !== undefined) {
    out.rubro_id = body.rubro_id === null || body.rubro_id === '' ? null : Number(body.rubro_id);
    if (out.rubro_id !== null && !Number.isInteger(out.rubro_id)) {
      throw Object.assign(new Error('rubro_id inválido'), { statusCode: 400 });
    }
    if (out.rubro_id === null) { out.subrubros_ids = []; out.subrubros_prioritarios_ids = []; }
  }
  if (body.subrubros_ids !== undefined) {
    out.subrubros_ids = [...new Set((body.subrubros_ids || []).map(Number).filter(Number.isInteger))];
  }
  if (body.subrubros_prioritarios_ids !== undefined || out.subrubros_ids) {
    // Los prioritarios siempre son un subconjunto de los vinculados: si un subrubro se
    // saca del recordatorio, su marca de prioridad se va con él en vez de quedar
    // apuntando a un chip que ya no existe.
    const previos = (body.subrubros_prioritarios_ids ?? []).map(Number).filter(Number.isInteger);
    const universo = out.subrubros_ids ?? null;
    out.subrubros_prioritarios_ids = [...new Set(
      universo ? previos.filter(id => universo.includes(id)) : previos
    )];
  }

  if (body.activo !== undefined) out.activo = Boolean(body.activo);

  // 'global' = todos · 'personal' = un único usuario. Un admin puede asignárselo a
  // cualquiera de los usuarios creados; si no elige ninguno, queda para él.
  if (body.alcance !== undefined || body.usuario_id !== undefined || esAlta) {
    const al = (body.alcance ?? (esAlta ? 'global' : undefined)) === 'personal' ? 'personal' : 'global';
    out.alcance = al;

    if (al === 'global') {
      out.usuario_id = null;
    } else {
      const sinElegir = body.usuario_id === undefined || body.usuario_id === null || body.usuario_id === '';
      const destinoId = sinElegir ? user?.userId : Number(body.usuario_id);
      if (!Number.isInteger(destinoId)) {
        throw Object.assign(new Error('Elegí a qué usuario va dirigido el recordatorio'), { statusCode: 400 });
      }
      const destino = await User.findById(destinoId, { usuario: 1 }).lean();
      if (!destino) throw Object.assign(new Error('El usuario elegido no existe'), { statusCode: 400 });
      out.usuario_id = destinoId;
    }
  }

  return out;
}

// Archiva los 'unico'/'hoy' cuya fecha ya pasó. Se hace acá, de forma perezosa, en vez
// de con un job programado: sin proceso de fondo la app no necesita un scheduler, y el
// costo es un updateMany sobre un índice en la primera consulta de cada día.
async function archivarVencidos(hoy) {
  await Recordatorio.updateMany(
    { archivado: false, tipo_programacion: { $in: ['unico', 'hoy'] }, fecha_especifica: { $ne: null, $lt: hoy } },
    { $set: { archivado: true, updated_at: nowTs() } }
  );
}

// Rubro + subrubros de un conjunto de recordatorios, con la misma forma que usa
// `/movimientos/vencimientos/proximos` para que el front pueda navegar con el mismo
// handler (onNavigate(rubro, subrubro)).
async function hidratarVinculos(recs) {
  const rubroIds = [...new Set(recs.map(r => r.rubro_id).filter(id => id != null))];
  const subIds = [...new Set(recs.flatMap(r => r.subrubros_ids || []))];
  if (!rubroIds.length && !subIds.length) return recs.map(r => ({ ...r, rubro: null, subrubros: [] }));

  const [rubros, subs] = await Promise.all([
    rubroIds.length ? Rubro.find({ _id: { $in: rubroIds } }).lean() : [],
    subIds.length ? Subrubro.find({ _id: { $in: subIds } }).lean() : [],
  ]);
  const rubroMap = new Map(rubros.map(r => [r._id, { ...r, id: r._id }]));
  const subMap = new Map(subs.map(s => [s._id, { ...s, id: s._id }]));

  return recs.map(r => {
    const prioritarios = new Set(r.subrubros_prioritarios_ids || []);
    return {
      ...r,
      rubro: r.rubro_id != null ? rubroMap.get(r.rubro_id) ?? null : null,
      // Un subrubro borrado desaparece de la lista en vez de romper el popup. Los
      // prioritarios van primero, ya resueltos acá: el front no tiene que reordenar.
      subrubros: (r.subrubros_ids || [])
        .map(id => subMap.get(id))
        .filter(Boolean)
        .map(s => ({ ...s, prioritario: prioritarios.has(s.id) }))
        .sort((a, b) => (b.prioritario === true) - (a.prioritario === true)),
    };
  });
}

// Agrega a cada recordatorio el estado del día de ESTE usuario: qué ítems del checklist
// ya están tildados y a qué hora vuelve si se posterga.
function conEstadoDelDia(recs, eventoDe, ahoraMin) {
  return recs.map(r => ({
    ...r,
    items_hechos: eventoDe.get(r._id ?? r.id)?.items_hechos || [],
    proxima_vuelta: proximaVuelta(r, ahoraMin),
  }));
}

// --- Rutas ------------------------------------------------------------------
// Crear/editar/borrar exige admin (o superadmin), igual que el resto de la
// configuración. Ver, completar y postergar los puede hacer cualquier usuario
// autenticado —incluido `viewer`—: son acciones sobre su propia vista, no mutaciones
// de datos de negocio.

// GET /api/recordatorios — listado para Configuración.
//
// Un admin ve TODOS, incluidos los dirigidos a otro usuario: es quien los crea y los
// tiene que poder editar después. Un viewer ve solo los que le aplican.
router.get('/', asyncHandler(async (req, res) => {
  const hoy = hoyLocal();
  await archivarVencidos(hoy);
  const ahoraMin = minutosDelDiaLocal();

  const esAdmin = req.user?.role === 'admin' || req.user?.role === 'superadmin';
  const filtro = esAdmin
    ? {}
    : { $or: [{ alcance: 'global' }, { alcance: 'personal', usuario_id: req.user?.userId ?? -1 }] };

  const docs = await Recordatorio.find(filtro).sort({ activo: -1, archivado: 1, _id: -1 }).lean();
  const hidratados = await hidratarVinculos(docs);

  // Nombre del destinatario, para que la lista diga "Solo cajero" y no "Solo #4".
  const destIds = [...new Set(docs.map(r => r.usuario_id).filter(id => id != null))];
  const usuarios = destIds.length ? await User.find({ _id: { $in: destIds } }, { usuario: 1 }).lean() : [];
  const nombreDe = new Map(usuarios.map(u => [u._id, u.usuario]));

  res.json(withIds(hidratados.map(r => {
    const { fecha, hora } = proximaAparicion(r, hoy, ahoraMin);
    return {
      ...r,
      proxima_fecha: fecha,
      proxima_hora: hora,
      usuario_nombre: r.usuario_id != null ? nombreDe.get(r.usuario_id) ?? null : null,
    };
  })));
}));

// GET /api/recordatorios/pendientes?motivo=login|intervalo
//
// Devuelve los que corresponde mostrar ahora mismo a ESTE usuario y, como efecto,
// registra la aparición en `RecordatorioEvento`. La escritura en un GET es
// deliberada: el tracking vive en la base (no en el navegador) y "mostrado" solo se
// puede saber en el momento de servirlo.
router.get('/pendientes', asyncHandler(async (req, res) => {
  const usuarioId = req.user?.userId;
  if (usuarioId == null) return res.json([]);

  const ahora = new Date();
  const hoy = hoyLocal(ahora);
  await archivarVencidos(hoy);

  const dow = diaSemanaLocal(ahora);
  const ahoraMin = minutosDelDiaLocal(ahora);
  const motivo = req.query.motivo === 'login' ? 'login' : 'intervalo';

  const candidatos = await Recordatorio.find({
    activo: true,
    archivado: false,
    $or: [{ alcance: 'global' }, { alcance: 'personal', usuario_id: usuarioId }],
  }).lean();

  const delDia = candidatos.filter(r =>
    r.tipo_programacion === 'semanal'
      ? (r.dias_semana || []).includes(dow)
      : r.fecha_especifica === hoy
  );
  if (!delDia.length) return res.json([]);

  const eventos = await RecordatorioEvento.find({
    recordatorio_id: { $in: delDia.map(r => r._id) },
    usuario_id: usuarioId,
    fecha: hoy,
  }).lean();
  const eventoDe = new Map(eventos.map(e => [e.recordatorio_id, e]));

  const aMostrar = delDia.filter(r => tocaMostrar(r, eventoDe.get(r._id), { motivo, ahora, ahoraMin }));
  if (!aMostrar.length) return res.json([]);

  const iso = ahora.toISOString();
  await Promise.all(aMostrar.map(r =>
    RecordatorioEvento.updateOne(
      { recordatorio_id: r._id, usuario_id: usuarioId, fecha: hoy },
      {
        $inc: { apariciones: 1 },
        $set: { mostrado_at: iso },
        $setOnInsert: { primera_aparicion_at: iso, accion: 'pendiente', accion_at: null },
      },
      { upsert: true }
    )
  ));

  const hidratados = await hidratarVinculos(aMostrar);
  res.json(withIds(conEstadoDelDia(hidratados, eventoDe, ahoraMin)));
}));

// GET /api/recordatorios/hoy
//
// Todos los recordatorios del día que este usuario todavía NO completó, sin importar
// la frecuencia. Es lo que abre el botón de la campana: un recordatorio sigue vivo
// todo el día y se puede consultar las veces que haga falta hasta que cumpla su
// propósito (se marque completado).
//
// A diferencia de /pendientes, NO escribe nada: mirarlo a mano no cuenta como
// aparición, así que no corre ni adelanta el próximo aviso automático.
router.get('/hoy', asyncHandler(async (req, res) => {
  const usuarioId = req.user?.userId;
  if (usuarioId == null) return res.json([]);

  const ahora = new Date();
  const hoy = hoyLocal(ahora);
  await archivarVencidos(hoy);
  const dow = diaSemanaLocal(ahora);

  const candidatos = await Recordatorio.find({
    activo: true,
    archivado: false,
    $or: [{ alcance: 'global' }, { alcance: 'personal', usuario_id: usuarioId }],
  }).lean();

  const delDia = candidatos.filter(r =>
    r.tipo_programacion === 'semanal'
      ? (r.dias_semana || []).includes(dow)
      : r.fecha_especifica === hoy
  );
  if (!delDia.length) return res.json([]);

  const eventos = await RecordatorioEvento.find({
    recordatorio_id: { $in: delDia.map(r => r._id) },
    usuario_id: usuarioId,
    fecha: hoy,
  }).lean();
  const eventoDe = new Map(eventos.map(e => [e.recordatorio_id, e]));

  const vivos = delDia.filter(r => eventoDe.get(r._id)?.accion !== 'completado');
  const hidratados = await hidratarVinculos(vivos);
  res.json(withIds(conEstadoDelDia(hidratados, eventoDe, minutosDelDiaLocal(ahora))));
}));

// GET /api/recordatorios/historial?dias=30 — qué se completó y qué se ignoró.
router.get('/historial', requireAdmin, asyncHandler(async (req, res) => {
  const dias = Math.max(1, Math.min(180, Number(req.query.dias) || 30));
  const hoy = hoyLocal();
  const desde = restarDias(hoy, dias);

  const eventos = await RecordatorioEvento.find({ fecha: { $gte: desde } })
    .sort({ fecha: -1 })
    .limit(500)
    .lean();
  if (!eventos.length) return res.json([]);

  const recs = await Recordatorio.find({ _id: { $in: [...new Set(eventos.map(e => e.recordatorio_id))] } },
    { titulo: 1 }).lean();
  const tituloDe = new Map(recs.map(r => [r._id, r.titulo]));

  res.json(eventos.map(e => ({
    id: String(e._id),
    recordatorio_id: e.recordatorio_id,
    titulo: tituloDe.get(e.recordatorio_id) || `#${e.recordatorio_id}`,
    usuario_id: e.usuario_id,
    fecha: e.fecha,
    apariciones: e.apariciones,
    mostrado_at: e.mostrado_at,
    // Un día YA PASADO que quedó sin completar es un ignorado. El día en curso todavía
    // puede resolverse, así que se informa tal cual está.
    estado: e.accion === 'completado'
      ? 'completado'
      : e.fecha < hoy ? 'ignorado' : e.accion,
  })));
}));

// POST /api/recordatorios — alta (admin).
router.post('/', requireAdmin, audit('recordatorio'), asyncHandler(async (req, res) => {
  const data = await sanitizar(req.body, { esAlta: true, user: req.user });
  const id = await Counter.next('recordatorios');
  const doc = await Recordatorio.create({
    _id: id,
    ...data,
    creado_por: req.user?.usuario || '',
    created_at: nowTs(),
    updated_at: nowTs(),
  });
  res.json(withId(doc.toObject()));
}));

// PUT /api/recordatorios/:id — edición (admin). Incluye pausar/activar.
router.put('/:id', requireAdmin, audit('recordatorio'), asyncHandler(async (req, res) => {
  const data = await sanitizar(req.body, { esAlta: false, user: req.user });
  const doc = await Recordatorio.findByIdAndUpdate(
    Number(req.params.id),
    { $set: { ...data, updated_at: nowTs() } },
    { new: true }
  ).lean();
  if (!doc) return res.status(404).json({ error: 'Recordatorio no encontrado' });
  res.json(withId(doc));
}));

// DELETE /api/recordatorios/:id — borra el recordatorio y su historial (admin).
router.delete('/:id', requireAdmin, audit('recordatorio'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const doc = await Recordatorio.findByIdAndDelete(id).lean();
  if (!doc) return res.status(404).json({ error: 'Recordatorio no encontrado' });
  await RecordatorioEvento.deleteMany({ recordatorio_id: id });
  res.json({ ok: true });
}));

// Marca la acción del usuario sobre el recordatorio para el día de HOY. Upsert: cubre
// el caso de completar algo que se está viendo desde otra pestaña.
async function registrarAccion(req, res, accion) {
  const usuarioId = req.user?.userId;
  if (usuarioId == null) return res.status(401).json({ error: 'No autorizado' });

  const id = Number(req.params.id);
  const rec = await Recordatorio.findById(id).lean();
  if (!rec) return res.status(404).json({ error: 'Recordatorio no encontrado' });

  const ahora = new Date();
  const iso = ahora.toISOString();
  const hoy = hoyLocal(ahora);

  await RecordatorioEvento.updateOne(
    { recordatorio_id: id, usuario_id: usuarioId, fecha: hoy },
    {
      $set: { accion, accion_at: iso, mostrado_at: iso },
      $setOnInsert: { primera_aparicion_at: iso },
    },
    { upsert: true }
  );
  res.json({ ok: true, accion, fecha: hoy });
}

// POST /api/recordatorios/:id/item  { subrubro_id, hecho }
//
// Tilda (o destilda) un subrubro del checklist para el día de hoy. El estado es por
// usuario y por día: mañana el recordatorio arranca limpio sin que nadie tenga que
// borrar nada. Devuelve la lista completa para que el front no tenga que adivinarla.
router.post('/:id/item', asyncHandler(async (req, res) => {
  const usuarioId = req.user?.userId;
  if (usuarioId == null) return res.status(401).json({ error: 'No autorizado' });

  const id = Number(req.params.id);
  const subrubroId = Number(req.body?.subrubro_id);
  if (!Number.isInteger(subrubroId)) return res.status(400).json({ error: 'subrubro_id inválido' });

  const rec = await Recordatorio.findById(id).lean();
  if (!rec) return res.status(404).json({ error: 'Recordatorio no encontrado' });
  if (!(rec.subrubros_ids || []).includes(subrubroId)) {
    return res.status(400).json({ error: 'Ese subrubro no pertenece al recordatorio' });
  }

  const iso = new Date().toISOString();
  const hoy = hoyLocal();
  const filtro = { recordatorio_id: id, usuario_id: usuarioId, fecha: hoy };
  const marca = Boolean(req.body?.hecho);

  const ev = await RecordatorioEvento.findOneAndUpdate(
    filtro,
    {
      ...(marca ? { $addToSet: { items_hechos: subrubroId } } : { $pull: { items_hechos: subrubroId } }),
      $setOnInsert: { primera_aparicion_at: iso, mostrado_at: iso, accion: 'pendiente', accion_at: null },
    },
    { upsert: true, returnDocument: 'after' }
  ).lean();

  res.json({ ok: true, items_hechos: ev?.items_hechos || [] });
}));

// POST /api/recordatorios/:id/completar — no vuelve a aparecer hasta mañana.
router.post('/:id/completar', asyncHandler((req, res) => registrarAccion(req, res, 'completado')));

// POST /api/recordatorios/:id/postergar — reaparece en el próximo intervalo.
router.post('/:id/postergar', asyncHandler((req, res) => registrarAccion(req, res, 'postergado')));

module.exports = router;
module.exports._internals = { horariosDe, tocaMostrar, activoEnFecha, proximaAparicion, proximaVuelta, hhmmAMinutos, minutosAHhmm };
