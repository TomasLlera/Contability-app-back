const { setupTestDb } = require('./setup');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const AdmZip = require('adm-zip');
const app = require('../server');
const {
  User, Counter, Local, Rubro, Subrubro, CajaMovimiento, MovimientoSumatoria, ConceptoSumatoria, Audit,
} = require('../models');
const { hoyLocal, sumarDias } = require('../utils/tz');

setupTestDb();

let token, superToken, rubroId, subId, provSubId;
let cMerc, cEfvo, cTrans;
const hoy = () => hoyLocal();
const ayer = () => sumarDias(hoyLocal(), -1);
const auth = (req, t = token) => req.set('Authorization', `Bearer ${t}`);

async function login(usuario, role) {
  const ah = await bcrypt.hash('pass123', 4);
  await User.create({ _id: await Counter.next('users'), usuario, password_hash: ah, role, activo: true });
  return (await request(app).post('/api/auth/login').send({ usuario, password: 'pass123' })).body.token;
}

async function bootstrap() {
  token = await login('admin', 'admin');
  superToken = await login('root', 'superadmin');
  const lid = await Counter.next('locales');
  await Local.create({ _id: lid, nombre: 'L', icon: 'x' });
  rubroId = await Counter.next('rubros');
  await Rubro.create({ _id: rubroId, nombre: 'Socios', local_id: lid });

  // Subrubro sumatoria creado vía API con los conceptos sugeridos.
  const res = await auth(request(app).post(`/api/subrubros/${rubroId}`)).send({
    nombre: 'Retiro Antonela',
    tipo_subrubro: 'sumatoria',
    conceptos: [
      { nombre: 'Retiro mercadería', mostrar_en_caja: false },
      { nombre: 'Retiro efectivo' },
      { nombre: 'Retiro transferencia' },
    ],
  });
  expect(res.status).toBe(200);
  subId = res.body.id;
  const conceptos = (await auth(request(app).get(`/api/sumatorias/${subId}/conceptos`))).body;
  [cMerc, cEfvo, cTrans] = conceptos;

  provSubId = await Counter.next('subrubros');
  await Subrubro.create({ _id: provSubId, rubro_id: rubroId, nombre: 'Proveedor X', monto_base: 0 });
}

const cargar = (body, sid = subId) => auth(request(app).post(`/api/sumatorias/${sid}/movimientos`)).send(body);
const cajaDia = async (fecha) => (await auth(request(app).get(`/api/caja/dia?fecha=${fecha}`))).body;

// Disponible en efectivo/transferencia de un día con el mismo criterio que la Caja
// del Día (frontend): solo los gastos con confirmado !== false descuentan.
const gastosDe = (movs, metodo) => movs
  .filter(m => m.tipo === 'gasto' && m.metodo === metodo && m.confirmado !== false)
  .reduce((s, m) => s + m.monto, 0);

