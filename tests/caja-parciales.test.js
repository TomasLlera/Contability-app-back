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

async function bootstrap({ aplicaDescuento = false } = {}) {
  // Esperar los índices: el único de "un pendiente por factura" es parte de lo que
  // se prueba, y sin esto el primer test corre antes de que exista.
  await Promise.all([CajaMovimiento.init(), Movimiento.init()]);
  const hash = await bcrypt.hash('admin123', 4);
  await User.create({ _id: await Counter.next('users'), usuario: 'admin', password_hash: hash, role: 'admin', activo: true });
  token = (await request(app).post('/api/auth/login').send({ usuario: 'admin', password: 'admin123' })).body.token;
  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'L' });
  const rubroId = await Counter.next('rubros');
  await Rubro.create({ _id: rubroId, nombre: 'Empleados', local_id: lid });
  subrubroId = await Counter.next('subrubros');
  await Subrubro.create({ _id: subrubroId, rubro_id: rubroId, nombre: 'Sofia', monto_base: 0, aplica_descuento: aplicaDescuento });
  await CajaConfig.create({ _id: 'main', empleados: [], proveedores: [], rubros_sync: [rubroId], dias_anticipacion_caja: 0 });
}

async function facturaEnCaja({ monto = 1000, documento = 'factura' } = {}) {
  const f = await auth(request(app).post(`/api/movimientos/${subrubroId}`))
    .send({ tipo: 'factura', documento, monto, fecha: dia(-15), fecha_vencimiento: dia(-5), metodo_pago: 'efectivo' });
  expect(f.status).toBe(200);
  await auth(request(app).post('/api/caja/auto-sync').query({ fecha: hoy() }));
  const item = await CajaMovimiento.findOne({ movimiento_id: f.body.id, confirmado: false }).lean();
  expect(item).toBeTruthy();
  return { facturaId: f.body.id, cajaId: item._id };
}

const sync = (fecha = hoy()) => auth(request(app).post('/api/caja/auto-sync').query({ fecha }));
const pendientesDe = (facturaId) => CajaMovimiento.find({ movimiento_id: facturaId, confirmado: false }).lean();
const confirmar = (id, body = {}) => auth(request(app).post(`/api/caja/${id}/confirmar`)).send({ fecha: hoy(), ...body });

describe('Pago parcial desde Caja', () => {
  beforeEach(() => bootstrap());

  it('pagar una parte deja un pendiente por el resto, que se arrastra y se puede pagar después', async () => {
    const { facturaId, cajaId } = await facturaEnCaja();
    const r = await confirmar(cajaId, { monto: 400 });
    expect(r.status).toBe(200);
    expect(r.body.parcial).toBe(true);
    expect(r.body.pendiente_restante).toBe(600);

    const item = await CajaMovimiento.findById(cajaId).lean();
    expect(item).toMatchObject({ confirmado: true, monto: 400, fecha: hoy() });
    const pend = await pendientesDe(facturaId);
    expect(pend).toHaveLength(1);
    expect(pend[0].monto).toBe(600);
    expect((await Movimiento.findById(facturaId).lean()).pagado).toBe(false);

    // Mañana sigue apareciendo y el auto-sync no lo duplica.
    await sync(dia(1));
    expect(await pendientesDe(facturaId)).toHaveLength(1);
    const cajaManiana = (await auth(request(app).get('/api/caja').query({ fecha: dia(1) }))).body;
    expect(cajaManiana.some(c => c.id === pend[0]._id)).toBe(true);

    // Pagar el resto salda la factura.
    const r2 = await confirmar(pend[0]._id);
    expect(r2.status).toBe(200);
    expect((await Movimiento.findById(facturaId).lean()).pagado).toBe(true);
    expect(await pendientesDe(facturaId)).toHaveLength(0);
    expect(await CajaMovimiento.countDocuments({ movimiento_id: facturaId, confirmado: true })).toBe(2);
  });

  it('pagar el total con `monto` igual al saldo no es parcial', async () => {
    const { facturaId, cajaId } = await facturaEnCaja();
    const r = await confirmar(cajaId, { monto: 1000 });
    expect(r.body.parcial).toBe(false);
    expect(await pendientesDe(facturaId)).toHaveLength(0);
  });

  it('rechaza montos inválidos o mayores al saldo sin registrar nada', async () => {
    const { cajaId } = await facturaEnCaja();
    for (const monto of [0, -10, 1500, 'abc']) {
      const r = await confirmar(cajaId, { monto });
      expect(r.status).toBe(400);
    }
    expect(await Movimiento.countDocuments({ tipo: 'pago' })).toBe(0);
  });

  it('una factura legacy con un pago parcial ya confirmado y sin pendiente recupera el pendiente al sincronizar', async () => {
    const { facturaId, cajaId } = await facturaEnCaja();
    await confirmar(cajaId, { monto: 400 });
    await CajaMovimiento.deleteMany({ movimiento_id: facturaId, confirmado: false }); // estado previo al fix
    await sync();
    const pend = await pendientesDe(facturaId);
    expect(pend).toHaveLength(1);
    expect(pend[0].monto).toBe(600);
  });

  it('revertir el pago parcial funde el pendiente del resto: queda uno solo por el saldo total', async () => {
    const { facturaId, cajaId } = await facturaEnCaja();
    await confirmar(cajaId, { monto: 400 });
    const r = await auth(request(app).post(`/api/caja/${cajaId}/revertir`));
    expect(r.status).toBe(200);
    const pend = await pendientesDe(facturaId);
    expect(pend).toHaveLength(1);
    expect(pend[0]._id).toBe(cajaId);
    expect(pend[0].monto).toBe(1000);
    expect(await Movimiento.countDocuments({ tipo: 'pago' })).toBe(0);
  });

  it('el descuento no se combina con un pago parcial', async () => {
    await Subrubro.updateOne({ _id: subrubroId }, { aplica_descuento: true });
    const { cajaId } = await facturaEnCaja();
    const r = await confirmar(cajaId, { monto: 400, descuento: 50 });
    expect(r.status).toBe(400);
  });
});

