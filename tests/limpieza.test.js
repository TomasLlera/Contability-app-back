const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const app = require('../server');
const { User, Counter, Local, Rubro, Subrubro, Movimiento, CajaMovimiento, CajaConfig, AppConfig, Producto, Recordatorio } = require('../models');
const { hoyLocal, sumarDias } = require('../utils/tz');

setupTestDb();

let token, rubroId, subrubroId;
const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const dia = (n) => sumarDias(hoyLocal(), n);

beforeEach(async () => {
  await User.create({ _id: await Counter.next('users'), usuario: 'jefe', password_hash: await bcrypt.hash('x12345', 4), role: 'superadmin', activo: true });
  token = (await request(app).post('/api/auth/login').send({ usuario: 'jefe', password: 'x12345' })).body.token;
  const lid = await Counter.next('locales'); await Local.create({ _id: lid, nombre: 'L' });
  rubroId = await Counter.next('rubros'); await Rubro.create({ _id: rubroId, nombre: 'R', local_id: lid });
  subrubroId = await Counter.next('subrubros'); await Subrubro.create({ _id: subrubroId, rubro_id: rubroId, nombre: 'Prov', monto_base: 0 });
  await CajaConfig.create({ _id: 'main', rubros_sync: [rubroId], dias_anticipacion_caja: 0, proveedores: [{ nombre: 'Prov', subrubro_id: subrubroId }] });
  await AppConfig.create({ _id: 'main', dashboard_tablas: [rubroId] });
  await Producto.create({ _id: 1, nombre: 'P', subrubro_id: subrubroId });
  await Recordatorio.create({ _id: 1, titulo: 'r', rubro_id: rubroId, subrubros_ids: [subrubroId], subrubros_prioritarios_ids: [subrubroId] });
});

async function confirmadoYPendiente() {
  const f1 = await auth(request(app).post(`/api/movimientos/${subrubroId}`)).send({ tipo: 'factura', monto: 1000, fecha: dia(-10), fecha_vencimiento: dia(-2), metodo_pago: 'efectivo' });
  await auth(request(app).post(`/api/movimientos/${subrubroId}`)).send({ tipo: 'factura', monto: 500, fecha: dia(-10), fecha_vencimiento: dia(-2), metodo_pago: 'efectivo' });
  await auth(request(app).post('/api/caja/auto-sync').query({ fecha: hoyLocal() }));
  const item = await CajaMovimiento.findOne({ movimiento_id: f1.body.id }).lean();
  const r = await auth(request(app).post(`/api/caja/${item._id}/confirmar`)).send({});
  return { confirmadoId: item._id, pagoId: r.body.pago_mov_id };
}

describe('Borrados en cascada limpian las referencias', () => {
  it('borrar un subrubro: pendientes borrados, confirmados conservados y desvinculados, config limpia', async () => {
    const { confirmadoId } = await confirmadoYPendiente();
    const r = await auth(request(app).delete(`/api/subrubros/${subrubroId}`));
    expect(r.status).toBe(200);

    expect(await CajaMovimiento.countDocuments({ confirmado: false })).toBe(0);
    const conf = await CajaMovimiento.findById(confirmadoId).lean();
    expect(conf).toMatchObject({ confirmado: true, movimiento_id: null, pago_mov_id: null, subrubro_id: null });
    expect((await Producto.findById(1).lean()).subrubro_id).toBeNull();
    const rec = await Recordatorio.findById(1).lean();
    expect(rec.subrubros_ids).toEqual([]);
    expect(rec.subrubros_prioritarios_ids).toEqual([]);
    expect((await CajaConfig.findById('main').lean()).proveedores[0].subrubro_id).toBeNull();

    const inc = await auth(request(app).get('/api/audit/inconsistencias'));
    expect(inc.body.checks.find(c => c.key === 'referencias_rotas').cantidad).toBe(0);
  });

  it('borrar un rubro también lo saca de los rubros sincronizados y del dashboard', async () => {
    await confirmadoYPendiente();
    await auth(request(app).delete(`/api/rubros/${rubroId}`));
    expect((await CajaConfig.findById('main').lean()).rubros_sync).toEqual([]);
    expect((await AppConfig.findById('main').lean()).dashboard_tablas).toEqual([]);
    expect((await Recordatorio.findById(1).lean()).rubro_id).toBeNull();
  });

  it('vaciar los movimientos de un subrubro limpia la Caja pero conserva el vínculo al subrubro', async () => {
    const { confirmadoId } = await confirmadoYPendiente();
    await auth(request(app).delete(`/api/subrubros/${subrubroId}/movimientos`));
    expect(await CajaMovimiento.countDocuments({ confirmado: false })).toBe(0);
    expect(await CajaMovimiento.findById(confirmadoId).lean()).toMatchObject({ movimiento_id: null, pago_mov_id: null });
    expect((await Producto.findById(1).lean()).subrubro_id).toBe(subrubroId);
  });
});

describe('IVA: detección de notas de crédito', () => {
  it('una Factura de Crédito Electrónica suma como factura; una Nota de Crédito resta', async () => {
    await User.create({ _id: 900, usuario: 'x', role: 'admin', activo: true });
    const HEAD = ['Fecha', 'Tipo', 'Documento', 'Nro Doc Emisor', 'Razon Social', 'IVA 21', 'Neto Grav. 21%', 'Neto Gravado', 'Otros Atributos', 'Total IVA', 'Imp. Total'];
    const ws = XLSX.utils.aoa_to_sheet([HEAD,
      ['2026-08-05', '201 - Factura de Crédito Electrónica MiPyMEs (FCE) A', 'CUIT', '1', 'Prov A', 210, 1000, 1000, '', 210, 1210],
      ['2026-08-06', '3 - Nota de Crédito A', 'CUIT', '2', 'Prov B', 21, 100, 100, '', 21, 121],
    ]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Compras');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const imp = await auth(request(app).post('/api/iva/compras/import')).attach('file', buf, 'c.xlsx');
    expect(imp.status).toBe(200);
    const res = await auth(request(app).get('/api/iva/resumen'));
    const mes = res.body.meses.find(m => m.mes === '2026-08');
    expect(mes.compras.imp_total).toBe(1210 - 121);
    expect(mes.compras.total_iva).toBe(210 - 21);
  });
});