describe('subrubro tipo SUMATORIA', () => {
  beforeEach(bootstrap);

  it('se crea con los conceptos sugeridos y su configuración de Caja', async () => {
    expect([cMerc.nombre, cEfvo.nombre, cTrans.nombre]).toEqual(['Retiro mercadería', 'Retiro efectivo', 'Retiro transferencia']);
    expect(cMerc.mostrar_en_caja).toBe(false);
    expect(cEfvo.mostrar_en_caja).toBe(true);
    const sub = await Subrubro.findById(subId).lean();
    expect(sub.tipo_subrubro).toBe('sumatoria');
    expect(sub.aplica_descuento).toBe(false);
  });

  describe('carga desde la Caja (origen caja)', () => {
    it('un concepto con mostrar_en_caja = no se rechaza desde la Caja', async () => {
      const r = await cargar({ concepto_id: cMerc.id, fecha: hoy(), monto: 100, origen: 'caja', metodo: 'efectivo' });
      expect(r.status).toBe(400);
      expect(await MovimientoSumatoria.countDocuments()).toBe(0);
      expect(await CajaMovimiento.countDocuments()).toBe(0);
    });

    it('exige el método', async () => {
      const r = await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 100, origen: 'caja' });
      expect(r.status).toBe(400);
    });

    it('retiro en efectivo: descuenta del efectivo del día y suma en el subrubro', async () => {
      const r = await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 1500, origen: 'caja', metodo: 'efectivo', descripcion: 'para el fin de semana' });
      expect(r.status).toBe(200);
      expect(r.body.origen).toBe('caja');
      expect(r.body.caja_mov_id).toBeTruthy();

      const dia = await cajaDia(hoy());
      const item = dia.movs.find(m => m.sumatoria_mov_id === r.body.id);
      expect(item).toMatchObject({ tipo: 'gasto', metodo: 'efectivo', monto: 1500, confirmado: null, origen: 'sumatoria', subrubro_id: subId, es_especial: true });
      expect(item.concepto).toBe('Retiro Antonela — Retiro efectivo');
      expect(item.sumatoria).toMatchObject({ concepto_nombre: 'Retiro efectivo', descripcion: 'para el fin de semana' });
      expect(gastosDe(dia.movs, 'efectivo')).toBe(1500);
      expect(gastosDe(dia.movs, 'transferencia')).toBe(0);

      const res = (await auth(request(app).get(`/api/sumatorias/${subId}/resumen?mes=${hoy().slice(0, 7)}`))).body;
      expect(res.total).toBe(1500);
    });

    it('retiro por transferencia: descuenta del saldo en cuenta', async () => {
      const r = await cargar({ concepto_id: cTrans.id, fecha: hoy(), monto: 800, origen: 'caja', metodo: 'transferencia' });
      expect(r.status).toBe(200);
      const dia = await cajaDia(hoy());
      expect(gastosDe(dia.movs, 'transferencia')).toBe(800);
      expect(gastosDe(dia.movs, 'efectivo')).toBe(0);
    });

    it('afecta el saldo de efectivo con el que abre el día siguiente', async () => {
      await auth(request(app).post('/api/caja')).send({ fecha: ayer(), tipo: 'saldo_inicial', concepto: 'Saldo anterior', monto: 10000, metodo: 'efectivo' });
      await cargar({ concepto_id: cEfvo.id, fecha: ayer(), monto: 2500, origen: 'caja', metodo: 'efectivo' });
      const s = (await auth(request(app).get(`/api/caja/saldo-anterior?fecha=${hoy()}`))).body;
      expect(s.saldo).toBe(7500);
    });

    it('no se puede confirmar ni revertir (ya descontó)', async () => {
      const r = await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 100, origen: 'caja', metodo: 'efectivo' });
      const conf = await auth(request(app).post(`/api/caja/${r.body.caja_mov_id}/confirmar`)).send({});
      expect(conf.status).toBe(400);
      const rev = await auth(request(app).post(`/api/caja/${r.body.caja_mov_id}/revertir`)).send({});
      expect(rev.status).toBe(400);
    });

    it('es idempotente (doble clic)', async () => {
      const body = { concepto_id: cEfvo.id, fecha: hoy(), monto: 100, origen: 'caja', metodo: 'efectivo', idempotency_key: 'k-1' };
      const a = await cargar(body);
      const b = await cargar(body);
      expect(b.body.id).toBe(a.body.id);
      expect(await MovimientoSumatoria.countDocuments()).toBe(1);
      expect(await CajaMovimiento.countDocuments()).toBe(1);
    });
  });

  describe('carga desde el subrubro (origen subrubro)', () => {
    it('mercadería: suma en el subrubro y NO existe en la Caja, historial ni saldos', async () => {
      await auth(request(app).post('/api/caja')).send({ fecha: ayer(), tipo: 'saldo_inicial', concepto: 'Saldo anterior', monto: 10000, metodo: 'efectivo' });
      const r = await cargar({ concepto_id: cMerc.id, fecha: ayer(), monto: 25000, origen: 'subrubro' });
      expect(r.status).toBe(200);
      expect(r.body.origen).toBe('subrubro');
      expect(r.body.metodo).toBeNull();
      expect(r.body.caja_mov_id).toBeNull();

      expect(await CajaMovimiento.countDocuments({ sumatoria_mov_id: r.body.id })).toBe(0);
      const dia = await cajaDia(ayer());
      expect(dia.movs.filter(m => m.tipo === 'gasto')).toHaveLength(0);
      const rango = (await auth(request(app).get(`/api/caja/rango?desde=${ayer()}&hasta=${hoy()}`))).body;
      expect(rango.filter(m => m.tipo === 'gasto')).toHaveLength(0);
      const s = (await auth(request(app).get(`/api/caja/saldo-anterior?fecha=${hoy()}`))).body;
      expect(s.saldo).toBe(10000);

      const res = (await auth(request(app).get(`/api/sumatorias/${subId}/resumen`))).body;
      expect(res.total).toBe(25000);
    });

    it('un "Retiro efectivo" cargado desde el subrubro tampoco toca la Caja (aunque mande método)', async () => {
      const r = await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 900, origen: 'subrubro', metodo: 'efectivo' });
      expect(r.status).toBe(200);
      expect(r.body.metodo).toBeNull();
      expect(await CajaMovimiento.countDocuments()).toBe(0);
    });

    it('editar: no admite método ni cambiar el origen', async () => {
      const r = await cargar({ concepto_id: cMerc.id, fecha: hoy(), monto: 10, origen: 'subrubro' });
      const conMetodo = await auth(request(app).put(`/api/sumatorias/movimientos/${r.body.id}`)).send({ metodo: 'efectivo' });
      expect(conMetodo.status).toBe(400);
      const conOrigen = await auth(request(app).put(`/api/sumatorias/movimientos/${r.body.id}`)).send({ origen: 'caja' });
      expect(conOrigen.status).toBe(400);
      const ok = await auth(request(app).put(`/api/sumatorias/movimientos/${r.body.id}`)).send({ monto: 20 });
      expect(ok.status).toBe(200);
      expect(await CajaMovimiento.countDocuments()).toBe(0);
    });
  });

  describe('edición y eliminación de una carga de Caja', () => {
    let carga;
    beforeEach(async () => {
      carga = (await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 1000, origen: 'caja', metodo: 'efectivo' })).body;
    });

    it('editada desde el subrubro: la Caja se recalcula', async () => {
      const r = await auth(request(app).put(`/api/sumatorias/movimientos/${carga.id}`)).send({ monto: 1200, metodo: 'transferencia' });
      expect(r.status).toBe(200);
      const dia = await cajaDia(hoy());
      expect(gastosDe(dia.movs, 'efectivo')).toBe(0);
      expect(gastosDe(dia.movs, 'transferencia')).toBe(1200);
    });

    it('cambiarle la fecha la muda a la Caja del otro día', async () => {
      await auth(request(app).put(`/api/sumatorias/movimientos/${carga.id}`)).send({ fecha: ayer() });
      expect((await cajaDia(hoy())).movs.filter(m => m.origen === 'sumatoria')).toHaveLength(0);
      const deAyer = (await cajaDia(ayer())).movs.filter(m => m.origen === 'sumatoria');
      expect(deAyer).toHaveLength(1);
      expect(deAyer[0].monto).toBe(1000);
      expect(await CajaMovimiento.countDocuments()).toBe(1);
    });

    it('no se le puede poner un concepto que no se carga desde la Caja', async () => {
      const r = await auth(request(app).put(`/api/sumatorias/movimientos/${carga.id}`)).send({ concepto_id: cMerc.id });
      expect(r.status).toBe(400);
    });

    it('editada desde la Caja (PUT /caja/:id): se edita la carga', async () => {
      const r = await auth(request(app).put(`/api/caja/${carga.caja_mov_id}`)).send({ monto: 700, fecha: ayer(), metodo: 'efectivo' });
      expect(r.status).toBe(200);
      const fresh = await MovimientoSumatoria.findById(carga.id).lean();
      expect(fresh).toMatchObject({ monto: 700, fecha: ayer() });
      const item = await CajaMovimiento.findById(carga.caja_mov_id).lean();
      expect(item).toMatchObject({ monto: 700, fecha: ayer() });
    });

    it('eliminada desde la Caja: desaparece también del subrubro', async () => {
      const r = await auth(request(app).delete(`/api/caja/${carga.caja_mov_id}`));
      expect(r.status).toBe(200);
      expect(await MovimientoSumatoria.countDocuments()).toBe(0);
      expect(await CajaMovimiento.countDocuments()).toBe(0);
    });

    it('eliminada desde el subrubro: desaparece de la Caja', async () => {
      const r = await auth(request(app).delete(`/api/sumatorias/movimientos/${carga.id}`));
      expect(r.status).toBe(200);
      expect(await CajaMovimiento.countDocuments()).toBe(0);
    });

    it('renombrar el concepto actualiza el texto del ítem de Caja', async () => {
      await auth(request(app).put(`/api/sumatorias/conceptos/${cEfvo.id}`)).send({ nombre: 'Retiro en mano' });
      const item = await CajaMovimiento.findById(carga.caja_mov_id).lean();
      expect(item.concepto).toBe('Retiro Antonela — Retiro en mano');
    });
  });

  describe('filtros y resumen', () => {
    beforeEach(async () => {
      // Mes pasado (fijo) y mes actual, ambos orígenes.
      await cargar({ concepto_id: cEfvo.id, fecha: '2026-01-10', monto: 100, origen: 'caja', metodo: 'efectivo' });
      await cargar({ concepto_id: cMerc.id, fecha: '2026-01-20', monto: 300, origen: 'subrubro' });
      await cargar({ concepto_id: cTrans.id, fecha: '2026-02-05', monto: 50, origen: 'caja', metodo: 'transferencia' });
      await cargar({ concepto_id: cMerc.id, fecha: '2026-02-28', monto: 200, origen: 'subrubro' });
      await cargar({ concepto_id: cEfvo.id, fecha: '2026-02-28', monto: 25.5, origen: 'subrubro' });
    });

    const resumen = async (q) => (await auth(request(app).get(`/api/sumatorias/${subId}/resumen?${q}`))).body;
    const lista = async (q) => (await auth(request(app).get(`/api/sumatorias/${subId}/movimientos?${q}`))).body;
    const suma = (arr) => Math.round(arr.reduce((s, m) => s + m.monto, 0) * 100) / 100;

    it('por mes: total, tabla y vista por mes coinciden', async () => {
      const r = await resumen('mes=2026-02');
      const l = await lista('mes=2026-02');
      expect(r.total).toBe(275.5);
      expect(r.cantidad).toBe(3);
      expect(suma(l)).toBe(r.total);
      expect(r.por_mes).toEqual([{ mes: '2026-02', total: 275.5, cantidad: 3 }]);
      const celdasMes = r.celdas.filter(c => c.mes === '2026-02');
      expect(Math.round(celdasMes.reduce((s, c) => s + c.total, 0) * 100) / 100).toBe(r.total);
    });

    it('por rango libre', async () => {
      const r = await resumen('desde=2026-01-15&hasta=2026-02-05');
      expect(r.total).toBe(350);
      expect(suma(await lista('desde=2026-01-15&hasta=2026-02-05'))).toBe(350);
    });

    it('por concepto (múltiple): las tarjetas siguen mostrando todos', async () => {
      const r = await resumen(`conceptos=${cEfvo.id},${cTrans.id}`);
      expect(r.total).toBe(175.5);
      expect(suma(await lista(`conceptos=${cEfvo.id},${cTrans.id}`))).toBe(175.5);
      const tarjetas = Object.fromEntries(r.tarjetas.map(t => [t.concepto_id, t]));
      expect(tarjetas[cMerc.id]).toMatchObject({ total: 500, cantidad: 2 });
      expect(tarjetas[cEfvo.id]).toMatchObject({ total: 125.5, cantidad: 2 });
    });

    it('por origen', async () => {
      expect((await resumen('origen=caja')).total).toBe(150);
      expect((await resumen('origen=subrubro')).total).toBe(525.5);
      expect((await resumen('origen=todos')).total).toBe(675.5);
      const l = await lista('origen=subrubro');
      expect(l.every(m => m.origen === 'subrubro')).toBe(true);
    });

    it('vista por mes: totales por fila y por columna', async () => {
      const r = await resumen('');
      const porMes = Object.fromEntries(r.por_mes.map(m => [m.mes, m.total]));
      expect(porMes).toEqual({ '2026-01': 400, '2026-02': 275.5 });
      const porConcepto = Object.fromEntries(r.por_concepto.map(c => [c.concepto_id, c.total]));
      expect(porConcepto[cMerc.id]).toBe(500);
      expect(r.total).toBe(675.5);
    });

    it('rechaza filtros inválidos', async () => {
      expect((await auth(request(app).get(`/api/sumatorias/${subId}/resumen?mes=2026-13`))).status).toBe(400);
      expect((await auth(request(app).get(`/api/sumatorias/${subId}/resumen?origen=otro`))).status).toBe(400);
    });
  });

  describe('resumen general', () => {
    it('agrupa conceptos por nombre (sin mayúsculas, acentos ni espacios) y coincide con cada subrubro', async () => {
      const otro = (await auth(request(app).post(`/api/subrubros/${rubroId}`)).send({
        nombre: 'Retiro Juan', tipo_subrubro: 'sumatoria',
        conceptos: [{ nombre: '  retiro   EFECTIVO ' }, { nombre: 'Retiro mercaderia', mostrar_en_caja: false }],
      })).body;
      const [jEfvo, jMerc] = (await auth(request(app).get(`/api/sumatorias/${otro.id}/conceptos`))).body;

      await cargar({ concepto_id: cEfvo.id, fecha: '2026-03-01', monto: 100, origen: 'caja', metodo: 'efectivo' });
      await cargar({ concepto_id: cMerc.id, fecha: '2026-03-02', monto: 40, origen: 'subrubro' });
      await cargar({ concepto_id: jEfvo.id, fecha: '2026-03-03', monto: 60, origen: 'caja', metodo: 'efectivo' }, otro.id);
      await cargar({ concepto_id: jMerc.id, fecha: '2026-03-04', monto: 10, origen: 'subrubro' }, otro.id);

      const g = (await auth(request(app).get('/api/sumatorias/resumen-general?desde=2026-03-01&hasta=2026-03-31'))).body;
      expect(g.total).toBe(210);
      const cols = Object.fromEntries(g.columnas.map(c => [c.clave, c.total]));
      expect(cols).toEqual({ 'retiro efectivo': 160, 'retiro mercaderia': 50 });

      // Los totales por fila coinciden con el resumen de cada subrubro.
      for (const fila of g.filas) {
        const r = (await auth(request(app).get(`/api/sumatorias/${fila.id}/resumen?desde=2026-03-01&hasta=2026-03-31`))).body;
        expect(fila.total).toBe(r.total);
      }

      const soloCaja = (await auth(request(app).get('/api/sumatorias/resumen-general?origen=caja'))).body;
      expect(soloCaja.total).toBe(160);
      const soloEfvo = (await auth(request(app).get(`/api/sumatorias/resumen-general?conceptos=${encodeURIComponent('Retiro Efectivo')}`))).body;
      expect(soloEfvo.total).toBe(160);
      const soloJuan = (await auth(request(app).get(`/api/sumatorias/resumen-general?subrubros=${otro.id}`))).body;
      expect(soloJuan.total).toBe(70);
    });
  });

  describe('conceptos', () => {
    it('con cargas se desactiva; sin cargas se elimina', async () => {
      await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 5, origen: 'subrubro' });
      const d1 = await auth(request(app).delete(`/api/sumatorias/conceptos/${cEfvo.id}`));
      expect(d1.body).toMatchObject({ eliminado: false, desactivado: true });
      expect((await ConceptoSumatoria.findById(cEfvo.id).lean()).activo).toBe(false);
      const d2 = await auth(request(app).delete(`/api/sumatorias/conceptos/${cTrans.id}`));
      expect(d2.body).toMatchObject({ eliminado: true });
      expect(await ConceptoSumatoria.findById(cTrans.id).lean()).toBeNull();
    });

    it('un concepto desactivado no admite cargas nuevas', async () => {
      await auth(request(app).put(`/api/sumatorias/conceptos/${cEfvo.id}`)).send({ activo: false });
      const r = await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 5, origen: 'subrubro' });
      expect(r.status).toBe(400);
    });

    it('no admite nombres repetidos (sin distinguir mayúsculas ni acentos)', async () => {
      const r = await auth(request(app).post(`/api/sumatorias/${subId}/conceptos`)).send({ nombre: 'RETIRO mercaderia' });
      expect(r.status).toBe(409);
    });

    it('crea, reordena y cambia mostrar_en_caja', async () => {
      const nuevo = (await auth(request(app).post(`/api/sumatorias/${subId}/conceptos`)).send({ nombre: 'Retiro dólares', mostrar_en_caja: false })).body;
      expect(nuevo.orden).toBe(3);
      const orden = await auth(request(app).put(`/api/sumatorias/${subId}/conceptos-orden`)).send({ ids: [nuevo.id, cMerc.id, cEfvo.id, cTrans.id] });
      expect(orden.body.map(c => c.id)).toEqual([nuevo.id, cMerc.id, cEfvo.id, cTrans.id]);
      await auth(request(app).put(`/api/sumatorias/conceptos/${cMerc.id}`)).send({ mostrar_en_caja: true });
      const r = await cargar({ concepto_id: cMerc.id, fecha: hoy(), monto: 1, origen: 'caja', metodo: 'efectivo' });
      expect(r.status).toBe(200);
    });
  });

  describe('validaciones e integraciones', () => {
    it('rechaza fechas futuras, montos inválidos y conceptos de otro subrubro', async () => {
      expect((await cargar({ concepto_id: cEfvo.id, fecha: sumarDias(hoy(), 1), monto: 5, origen: 'subrubro' })).status).toBe(400);
      expect((await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 0, origen: 'subrubro' })).status).toBe(400);
      expect((await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 5, origen: 'otro' })).status).toBe(400);
      const otro = (await auth(request(app).post(`/api/subrubros/${rubroId}`)).send({ nombre: 'Otro', tipo_subrubro: 'sumatoria', conceptos: [{ nombre: 'X' }] })).body;
      const [cx] = (await auth(request(app).get(`/api/sumatorias/${otro.id}/conceptos`))).body;
      expect((await cargar({ concepto_id: cx.id, fecha: hoy(), monto: 5, origen: 'subrubro' })).status).toBe(400);
    });

    it('medianoche en Argentina: a las 23:30 (02:30 UTC del día siguiente) sigue siendo el mismo día', () => {
      expect(hoyLocal(new Date('2026-10-18T02:30:00Z'))).toBe('2026-10-17');
      expect(hoyLocal(new Date('2026-10-18T03:00:00Z'))).toBe('2026-10-18');
    });

    it('la carga de hoy (fecha Argentina) se acepta y cae en la Caja de hoy', async () => {
      const r = await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 5, origen: 'caja', metodo: 'efectivo' });
      expect(r.status).toBe(200);
      expect((await cajaDia(hoy())).movs.some(m => m.sumatoria_mov_id === r.body.id)).toBe(true);
    });

    it('un subrubro sumatoria no admite facturas/pagos ni gastos de Caja vinculados', async () => {
      const mov = await auth(request(app).post(`/api/movimientos/${subId}`)).send({ tipo: 'factura', monto: 100, fecha: hoy() });
      expect(mov.status).toBe(400);
      const caja = await auth(request(app).post('/api/caja')).send({ fecha: hoy(), tipo: 'gasto', concepto: 'x', monto: 10, metodo: 'efectivo', subrubro_id: subId });
      expect(caja.status).toBe(400);
    });

    it('no se puede cambiar el tipo de un subrubro con datos', async () => {
      await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 5, origen: 'subrubro' });
      expect((await auth(request(app).put(`/api/subrubros/${subId}`)).send({ tipo_subrubro: 'factura' })).status).toBe(400);
      await auth(request(app).post(`/api/movimientos/${provSubId}`)).send({ tipo: 'factura', monto: 100, fecha: hoy() });
      expect((await auth(request(app).put(`/api/subrubros/${provSubId}`)).send({ tipo_subrubro: 'sumatoria' })).status).toBe(400);
    });

    it('las operaciones de sumatoria no cambian los totales de facturas del dashboard', async () => {
      await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 999, origen: 'caja', metodo: 'efectivo' });
      const r = (await auth(request(app).get('/api/dashboard/resumen'))).body;
      expect(r.facturadoMes).toBe(0);
      expect(r.pagadoMes).toBe(0);
      expect(r.deudaTotal).toBe(0);
    });

    it('auditoría: registra altas, ediciones y bajas con su origen', async () => {
      const r = await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 5, origen: 'caja', metodo: 'efectivo' });
      await auth(request(app).put(`/api/sumatorias/movimientos/${r.body.id}`)).send({ monto: 6 });
      await auth(request(app).delete(`/api/sumatorias/movimientos/${r.body.id}`));
      const audits = await Audit.find({ recurso: 'sumatoria_movimiento' }).sort({ _id: 1 }).lean();
      expect(audits.map(a => a.accion)).toEqual(['create', 'update', 'delete']);
      expect(audits[0].diff.response.origen).toBe('caja');
      expect(audits[1].diff.before.origen).toBe('caja');
      expect(audits[2].diff.before).toMatchObject({ origen: 'caja', monto: 6 });
      expect(await Audit.countDocuments({ recurso: 'sumatoria_concepto' })).toBe(0);
      await auth(request(app).post(`/api/sumatorias/${subId}/conceptos`)).send({ nombre: 'Nuevo' });
      expect(await Audit.countDocuments({ recurso: 'sumatoria_concepto', accion: 'create' })).toBe(1);
    });

    it('backup: exporta conceptos y cargas con su origen', async () => {
      await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 5, origen: 'caja', metodo: 'efectivo' });
      await cargar({ concepto_id: cMerc.id, fecha: hoy(), monto: 7, origen: 'subrubro' });
      const res = await auth(request(app).get('/api/backup/export'), superToken)
        .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
      expect(res.status).toBe(200);
      const zip = new AdmZip(res.body);
      const movs = JSON.parse(zip.getEntry('sumatoria_movimientos.json').getData().toString('utf8'));
      expect(movs.map(m => m.origen).sort()).toEqual(['caja', 'subrubro']);
      const conceptos = JSON.parse(zip.getEntry('sumatoria_conceptos.json').getData().toString('utf8'));
      expect(conceptos).toHaveLength(3);
      const dump = JSON.parse(zip.getEntry('backup.json').getData().toString('utf8'));
      expect(dump.data.MovimientoSumatoria).toHaveLength(2);
    });

    it('borrar el subrubro: borra cargas y conceptos, y el gasto de Caja queda desvinculado', async () => {
      const r = await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 5, origen: 'caja', metodo: 'efectivo' });
      await auth(request(app).delete(`/api/subrubros/${subId}`));
      expect(await MovimientoSumatoria.countDocuments()).toBe(0);
      expect(await ConceptoSumatoria.countDocuments({ subrubro_id: subId })).toBe(0);
      const item = await CajaMovimiento.findById(r.body.caja_mov_id).lean();
      expect(item).toMatchObject({ monto: 5, metodo: 'efectivo', origen: null, sumatoria_mov_id: null, subrubro_id: null });
    });

    it('inconsistencias: detecta un espejo de Caja desincronizado', async () => {
      const r = await cargar({ concepto_id: cEfvo.id, fecha: hoy(), monto: 5, origen: 'caja', metodo: 'efectivo' });
      await CajaMovimiento.updateOne({ _id: r.body.caja_mov_id }, { $set: { monto: 99 } });
      const { buscarInconsistencias } = require('../utils/inconsistencias');
      const res = await buscarInconsistencias();
      expect(res.checks.find(c => c.key === 'sumatoria_desincronizada').cantidad).toBe(1);
    });
  });
});
