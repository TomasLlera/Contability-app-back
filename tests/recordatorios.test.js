const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Recordatorio, RecordatorioEvento } = require('../models');
const { hoyLocal, diaSemanaLocal, sumarDias, restarDias } = require('../utils/tz');

setupTestDb();

let adminToken, viewerToken, adminId, viewerId, rubroId, subA, subB;

async function mkUser(usuario, role) {
  const id = await Counter.next('users');
  await User.create({ _id: id, usuario, password_hash: await bcrypt.hash('clave123', 4), role, activo: true });
  return { id, token: jwt.sign({ usuario, role, userId: id }, process.env.JWT_SECRET, { expiresIn: '7d' }) };
}

async function bootstrap() {
  ({ id: adminId, token: adminToken } = await mkUser('jefe', 'admin'));
  ({ id: viewerId, token: viewerToken } = await mkUser('cajero', 'viewer'));

  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'Local', icon: '🏠' });
  rubroId = await Counter.next('rubros');
  await Rubro.create({ _id: rubroId, nombre: 'Proveedores', local_id: lid });
  subA = await Counter.next('subrubros');
  await Subrubro.create({ _id: subA, rubro_id: rubroId, nombre: 'Coca Cola' });
  subB = await Counter.next('subrubros');
  await Subrubro.create({ _id: subB, rubro_id: rubroId, nombre: 'La Galletera' });
}

const crear = (token, body) =>
  request(app).post('/api/recordatorios').set('Authorization', `Bearer ${token}`).send(body);

const pendientes = (token, motivo = 'login') =>
  request(app).get('/api/recordatorios/pendientes').query({ motivo }).set('Authorization', `Bearer ${token}`);

beforeEach(bootstrap);

