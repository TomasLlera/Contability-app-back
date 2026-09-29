const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Movimiento, CajaMovimiento, CajaConfig } = require('../models');
const { hoyLocal, sumarDias } = require('../utils/tz');

setupTestDb();

let token, subrubroId;
const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const hoy = () => hoyLocal();
const dia = (n) => sumarDias(hoyLocal(), n);

async function bootstrap({ diasAnticipacion = 0 } = {}) {
  const hash = await bcrypt.hash('admin123', 4);
  await User.create({ _id: await Counter.next('users'), usuario: 'admin', password_hash: hash, role: 'admin', activo: true });
  token = (await request(app).post('/api/auth/login').send({ usuario: 'admin', password: 'admin123' })).body.token;
  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'L' });
  const rubroId = await Counter.next('rubros');
  await Rubro.create({ _id: rubroId, nombre: 'R', local_id: lid });
  subrubroId = await Counter.next('subrubros');
  await Subrubro.create({ _id: subrubroId, rubro_id: rubroId, nombre: 'Proveedor', monto_base: 0 });
  await CajaConfig.create({ _id: 'main', empleados: [], proveedores: [], rubros_sync: [rubroId], dias_anticipacion_caja: diasAnticipacion });
}

// Factura con vencimiento en `vencDias` (negativo = vencida) y su ítem de Caja
// auto-sincronizado, ya con método para poder confirmarlo.
async function facturaEnCaja(vencDias, monto = 1000) {
  const fecha = dia(Math.min(vencDias, 0) - 5);
  const f = await auth(request(app).post(`/api/movimientos/${subrubroId}`))
    .send({ tipo: 'factura', monto, fecha, fecha_vencimiento: dia(vencDias), metodo_pago: 'efectivo' });
  expect(f.status).toBe(200);
  await auth(request(app).post('/api/caja/auto-sync').query({ fecha: hoy() }));
  const item = await CajaMovimiento.findOne({ movimiento_id: f.body.id }).lean();
  expect(item).toBeTruthy();
  return { facturaId: f.body.id, cajaId: item._id };
}

const cajaDelDia = async (fecha) => (await auth(request(app).get('/api/caja').query({ fecha }))).body;

describe('Confirmar en Caja: la fecha del pago es la real, nunca una futura', () => {
  beforeEach(() => bootstrap());

  it('un pendiente vencido hace 10 días confirmado sin fecha queda HOY en Caja y en el subrubro', async () => {
    const { facturaId, cajaId } = await facturaEnCaja(-10);
    const res = await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({});
    expect(res.status).toBe(200);

    const item = await CajaMovimiento.findById(cajaId).lean();
    const pago = await Movimiento.findById(res.body.pago_mov_id).lean();
    expect(item.fecha).toBe(hoy());
    expect(pago.fecha).toBe(hoy());
    expect((await Movimiento.findById(facturaId).lean()).pagado).toBe(true);
    expect((await cajaDelDia(hoy())).some(c => c.id === cajaId && c.confirmado === true)).toBe(true);
  });

  it('confirmar mirando un día futuro se rechaza y no registra nada', async () => {
    const { facturaId, cajaId } = await facturaEnCaja(-10);
    const res = await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ fecha: dia(1) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fecha futura/);

    expect((await CajaMovimiento.findById(cajaId).lean()).confirmado).toBe(false);
    expect(await Movimiento.countDocuments({ tipo: 'pago' })).toBe(0);
    expect((await Movimiento.findById(facturaId).lean()).pagado).toBe(false);
  });

  it('una fecha pasada explícita se respeta (el front la pide con confirmación)', async () => {
    const { cajaId } = await facturaEnCaja(-10);
    const res = await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ fecha: dia(-2) });
    expect(res.status).toBe(200);
    expect((await CajaMovimiento.findById(cajaId).lean()).fecha).toBe(dia(-2));
    expect((await Movimiento.findById(res.body.pago_mov_id).lean()).fecha).toBe(dia(-2));
  });

  it('una fecha inexistente o mal formada se rechaza', async () => {
    const { cajaId } = await facturaEnCaja(-10);
    for (const fecha of ['2026-02-30', '29/09/2026', 'hoy']) {
      const res = await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ fecha });
      expect(res.status).toBe(400);
    }
    expect((await CajaMovimiento.findById(cajaId).lean()).confirmado).toBe(false);
  });

  it('GET /caja rechaza una fecha inválida (antes respondía 500 con un operador $)', async () => {
    const res = await auth(request(app).get('/api/caja').query({ 'fecha[$gt]': '' }));
    expect(res.status).toBe(400);
  });

  it('hoyLocal usa la hora de Argentina: 22:30 del 29/09 sigue siendo el 29/09', () => {
    expect(hoyLocal(new Date('2026-09-30T01:30:00Z'))).toBe('2026-09-29');
  });
});