describe('Editar la boleta desde Caja', () => {
  beforeEach(() => bootstrap());

  it('corrige monto y percepciones en la factura y el pendiente pasa a valer el saldo nuevo', async () => {
    const { facturaId, cajaId } = await facturaEnCaja({ monto: 10 });
    const g = await auth(request(app).get(`/api/caja/${cajaId}/boleta`));
    expect(g.body).toMatchObject({ id: facturaId, monto: 10, saldo: 10 });

    const r = await auth(request(app).put(`/api/caja/${cajaId}/boleta`)).send({ monto: 11, percepcion_iva: 0.5, ingresos_brutos: 0.3 });
    expect(r.status).toBe(200);
    const fac = await Movimiento.findById(facturaId).lean();
    expect(fac).toMatchObject({ monto: 11, percepcion_iva: 0.5, ingresos_brutos: 0.3, fecha: dia(-15), fecha_vencimiento: dia(-5), metodo_pago: 'efectivo' });
    expect((await CajaMovimiento.findById(cajaId).lean()).monto).toBe(11);
  });

  it('después de un pago parcial, editar la boleta ajusta solo el pendiente', async () => {
    const { facturaId, cajaId } = await facturaEnCaja({ monto: 1000 });
    await confirmar(cajaId, { monto: 400 });
    const [pend] = await pendientesDe(facturaId);
    await auth(request(app).put(`/api/caja/${pend._id}/boleta`)).send({ monto: 1100 });
    expect((await CajaMovimiento.findById(pend._id).lean()).monto).toBe(700);
    expect((await CajaMovimiento.findById(cajaId).lean()).monto).toBe(400);
  });

  it('funciona con remitos (y el remito no lleva percepciones)', async () => {
    const f = await auth(request(app).post(`/api/movimientos/${subrubroId}`))
      .send({ tipo: 'factura', documento: 'remito', monto: 500, fecha: dia(-3), fecha_vencimiento: dia(-1) });
    const item = await CajaMovimiento.findOne({ movimiento_id: f.body.id }).lean();
    const r = await auth(request(app).put(`/api/caja/${item._id}/boleta`)).send({ monto: 550, percepcion_iva: 9 });
    expect(r.status).toBe(200);
    const fac = await Movimiento.findById(f.body.id).lean();
    expect(fac).toMatchObject({ monto: 550, percepcion_iva: 0, documento: 'remito' });
    expect((await CajaMovimiento.findById(item._id).lean()).monto).toBe(550);
  });

  it('no se edita la boleta de un ítem confirmado', async () => {
    const { cajaId } = await facturaEnCaja();
    await confirmar(cajaId);
    const r = await auth(request(app).put(`/api/caja/${cajaId}/boleta`)).send({ monto: 2000 });
    expect(r.status).toBe(400);
  });
});

