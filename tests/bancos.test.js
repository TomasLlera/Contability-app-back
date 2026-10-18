const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, CajaMovimiento, Movimiento, Banco, MovimientoBanco, Audit } = require('../models');
const { hoyLocal, sumarDias } = require('../utils/tz');

setupTestDb();

let token, rubroId, provId;
const hoy = () => hoyLocal();
const ayer = () => sumarDias(hoyLocal(), -1);
const auth = (req) => req.set('Authorization', `Bearer ${token}`);

async function bootstrap() {
  const ah = await bcrypt.hash('pass123', 4);
  await User.create({ _id: await Counter.next('users'), usuario: 'admin', password_hash: ah, role: 'admin', activo: true });
  token = (await request(app).post('/api/auth/login').send({ usuario: 'admin', password: 'pass123' })).body.token;
  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'L', icon: 'x' });
  rubroId = await Counter.next('rubros');
  await Rubro.create({ _id: rubroId, nombre: 'R', local_id: lid });
  provId = await Counter.next('subrubros');
  await Subrubro.create({ _id: provId, rubro_id: rubroId, nombre: 'Proveedor', monto_base: 0 });
}

const crearBanco = (body) => auth(request(app).post('/api/bancos')).send(body);
const gasto = (body) => auth(request(app).post('/api/caja')).send({ fecha: hoy(), tipo: 'gasto', concepto: 'x', monto: 100, confirmado: true, ...body });
const dia = async (f = hoy()) => (await auth(request(app).get(`/api/caja/dia?fecha=${f}`))).body;