describe('Recordatorios · CRUD y permisos', () => {
  it('un admin crea un recordatorio semanal con subrubros vinculados', async () => {
    const res = await crear(adminToken, {
      titulo: 'Hacer pedidos',
      mensaje: 'Hoy hay que hacer pedidos a los siguientes proveedores:',
      tipo_programacion: 'semanal',
      dias_semana: [1, 4],
      frecuencia_tipo: 'una_vez',
      rubro_id: rubroId,
      subrubros_ids: [subA, subB],
      alcance: 'global',
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeGreaterThan(0);
    expect(res.body.dias_semana).toEqual([1, 4]);
    expect(res.body.creado_por).toBe('jefe');
  });

  it('un viewer no puede crear recordatorios (403)', async () => {
    const res = await crear(viewerToken, { titulo: 'No debería', tipo_programacion: 'hoy' });
    expect(res.status).toBe(403);
  });

  it('rechaza un semanal sin días elegidos (400)', async () => {
    const res = await crear(adminToken, { titulo: 'Sin días', tipo_programacion: 'semanal', dias_semana: [] });
    expect(res.status).toBe(400);
  });

  it('rechaza horarios fijos inválidos y acepta los válidos ordenados', async () => {
    const malo = await crear(adminToken, { titulo: 'X', tipo_programacion: 'hoy', frecuencia_tipo: 'horarios_fijos', horarios: ['99:99'] });
    expect(malo.status).toBe(400);

    const bueno = await crear(adminToken, { titulo: 'X', tipo_programacion: 'hoy', frecuencia_tipo: 'horarios_fijos', horarios: ['18:00', '09:00', '13:00'] });
    expect(bueno.status).toBe(200);
    expect(bueno.body.horarios).toEqual(['09:00', '13:00', '18:00']);
  });

  it('un personal sin destinatario queda para su creador', async () => {
    const { body } = await crear(adminToken, { titulo: 'Mío', tipo_programacion: 'hoy', alcance: 'personal' });
    expect(body.usuario_id).toBe(adminId);

    const ajenos = await request(app).get('/api/recordatorios').set('Authorization', `Bearer ${viewerToken}`);
    expect(ajenos.body.map(r => r.titulo)).not.toContain('Mío');
    expect(await pendientes(viewerToken).then(r => r.body)).toHaveLength(0);
  });

  it('un admin se lo puede asignar a otro usuario creado', async () => {
    const { body } = await crear(adminToken, {
      titulo: 'Para el cajero', tipo_programacion: 'hoy', alcance: 'personal', usuario_id: viewerId,
    });
    expect(body.usuario_id).toBe(viewerId);

    // Le llega al destinatario, no al admin que lo creó.
    expect(await pendientes(viewerToken).then(r => r.body.map(x => x.titulo))).toEqual(['Para el cajero']);
    expect(await pendientes(adminToken).then(r => r.body)).toHaveLength(0);
  });

  it('el admin sigue viendo (y pudiendo editar) los que asignó a otros', async () => {
    await crear(adminToken, { titulo: 'Ajeno', tipo_programacion: 'hoy', alcance: 'personal', usuario_id: viewerId });
    const lista = await request(app).get('/api/recordatorios').set('Authorization', `Bearer ${adminToken}`);
    const item = lista.body.find(r => r.titulo === 'Ajeno');
    expect(item).toBeTruthy();
    expect(item.usuario_nombre).toBe('cajero');
  });

  it('rechaza un destinatario inexistente (400)', async () => {
    const res = await crear(adminToken, { titulo: 'Fantasma', tipo_programacion: 'hoy', alcance: 'personal', usuario_id: 99999 });
    expect(res.status).toBe(400);
  });

  it('borrar el recordatorio borra su historial de eventos', async () => {
    const { body } = await crear(adminToken, { titulo: 'Efímero', tipo_programacion: 'hoy' });
    await pendientes(adminToken);
    expect(await RecordatorioEvento.countDocuments({ recordatorio_id: body.id })).toBe(1);

    const del = await request(app).delete(`/api/recordatorios/${body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    expect(await RecordatorioEvento.countDocuments({ recordatorio_id: body.id })).toBe(0);
  });
});

describe('Recordatorios · programación semanal', () => {
  it('NO aparece en un día que no corresponde', async () => {
    // Todos los días MENOS hoy.
    const otrosDias = [0, 1, 2, 3, 4, 5, 6].filter(d => d !== diaSemanaLocal());
    await crear(adminToken, { titulo: 'Otro día', tipo_programacion: 'semanal', dias_semana: otrosDias });

    const res = await pendientes(adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('SÍ aparece el día que corresponde, con rubro y subrubros hidratados', async () => {
    await crear(adminToken, {
      titulo: 'Hacer pedidos',
      tipo_programacion: 'semanal',
      dias_semana: [diaSemanaLocal()],
      rubro_id: rubroId,
      subrubros_ids: [subA, subB],
    });

    const res = await pendientes(adminToken);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].titulo).toBe('Hacer pedidos');
    expect(res.body[0].rubro.id).toBe(rubroId);
    expect(res.body[0].subrubros.map(s => s.nombre)).toEqual(['Coca Cola', 'La Galletera']);
  });

  it('un subrubro borrado se cae de la lista sin romper el popup', async () => {
    await crear(adminToken, {
      titulo: 'Con hueco', tipo_programacion: 'semanal', dias_semana: [diaSemanaLocal()],
      rubro_id: rubroId, subrubros_ids: [subA, subB],
    });
    await Subrubro.deleteOne({ _id: subB });

    const res = await pendientes(adminToken);
    expect(res.body[0].subrubros.map(s => s.id)).toEqual([subA]);
  });
});

describe('Recordatorios · "Completado" silencia hasta el día siguiente', () => {
  it('completar lo saca de pendientes aun al reiniciar sesión el mismo día', async () => {
    const { body } = await crear(adminToken, {
      titulo: 'Controlar caja', tipo_programacion: 'hoy', frecuencia_tipo: 'cada_x_horas', frecuencia_valor: 1,
    });

    expect(await pendientes(adminToken).then(r => r.body)).toHaveLength(1);

    const comp = await request(app).post(`/api/recordatorios/${body.id}/completar`).set('Authorization', `Bearer ${adminToken}`);
    expect(comp.status).toBe(200);

    // motivo=login simula cerrar y volver a abrir sesión: sigue silenciado.
    expect(await pendientes(adminToken, 'login').then(r => r.body)).toHaveLength(0);
    expect(await pendientes(adminToken, 'intervalo').then(r => r.body)).toHaveLength(0);
  });

  it('completarlo un usuario no lo silencia para otro', async () => {
    // Semanal de hoy para que ambos usuarios lo tengan activo.
    const { body } = await crear(adminToken, { titulo: 'Compartido', tipo_programacion: 'semanal', dias_semana: [diaSemanaLocal()] });
    await request(app).post(`/api/recordatorios/${body.id}/completar`).set('Authorization', `Bearer ${adminToken}`);

    expect(await pendientes(adminToken).then(r => r.body)).toHaveLength(0);
    expect(await pendientes(viewerToken).then(r => r.body)).toHaveLength(1);
  });

  it('el evento de AYER no silencia el día de hoy', async () => {
    const { body } = await crear(adminToken, { titulo: 'Diario', tipo_programacion: 'semanal', dias_semana: [diaSemanaLocal()] });
    await RecordatorioEvento.create({
      recordatorio_id: body.id, usuario_id: adminId, fecha: restarDias(hoyLocal(), 1),
      accion: 'completado', mostrado_at: new Date().toISOString(), apariciones: 1,
    });

    expect(await pendientes(adminToken).then(r => r.body)).toHaveLength(1);
  });
});

describe('Recordatorios · frecuencia dentro del día', () => {
  it("'una_vez' no reaparece en el tick de intervalo", async () => {
    await crear(adminToken, { titulo: 'Solo al entrar', tipo_programacion: 'hoy', frecuencia_tipo: 'una_vez' });

    expect(await pendientes(adminToken, 'login').then(r => r.body)).toHaveLength(1);
    expect(await pendientes(adminToken, 'intervalo').then(r => r.body)).toHaveLength(0);
  });

  it("'una_vez' postergado vuelve recién después de una hora", async () => {
    const { body } = await crear(adminToken, { titulo: 'Más tarde', tipo_programacion: 'hoy', frecuencia_tipo: 'una_vez' });
    await pendientes(adminToken, 'login');
    await request(app).post(`/api/recordatorios/${body.id}/postergar`).set('Authorization', `Bearer ${adminToken}`);

    expect(await pendientes(adminToken, 'intervalo').then(r => r.body)).toHaveLength(0);

    // Se retrasa la marca de postergación 61 minutos.
    const hace61 = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    await RecordatorioEvento.updateOne(
      { recordatorio_id: body.id, usuario_id: adminId },
      { $set: { accion_at: hace61, mostrado_at: hace61 } }
    );
    expect(await pendientes(adminToken, 'intervalo').then(r => r.body)).toHaveLength(1);
  });

  it("'cada_x_horas' respeta el intervalo", async () => {
    const { body } = await crear(adminToken, {
      titulo: 'Cada 3h', tipo_programacion: 'hoy', frecuencia_tipo: 'cada_x_horas', frecuencia_valor: 3,
    });
    await pendientes(adminToken, 'login');
    expect(await pendientes(adminToken, 'intervalo').then(r => r.body)).toHaveLength(0);

    await RecordatorioEvento.updateOne(
      { recordatorio_id: body.id, usuario_id: adminId },
      { $set: { mostrado_at: new Date(Date.now() - 3.1 * 3600 * 1000).toISOString() } }
    );
    expect(await pendientes(adminToken, 'intervalo').then(r => r.body)).toHaveLength(1);
  });

  it("el login siempre lo muestra, aunque la frecuencia todavía no lo pida", async () => {
    await crear(adminToken, { titulo: 'Al entrar', tipo_programacion: 'hoy', frecuencia_tipo: 'cada_x_horas', frecuencia_valor: 12 });
    await pendientes(adminToken, 'login');
    expect(await pendientes(adminToken, 'intervalo').then(r => r.body)).toHaveLength(0);
    expect(await pendientes(adminToken, 'login').then(r => r.body)).toHaveLength(1);
  });

  it('cuenta las apariciones en el evento del día', async () => {
    const { body } = await crear(adminToken, { titulo: 'Contador', tipo_programacion: 'hoy' });
    await pendientes(adminToken, 'login');
    await pendientes(adminToken, 'login');
    const ev = await RecordatorioEvento.findOne({ recordatorio_id: body.id, usuario_id: adminId }).lean();
    expect(ev.apariciones).toBe(2);
  });
});

describe('Recordatorios · archivado automático del día único', () => {
  it('un único con fecha pasada se archiva solo y deja de aparecer', async () => {
    const ayer = restarDias(hoyLocal(), 1);
    const { body } = await crear(adminToken, { titulo: 'Vencido', tipo_programacion: 'unico', fecha_especifica: ayer });
    // La propia alta ya lo marca archivado por tener fecha pasada.
    expect(body.archivado).toBe(true);

    // Se fuerza a no archivado para comprobar que el barrido perezoso lo archiva.
    await Recordatorio.updateOne({ _id: body.id }, { $set: { archivado: false } });
    expect(await pendientes(adminToken).then(r => r.body)).toHaveLength(0);
    expect((await Recordatorio.findById(body.id).lean()).archivado).toBe(true);
  });

  it('un único de mañana no aparece hoy, pero no se archiva', async () => {
    const mañana = sumarDias(hoyLocal(), 1);
    const { body } = await crear(adminToken, { titulo: 'Futuro', tipo_programacion: 'unico', fecha_especifica: mañana });
    expect(body.archivado).toBe(false);

    expect(await pendientes(adminToken).then(r => r.body)).toHaveLength(0);
    expect((await Recordatorio.findById(body.id).lean()).archivado).toBe(false);

    const lista = await request(app).get('/api/recordatorios').set('Authorization', `Bearer ${adminToken}`);
    expect(lista.body.find(r => r.id === body.id).proxima_fecha).toBe(mañana);
  });

  it('un único de HOY aparece y sobrevive al barrido', async () => {
    await crear(adminToken, { titulo: 'De hoy', tipo_programacion: 'unico', fecha_especifica: hoyLocal() });
    expect(await pendientes(adminToken).then(r => r.body)).toHaveLength(1);
  });

  it('pausar lo saca de pendientes sin borrarlo', async () => {
    const { body } = await crear(adminToken, { titulo: 'Pausable', tipo_programacion: 'hoy' });
    await request(app).put(`/api/recordatorios/${body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ activo: false });

    expect(await pendientes(adminToken).then(r => r.body)).toHaveLength(0);
    const lista = await request(app).get('/api/recordatorios').set('Authorization', `Bearer ${adminToken}`);
    expect(lista.body.find(r => r.id === body.id).activo).toBe(false);
  });
});

describe('Recordatorios · consulta manual (botón de la campana)', () => {
  const hoyDia = (token) => request(app).get('/api/recordatorios/hoy').set('Authorization', `Bearer ${token}`);

  it('devuelve los del día las veces que haga falta, sin importar la frecuencia', async () => {
    await crear(adminToken, { titulo: 'Hacer pedidos', tipo_programacion: 'hoy', frecuencia_tipo: 'una_vez' });
    await pendientes(adminToken, 'login');   // ya se mostró: /pendientes no lo devuelve más

    expect(await pendientes(adminToken, 'intervalo').then(r => r.body)).toHaveLength(0);
    expect(await hoyDia(adminToken).then(r => r.body)).toHaveLength(1);
    expect(await hoyDia(adminToken).then(r => r.body)).toHaveLength(1);
  });

  it('no registra apariciones ni corre el próximo aviso automático', async () => {
    const { body } = await crear(adminToken, { titulo: 'Sin huella', tipo_programacion: 'hoy' });
    await hoyDia(adminToken);
    await hoyDia(adminToken);
    expect(await RecordatorioEvento.countDocuments({ recordatorio_id: body.id })).toBe(0);
    // El automático sigue intacto: la primera aparición real todavía no ocurrió.
    expect(await pendientes(adminToken, 'intervalo').then(r => r.body)).toHaveLength(1);
  });

  it('deja de devolverlo una vez completado', async () => {
    const { body } = await crear(adminToken, { titulo: 'Cumplido', tipo_programacion: 'hoy' });
    expect(await hoyDia(adminToken).then(r => r.body)).toHaveLength(1);

    await request(app).post(`/api/recordatorios/${body.id}/completar`).set('Authorization', `Bearer ${adminToken}`);
    expect(await hoyDia(adminToken).then(r => r.body)).toHaveLength(0);
  });

  it('un viewer puede consultarlo (es su propia vista, no una mutación)', async () => {
    await crear(adminToken, { titulo: 'Para todos', tipo_programacion: 'semanal', dias_semana: [diaSemanaLocal()] });
    const res = await hoyDia(viewerToken);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('ignora los pausados y los de otro día', async () => {
    const { body } = await crear(adminToken, { titulo: 'Pausado', tipo_programacion: 'hoy' });
    await request(app).put(`/api/recordatorios/${body.id}`).set('Authorization', `Bearer ${adminToken}`).send({ activo: false });
    await crear(adminToken, { titulo: 'Mañana', tipo_programacion: 'unico', fecha_especifica: sumarDias(hoyLocal(), 1) });

    expect(await hoyDia(adminToken).then(r => r.body)).toHaveLength(0);
  });
});

describe('Recordatorios · checklist de subrubros', () => {
  const marcar = (id, subrubro_id, hecho) =>
    request(app).post(`/api/recordatorios/${id}/item`).set('Authorization', `Bearer ${adminToken}`).send({ subrubro_id, hecho });

  const crearConSubs = () => crear(adminToken, {
    titulo: 'Hacer pedidos', tipo_programacion: 'hoy',
    rubro_id: rubroId, subrubros_ids: [subA, subB], subrubros_prioritarios_ids: [subB],
  });

  it('guarda los prioritarios y los devuelve primero', async () => {
    const { body } = await crearConSubs();
    expect(body.subrubros_prioritarios_ids).toEqual([subB]);

    const [rec] = await pendientes(adminToken).then(r => r.body);
    expect(rec.subrubros.map(s => s.id)).toEqual([subB, subA]);   // el prioritario primero
    expect(rec.subrubros.find(s => s.id === subB).prioritario).toBe(true);
    expect(rec.subrubros.find(s => s.id === subA).prioritario).toBe(false);
  });

  it('descarta prioritarios que no estén entre los subrubros vinculados', async () => {
    const { body } = await crear(adminToken, {
      titulo: 'X', tipo_programacion: 'hoy',
      rubro_id: rubroId, subrubros_ids: [subA], subrubros_prioritarios_ids: [subA, subB],
    });
    expect(body.subrubros_prioritarios_ids).toEqual([subA]);
  });

  it('tilda y destilda un ítem, y persiste entre consultas', async () => {
    const { body } = await crearConSubs();

    const on = await marcar(body.id, subA, true);
    expect(on.status).toBe(200);
    expect(on.body.items_hechos).toEqual([subA]);

    const [rec] = await request(app).get('/api/recordatorios/hoy').set('Authorization', `Bearer ${adminToken}`).then(r => r.body);
    expect(rec.items_hechos).toEqual([subA]);

    const off = await marcar(body.id, subA, false);
    expect(off.body.items_hechos).toEqual([]);
  });

  it('tildar dos veces el mismo ítem no lo duplica', async () => {
    const { body } = await crearConSubs();
    await marcar(body.id, subA, true);
    const res = await marcar(body.id, subA, true);
    expect(res.body.items_hechos).toEqual([subA]);
  });

  it('rechaza un subrubro que no pertenece al recordatorio (400)', async () => {
    const { body } = await crear(adminToken, { titulo: 'Sin ese', tipo_programacion: 'hoy', rubro_id: rubroId, subrubros_ids: [subA] });
    const res = await marcar(body.id, subB, true);
    expect(res.status).toBe(400);
  });

  it('el checklist es por usuario y por día', async () => {
    const { body } = await crear(adminToken, {
      titulo: 'Compartido', tipo_programacion: 'semanal', dias_semana: [diaSemanaLocal()],
      rubro_id: rubroId, subrubros_ids: [subA, subB],
    });
    await marcar(body.id, subA, true);

    const [delViewer] = await request(app).get('/api/recordatorios/hoy').set('Authorization', `Bearer ${viewerToken}`).then(r => r.body);
    expect(delViewer.items_hechos).toEqual([]);

    // El de ayer tampoco lo contamina.
    await RecordatorioEvento.create({
      recordatorio_id: body.id, usuario_id: adminId, fecha: restarDias(hoyLocal(), 1), items_hechos: [subA, subB],
    });
    const [deHoy] = await request(app).get('/api/recordatorios/hoy').set('Authorization', `Bearer ${adminToken}`).then(r => r.body);
    expect(deHoy.items_hechos).toEqual([subA]);
  });
});

// La hora de vuelta se prueba como unidad, con la hora del día pasada a mano: atada al
// reloj real, el mismo test pasa de día y falla a medianoche.
describe('Recordatorios · hora de vuelta (unitario)', () => {
  const { proximaVuelta } = require('../routes/recordatorios')._internals;
  const HH = (h, m = 0) => h * 60 + m;

  it("'horarios_fijos' devuelve el próximo horario posterior a la hora actual", () => {
    const rec = { frecuencia_tipo: 'horarios_fijos', horarios: ['09:00', '13:00', '18:00'] };
    expect(proximaVuelta(rec, HH(8, 30))).toBe('09:00');
    expect(proximaVuelta(rec, HH(9))).toBe('13:00');      // el de las 9 ya se consumió
    expect(proximaVuelta(rec, HH(14))).toBe('18:00');
    expect(proximaVuelta(rec, HH(18))).toBe(null);        // no vuelve más hoy
  });

  it("'cada_x_horas' suma el intervalo, y devuelve null si cruza la medianoche", () => {
    const rec = { frecuencia_tipo: 'cada_x_horas', frecuencia_valor: 3 };
    expect(proximaVuelta(rec, HH(10, 15))).toBe('13:15');
    expect(proximaVuelta(rec, HH(22))).toBe(null);
  });

  it("'una_vez' vuelve una hora después", () => {
    const rec = { frecuencia_tipo: 'una_vez' };
    expect(proximaVuelta(rec, HH(11, 40))).toBe('12:40');
    expect(proximaVuelta(rec, HH(23, 30))).toBe(null);
  });

  it("'n_veces' reparte entre las 08:00 y las 15:00", () => {
    const rec = { frecuencia_tipo: 'n_veces', frecuencia_valor: 3 };
    expect(proximaVuelta(rec, HH(7))).toBe('08:00');
    expect(proximaVuelta(rec, HH(9))).toBe('11:30');
    expect(proximaVuelta(rec, HH(12))).toBe('15:00');
    expect(proximaVuelta(rec, HH(16))).toBe(null);
  });

  it('la API la expone junto a los pendientes', async () => {
    await crear(adminToken, { titulo: 'Cada 2h', tipo_programacion: 'hoy', frecuencia_tipo: 'cada_x_horas', frecuencia_valor: 2 });
    const [rec] = await pendientes(adminToken).then(r => r.body);
    expect(rec.proxima_vuelta === null || /^\d{2}:\d{2}$/.test(rec.proxima_vuelta)).toBe(true);
  });
});

describe('Recordatorios · historial', () => {
  it('marca completado, y como ignorado lo que quedó pendiente un día pasado', async () => {
    const { body } = await crear(adminToken, { titulo: 'Con historia', tipo_programacion: 'semanal', dias_semana: [diaSemanaLocal()] });
    await pendientes(adminToken, 'login');
    await request(app).post(`/api/recordatorios/${body.id}/completar`).set('Authorization', `Bearer ${adminToken}`);
    await RecordatorioEvento.create({
      recordatorio_id: body.id, usuario_id: viewerId, fecha: restarDias(hoyLocal(), 2),
      accion: 'pendiente', mostrado_at: new Date().toISOString(), apariciones: 3,
    });

    const res = await request(app).get('/api/recordatorios/historial').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const estados = res.body.map(e => e.estado);
    expect(estados).toContain('completado');
    expect(estados).toContain('ignorado');
    expect(res.body.every(e => e.titulo === 'Con historia')).toBe(true);
  });

  it('un viewer no puede leer el historial (403)', async () => {
    const res = await request(app).get('/api/recordatorios/historial').set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });
});