describe('Validación anti-desincronización en el PUT de Caja', () => {
  beforeEach(() => bootstrap());

  it('un pendiente con factura no cambia de monto por PUT (pero sí de método)', async () => {
    const { cajaId } = await facturaEnCaja();
    expect((await auth(request(app).put(`/api/caja/${cajaId}`)).send({ monto: 600 })).status).toBe(400);
    const ok = await auth(request(app).put(`/api/caja/${cajaId}`)).send({ monto: 1000, metodo: 'transferencia', concepto: 'x' });
    expect(ok.status).toBe(200);
    expect((await CajaMovimiento.findById(cajaId).lean()).metodo).toBe('transferencia');
  });

  it('confirmar o revertir por PUT se rechaza', async () => {
    const { cajaId } = await facturaEnCaja();
    expect((await auth(request(app).put(`/api/caja/${cajaId}`)).send({ confirmado: true })).status).toBe(400);
    expect(await Movimiento.countDocuments({ tipo: 'pago' })).toBe(0);
  });

  it('un confirmado no cambia monto ni fecha por PUT', async () => {
    const { cajaId } = await facturaEnCaja();
    await confirmar(cajaId);
    expect((await auth(request(app).put(`/api/caja/${cajaId}`)).send({ monto: 5 })).status).toBe(400);
    expect((await auth(request(app).put(`/api/caja/${cajaId}`)).send({ fecha: dia(-1) })).status).toBe(400);
  });

  it('un gasto manual sin factura se sigue editando libremente', async () => {
    const r = await auth(request(app).post('/api/caja')).send({ fecha: hoy(), tipo: 'gasto', concepto: 'Luz', monto: 500, metodo: 'efectivo' });
    const e = await auth(request(app).put(`/api/caja/${r.body.id}`)).send({ monto: 650, fecha: dia(-1) });
    expect(e.status).toBe(200);
    expect((await CajaMovimiento.findById(r.body.id).lean())).toMatchObject({ monto: 650, fecha: dia(-1) });
  });

  it('cargar a mano un gasto vinculado a una factura que ya tiene pendiente da 409, no 500', async () => {
    const { facturaId } = await facturaEnCaja();
    const r = await auth(request(app).post('/api/caja')).send({ fecha: hoy(), tipo: 'gasto', concepto: 'x', monto: 1000, metodo: 'efectivo', subrubro_id: subrubroId, movimiento_id: facturaId });
    expect(r.status).toBe(409);
  });
});

describe('Remito con pago confirmado', () => {
  beforeEach(() => bootstrap());

  it('editar el remito no toca el ítem confirmado; el resto va a un pendiente aparte', async () => {
    const f = await auth(request(app).post(`/api/movimientos/${subrubroId}`))
      .send({ tipo: 'factura', documento: 'remito', monto: 1000, fecha: dia(-15), fecha_vencimiento: dia(-5) });
    const item = await CajaMovimiento.findOne({ movimiento_id: f.body.id }).lean();
    await confirmar(item._id, { monto: 600 });
    await auth(request(app).put(`/api/movimientos/${f.body.id}`))
      .send({ tipo: 'factura', documento: 'remito', monto: 1200, fecha: dia(-15), fecha_vencimiento: dia(-5), concepto: 'editado' });

    expect(await CajaMovimiento.findById(item._id).lean()).toMatchObject({ confirmado: true, monto: 600, fecha: hoy() });
    const pend = await pendientesDe(f.body.id);
    expect(pend).toHaveLength(1);
    expect(pend[0].monto).toBe(600);
  });
});

describe('Pagos nacidos en Caja editados o borrados desde el subrubro', () => {
  it('editar el pago en el subrubro actualiza fecha y monto del ítem de Caja', async () => {
    await bootstrap();
    const { facturaId, cajaId } = await facturaEnCaja();
    const r = await confirmar(cajaId);
    const e = await auth(request(app).put(`/api/movimientos/${r.body.pago_mov_id}/pago-vinculado`))
      .send({ fecha: dia(-3), monto_pago: 800, facturas_vinculadas_ids: [facturaId], metodo_pago: 'transferencia' });
    expect(e.status).toBe(200);
    expect(await CajaMovimiento.findById(cajaId).lean()).toMatchObject({ fecha: dia(-3), monto: 800, metodo: 'transferencia' });
  });

  it('borrar desde el subrubro un pago con descuento borra la NC y deja el ítem limpio; reconfirmar no sobrepaga', async () => {
    await bootstrap({ aplicaDescuento: true });
    const { facturaId, cajaId } = await facturaEnCaja();
    const r = await confirmar(cajaId, { descuento: 100 });
    expect(r.status).toBe(200);

    await auth(request(app).delete(`/api/movimientos/${r.body.pago_mov_id}`));
    expect(await Movimiento.countDocuments({ tipo: 'nota_credito' })).toBe(0);
    expect(await CajaMovimiento.findById(cajaId).lean()).toMatchObject({
      confirmado: false, monto: 1000, descuento: 0, monto_bruto: null, nc_mov_id: null, pago_mov_id: null,
    });

    const r2 = await confirmar(cajaId);
    expect(r2.status).toBe(200);
    const pagos = await Movimiento.find({ tipo: 'pago' }).lean();
    expect(pagos.reduce((s, p) => s + p.pago, 0)).toBe(1000);
    expect(await Movimiento.countDocuments({ tipo: 'nota_credito' })).toBe(0);
    expect((await Movimiento.findById(facturaId).lean()).pagado).toBe(true);
  });
});