describe('multi-banco', () => {
  beforeEach(bootstrap);

  describe('ABM de bancos', () => {
    it('el primero queda predeterminado y solo uno lo es', async () => {
      const a = (await crearBanco({ nombre: 'Galicia' })).body;
      expect(a.es_predeterminado).toBe(true);
      const b = (await crearBanco({ nombre: 'Santander', es_predeterminado: true })).body;
      expect(b.es_predeterminado).toBe(true);
      expect((await Banco.findById(a.id).lean()).es_predeterminado).toBe(false);
    });

    it('no admite nombres repetidos', async () => {
      await crearBanco({ nombre: 'Galicia' });
      expect((await crearBanco({ nombre: 'galicia' })).status).toBe(409);
    });

    it('un banco con movimientos no se elimina, se desactiva; sin movimientos sí', async () => {
      const a = (await crearBanco({ nombre: 'Galicia' })).body;
      const b = (await crearBanco({ nombre: 'Santander' })).body;
      await gasto({ metodo: 'transferencia', banco_id: a.id });
      expect((await auth(request(app).delete(`/api/bancos/${a.id}`))).status).toBe(409);
      expect((await auth(request(app).delete(`/api/bancos/${b.id}`))).status).toBe(200);
      const d = await auth(request(app).put(`/api/bancos/${a.id}`)).send({ activo: false });
      expect(d.body.activo).toBe(false);
    });

    it('desactivar el predeterminado pasa el rol a otro activo', async () => {
      const a = (await crearBanco({ nombre: 'Galicia' })).body;
      const b = (await crearBanco({ nombre: 'Santander' })).body;
      await auth(request(app).put(`/api/bancos/${a.id}`)).send({ activo: false });
      expect((await Banco.findById(b.id).lean()).es_predeterminado).toBe(true);
    });
  });

  describe('pagos por transferencia', () => {
    let gal, san;
    beforeEach(async () => {
      gal = (await crearBanco({ nombre: 'Galicia' })).body;
      san = (await crearBanco({ nombre: 'Santander' })).body;
    });

    it('sin banco usa el predeterminado; efectivo queda sin banco', async () => {
      const t = await gasto({ metodo: 'transferencia' });
      expect(t.body.banco_id).toBe(gal.id);
      const e = await gasto({ metodo: 'efectivo', banco_id: san.id });
      expect(e.body.banco_id).toBeNull();
    });

    it('rechaza un banco desactivado para cargas nuevas', async () => {
      await auth(request(app).put(`/api/bancos/${san.id}`)).send({ activo: false });
      expect((await gasto({ metodo: 'transferencia', banco_id: san.id })).status).toBe(400);
    });

    it('cambiar el predeterminado no altera pagos ya cargados', async () => {
      const t = await gasto({ metodo: 'transferencia' });
      await auth(request(app).put(`/api/bancos/${san.id}`)).send({ es_predeterminado: true });
      expect((await CajaMovimiento.findById(t.body.id).lean()).banco_id).toBe(gal.id);
    });

    it('confirmar un pendiente con banco elegido: el pago del subrubro lo hereda', async () => {
      const p = await gasto({ metodo: 'transferencia', confirmado: false, subrubro_id: provId });
      const c = await auth(request(app).post(`/api/caja/${p.body.id}/confirmar`)).send({ banco_id: san.id });
      expect(c.status).toBe(200);
      const item = await CajaMovimiento.findById(p.body.id).lean();
      expect(item.banco_id).toBe(san.id);
      expect((await Movimiento.findById(item.pago_mov_id).lean()).banco_id).toBe(san.id);
    });

    it('editar el banco de un pago confirmado lo cambia también en el subrubro', async () => {
      const p = await gasto({ metodo: 'transferencia', confirmado: false, subrubro_id: provId });
      await auth(request(app).post(`/api/caja/${p.body.id}/confirmar`)).send({});
      const r = await auth(request(app).put(`/api/caja/${p.body.id}`)).send({ banco_id: san.id });
      expect(r.status).toBe(200);
      const item = await CajaMovimiento.findById(p.body.id).lean();
      expect(item.banco_id).toBe(san.id);
      expect((await Movimiento.findById(item.pago_mov_id).lean()).banco_id).toBe(san.id);
    });

    it('pasar a efectivo borra el banco', async () => {
      const t = await gasto({ metodo: 'transferencia', banco_id: san.id });
      await auth(request(app).put(`/api/caja/${t.body.id}`)).send({ metodo: 'efectivo' });
      expect((await CajaMovimiento.findById(t.body.id).lean()).banco_id).toBeNull();
    });

    it('un pago por transferencia del subrubro lleva su banco al espejo de Caja', async () => {
      const r = await auth(request(app).post(`/api/movimientos/${provId}`)).send({ tipo: 'pago', pago: 50, fecha: hoy(), metodo_pago: 'transferencia', banco_id: san.id });
      expect(r.status).toBe(200);
      const espejo = await CajaMovimiento.findOne({ pago_mov_id: r.body.id }).lean();
      expect(espejo.banco_id).toBe(san.id);
      await auth(request(app).put(`/api/movimientos/${r.body.id}`)).send({ tipo: 'pago', pago: 50, fecha: hoy(), metodo_pago: 'transferencia', banco_id: gal.id });
      expect((await CajaMovimiento.findOne({ pago_mov_id: r.body.id }).lean()).banco_id).toBe(gal.id);
    });
  });

  describe('banco por defecto del subrubro', () => {
    let gal, san;
    beforeEach(async () => {
      gal = (await crearBanco({ nombre: 'Galicia' })).body;
      san = (await crearBanco({ nombre: 'Santander' })).body;
      const r = await auth(request(app).put(`/api/subrubros/${provId}`)).send({ banco_default_id: san.id });
      expect(r.status).toBe(200);
    });

    it('un gasto del subrubro sin banco elegido usa el del subrubro, no el predeterminado', async () => {
      const t = await gasto({ metodo: 'transferencia', subrubro_id: provId, confirmado: false });
      expect(t.body.banco_id).toBe(san.id);
      const c = await auth(request(app).post(`/api/caja/${t.body.id}/confirmar`)).send({});
      expect(c.status).toBe(200);
      expect((await Movimiento.findById(c.body.pago_mov_id).lean()).banco_id).toBe(san.id);
    });

    it('elegir otro banco al pagar le gana al del subrubro', async () => {
      const t = await gasto({ metodo: 'transferencia', subrubro_id: provId, confirmado: false });
      await auth(request(app).post(`/api/caja/${t.body.id}/confirmar`)).send({ banco_id: gal.id });
      expect((await CajaMovimiento.findById(t.body.id).lean()).banco_id).toBe(gal.id);
    });

    it('un pago cargado en el subrubro y el vencimiento sincronizado nacen con su banco', async () => {
      const p = await auth(request(app).post(`/api/movimientos/${provId}`)).send({ tipo: 'pago', pago: 50, fecha: hoy(), metodo_pago: 'transferencia' });
      expect(p.body.banco_id).toBe(san.id);
      await auth(request(app).post(`/api/movimientos/${provId}`)).send({ tipo: 'factura', monto: 300, fecha: hoy(), fecha_vencimiento: hoy(), metodo_pago: 'transferencia' });
      const { CajaConfig } = require('../models');
      await CajaConfig.updateOne({ _id: 'main' }, { $set: { rubros_sync: [rubroId] } }, { upsert: true });
      await auth(request(app).post(`/api/caja/auto-sync?fecha=${hoy()}`));
      const pend = await CajaMovimiento.findOne({ confirmado: false, movimiento_id: { $ne: null } }).lean();
      expect(pend.banco_id).toBe(san.id);
    });

    it('si el banco del subrubro se desactiva, cae al predeterminado; y el subrubro se puede seguir guardando', async () => {
      await auth(request(app).put(`/api/bancos/${san.id}`)).send({ activo: false });
      const t = await gasto({ metodo: 'transferencia', subrubro_id: provId });
      expect(t.body.banco_id).toBe(gal.id);
      expect((await auth(request(app).put(`/api/subrubros/${provId}`)).send({ banco_default_id: san.id, nombre: 'Proveedor' })).status).toBe(200);
      expect((await auth(request(app).put(`/api/subrubros/${provId}`)).send({ banco_default_id: 999 })).status).toBe(400);
    });

    it('cambiar el banco del subrubro no toca pagos ya cargados', async () => {
      const t = await gasto({ metodo: 'transferencia', subrubro_id: provId });
      await auth(request(app).put(`/api/subrubros/${provId}`)).send({ banco_default_id: gal.id });
      expect((await CajaMovimiento.findById(t.body.id).lean()).banco_id).toBe(san.id);
    });
  });

  describe('saldo en cuenta por banco', () => {
    let gal, san;
    beforeEach(async () => {
      gal = (await crearBanco({ nombre: 'Galicia' })).body;
      san = (await crearBanco({ nombre: 'Santander' })).body;
    });

    it('guarda un saldo por banco; el total de ayer es la suma', async () => {
      const r = await auth(request(app).put('/api/caja/saldos-cuenta')).send({ fecha: ayer(), saldos: [{ banco_id: gal.id, monto: 1000 }, { banco_id: san.id, monto: 500 }] });
      expect(r.body.total).toBe(1500);
      const d = await dia();
      expect(d.saldo_cuenta_ayer).toBe(1500);
      expect(d.bancos.saldos_ayer).toEqual({ [gal.id]: 1000, [san.id]: 500 });
    });

    it('editar reemplaza, vacío borra, y un saldo viejo sin banco se reemplaza', async () => {
      await CajaMovimiento.create({ _id: await Counter.next('caja'), fecha: hoy(), tipo: 'saldo_cuenta', concepto: 'Saldo en cuenta', monto: 999, metodo: 'transferencia' });
      await auth(request(app).put('/api/caja/saldos-cuenta')).send({ fecha: hoy(), saldos: [{ banco_id: gal.id, monto: 100 }, { banco_id: san.id, monto: 200 }] });
      let docs = await CajaMovimiento.find({ fecha: hoy(), tipo: 'saldo_cuenta' }).lean();
      expect(docs.map(d => d.monto).sort()).toEqual([100, 200]);
      await auth(request(app).put('/api/caja/saldos-cuenta')).send({ fecha: hoy(), saldos: [{ banco_id: gal.id, monto: 150 }, { banco_id: san.id, monto: '' }] });
      docs = await CajaMovimiento.find({ fecha: hoy(), tipo: 'saldo_cuenta' }).lean();
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ banco_id: gal.id, monto: 150 });
      expect(await Audit.countDocuments({ recurso: 'caja_saldo_cuenta' })).toBe(2);
    });

    it('cierre de ayer por banco: saldo − transferencias confirmadas ± movimientos entre bancos', async () => {
      await auth(request(app).put('/api/caja/saldos-cuenta')).send({ fecha: ayer(), saldos: [{ banco_id: gal.id, monto: 1000 }, { banco_id: san.id, monto: 500 }] });
      await gasto({ fecha: ayer(), metodo: 'transferencia', banco_id: gal.id, monto: 300 });
      await gasto({ fecha: ayer(), metodo: 'transferencia', banco_id: gal.id, monto: 50, confirmado: false });
      await auth(request(app).post('/api/bancos/movimientos')).send({ fecha: ayer(), banco_origen_id: gal.id, banco_destino_id: san.id, monto: 200 });
      const d = await dia();
      expect(d.bancos.cierre_ayer).toEqual({ [gal.id]: 500, [san.id]: 700 });
    });
  });

  describe('movimientos entre bancos', () => {
    let gal, san;
    beforeEach(async () => {
      gal = (await crearBanco({ nombre: 'Galicia' })).body;
      san = (await crearBanco({ nombre: 'Santander' })).body;
    });
    const mover = (body) => auth(request(app).post('/api/bancos/movimientos')).send({ fecha: hoy(), banco_origen_id: gal.id, banco_destino_id: san.id, monto: 100, ...body });

    it('valida origen ≠ destino, monto > 0 y bancos activos', async () => {
      expect((await mover({ banco_destino_id: gal.id })).status).toBe(400);
      expect((await mover({ monto: 0 })).status).toBe(400);
      await auth(request(app).put(`/api/bancos/${san.id}`)).send({ activo: false });
      expect((await mover({})).status).toBe(400);
    });

    it('no es gasto ni ingreso: la Caja, los gastos y el total no cambian', async () => {
      await gasto({ metodo: 'transferencia', banco_id: gal.id, monto: 80 });
      const antes = await dia();
      const r = await mover({ monto: 1000 });
      expect(r.status).toBe(200);
      const despues = await dia();
      expect(despues.movs).toHaveLength(antes.movs.length);
      expect(despues.bancos.movimientos).toHaveLength(1);
      expect(await CajaMovimiento.countDocuments({ tipo: { $in: ['gasto', 'ingreso_extra', 'empleado'] } })).toBe(1);
      const g = (await auth(request(app).get(`/api/caja/graficas?desde=${hoy()}&hasta=${hoy()}&vista=dia`))).body;
      expect(g.periodos[0].gastosTrans).toBe(80);
    });

    it('editar y eliminar', async () => {
      const r = await mover({});
      const e = await auth(request(app).put(`/api/bancos/movimientos/${r.body.id}`)).send({ monto: 250, banco_origen_id: san.id, banco_destino_id: gal.id });
      expect(e.body).toMatchObject({ monto: 250, banco_origen_id: san.id, banco_destino_id: gal.id });
      expect((await auth(request(app).delete(`/api/bancos/movimientos/${r.body.id}`))).status).toBe(200);
      expect(await MovimientoBanco.countDocuments()).toBe(0);
      expect(await Audit.countDocuments({ recurso: 'movimiento_banco' })).toBe(3);
    });
  });

  describe('gráficas', () => {
    it('con todos los bancos los totales coinciden con el criterio anterior; el filtro separa', async () => {
      const gal = (await crearBanco({ nombre: 'Galicia' })).body;
      const san = (await crearBanco({ nombre: 'Santander' })).body;
      await gasto({ metodo: 'transferencia', banco_id: gal.id, monto: 100 });
      await gasto({ metodo: 'transferencia', banco_id: san.id, monto: 40 });
      await gasto({ metodo: 'transferencia', banco_id: san.id, monto: 10, confirmado: false });
      await gasto({ metodo: 'efectivo', monto: 7, es_especial: true });
      await auth(request(app).post('/api/caja')).send({ fecha: hoy(), tipo: 'empleado', concepto: 'Ana', monto: 500, metodo: 'efectivo' });
      await auth(request(app).put('/api/caja/saldos-cuenta')).send({ fecha: ayer(), saldos: [{ banco_id: gal.id, monto: 1000 }, { banco_id: san.id, monto: 500 }] });
      await auth(request(app).put('/api/caja/saldos-cuenta')).send({ fecha: hoy(), saldos: [{ banco_id: gal.id, monto: 1300 }, { banco_id: san.id, monto: 400 }] });
      await auth(request(app).post('/api/bancos/movimientos')).send({ fecha: hoy(), banco_origen_id: gal.id, banco_destino_id: san.id, monto: 100 });

      const url = (q = '') => `/api/caja/graficas?desde=${ayer()}&hasta=${hoy()}&vista=dia${q}`;
      const todos = (await auth(request(app).get(url()))).body.periodos;
      const d = todos.find(p => p.key === hoy());
      // Igual que la agregación vieja del front: pendientes incluidos.
      expect(d).toMatchObject({ gastosTrans: 150, gastosEfvo: 7, ingresosEfvo: 500, gastosEspeciales: 7, totalGastos: 157, saldoCuentaLast: 1700, transDelta: 200 });
      expect(d.gastosTransPorBanco).toEqual({ [gal.id]: 100, [san.id]: 50 });
      // Evolución por banco: el movimiento entre bancos se refleja.
      expect(d.saldoPorBanco).toEqual({ [gal.id]: 1200, [san.id]: 500 });

      const soloSan = (await auth(request(app).get(url(`&bancos=${san.id}`)))).body.periodos.find(p => p.key === hoy());
      expect(soloSan).toMatchObject({ gastosTrans: 50, gastosEfvo: 7, saldoCuentaLast: 400 });
    });
  });
});