describe('Próximos vencimientos: se pagan desde hoy, sin navegar a su fecha', () => {
  beforeEach(() => bootstrap({ diasAnticipacion: 0 }));

  it('un vencimiento de dentro de 3 días aparece en /proximos (aunque la anticipación sea 0) y no en el día', async () => {
    const { cajaId } = await facturaEnCaja(3);
    expect((await cajaDelDia(hoy())).some(c => c.id === cajaId)).toBe(false);

    const prox = await auth(request(app).get('/api/caja/proximos').query({ fecha: hoy() }));
    expect(prox.status).toBe(200);
    expect(prox.body.map(c => c.id)).toContain(cajaId);
  });

  it('confirmarlo desde hoy lo registra hoy y pasa a la Caja del día', async () => {
    const { cajaId } = await facturaEnCaja(3);
    const res = await auth(request(app).post(`/api/caja/${cajaId}/confirmar`)).send({ fecha: hoy() });
    expect(res.status).toBe(200);
    expect((await CajaMovimiento.findById(cajaId).lean()).fecha).toBe(hoy());
    expect((await cajaDelDia(hoy())).some(c => c.id === cajaId)).toBe(true);
    const prox = await auth(request(app).get('/api/caja/proximos').query({ fecha: hoy() }));
    expect(prox.body.map(c => c.id)).not.toContain(cajaId);
  });

  it('lo que vence fuera de la ventana no genera ítem ni aparece en próximos', async () => {
    const f = await auth(request(app).post(`/api/movimientos/${subrubroId}`))
      .send({ tipo: 'factura', monto: 1000, fecha: dia(-1), fecha_vencimiento: dia(20), metodo_pago: 'efectivo' });
    await auth(request(app).post('/api/caja/auto-sync').query({ fecha: hoy() }));
    expect(await CajaMovimiento.countDocuments({ movimiento_id: f.body.id })).toBe(0);
    const prox = await auth(request(app).get('/api/caja/proximos').query({ fecha: hoy() }));
    expect(prox.body).toEqual([]);
  });
});

describe('Arrastre de gastos manuales sin confirmar', () => {
  beforeEach(() => bootstrap());

  it('un gasto manual de ayer sin confirmar aparece hoy', async () => {
    const r = await auth(request(app).post('/api/caja')).send({ fecha: dia(-1), tipo: 'gasto', concepto: 'Plomero', monto: 500, metodo: 'efectivo' });
    expect(r.status).toBe(200);
    expect((await cajaDelDia(hoy())).some(c => c.id === r.body.id)).toBe(true);
  });

  it('los pendientes manuales viejos (anteriores al corte) no se arrastran', async () => {
    const id = await Counter.next('caja');
    await CajaMovimiento.create({ _id: id, fecha: '2026-05-15', tipo: 'gasto', concepto: 'Viejo', monto: 420642, metodo: 'efectivo', confirmado: false, created_at: '2026-05-15T12:00:00.000Z' });
    expect((await cajaDelDia(hoy())).some(c => c.id === id)).toBe(false);
  });

  it('un gasto manual confirmado no se arrastra', async () => {
    const r = await auth(request(app).post('/api/caja')).send({ fecha: dia(-1), tipo: 'gasto', concepto: 'Luz', monto: 500, metodo: 'efectivo', confirmado: true });
    expect((await cajaDelDia(hoy())).some(c => c.id === r.body.id)).toBe(false);
  });
});
