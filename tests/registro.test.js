const { setupTestDb } = require('./setup');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const { VentaSistema, TarjetaTransaccion } = require('../models');

setupTestDb();

// Firmamos los tokens directo (sin /auth/login) para no toparnos con el rate-limit.
const adminToken = jwt.sign({ usuario: 'admin', role: 'admin', userId: 1 }, process.env.JWT_SECRET);
const viewerToken = jwt.sign({ usuario: 'viewer', role: 'viewer', userId: 2 }, process.env.JWT_SECRET);

const auth = (req, token = adminToken) => req.set('Authorization', `Bearer ${token}`);

const crearVenta = (body, token = adminToken) =>
  auth(request(app).post('/api/registro/ventas-sistema'), token).send(body);
const crearTarjeta = (body, token = adminToken) =>
  auth(request(app).post('/api/registro/tarjetas'), token).send(body);

describe('Registro → Venta Sistema', () => {
  it('crea una venta y la agrupa por mes', async () => {
    const res = await crearVenta({ fecha: '2024-03-05', monto: 15000, concepto: 'Mostrador' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fecha: '2024-03-05', mes: '2024-03', monto: 15000 });
    expect(res.body.id).toBeDefined();

    const doc = await VentaSistema.findById(res.body.id).lean();
    expect(doc.user_id).toBe(1);
  });

  it('rechaza monto <= 0 y fecha inválida', async () => {
    expect((await crearVenta({ fecha: '2024-03-05', monto: 0 })).status).toBe(400);
    expect((await crearVenta({ fecha: 'no-es-fecha', monto: 100 })).status).toBe(400);
  });

  it('un viewer no puede crear, editar ni borrar', async () => {
    const { body: venta } = await crearVenta({ fecha: '2024-03-05', monto: 100 });
    expect((await crearVenta({ fecha: '2024-03-06', monto: 100 }, viewerToken)).status).toBe(403);
    expect((await auth(request(app).put(`/api/registro/ventas-sistema/${venta.id}`), viewerToken).send({ monto: 5 })).status).toBe(403);
    expect((await auth(request(app).delete(`/api/registro/ventas-sistema/${venta.id}`), viewerToken)).status).toBe(403);
  });

  it('devuelve el total y el detalle del día', async () => {
    await crearVenta({ fecha: '2024-03-05', monto: 1000 });
    await crearVenta({ fecha: '2024-03-05', monto: 500 });
    await crearVenta({ fecha: '2024-03-06', monto: 999 });

    const res = await auth(request(app).get('/api/registro/ventas-sistema/dia/2024-03-05'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1500);
    expect(res.body.ventas).toHaveLength(2);
  });

  it('arma el resumen mensual: comparativa, serie diaria, quincenas y stats', async () => {
    await crearVenta({ fecha: '2024-02-10', monto: 1000 }); // mes anterior
    await crearVenta({ fecha: '2024-03-03', monto: 500 });  // 1ª quincena
    await crearVenta({ fecha: '2024-03-20', monto: 1500 }); // 2ª quincena

    const res = await auth(request(app).get('/api/registro/ventas-sistema/mes/2024-03'));
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.total).toBe(2000);
    expect(b.mes_anterior).toMatchObject({ mes: '2024-02', total: 1000 });
    expect(b.comparativa).toEqual({ diferencia: 1000, porcentaje: 100 });
    expect(b.serie).toHaveLength(31);             // marzo
    expect(b.serie[2].total).toBe(500);           // día 3
    expect(b.quincenas[0].total).toBe(500);
    expect(b.quincenas[1].total).toBe(1500);
    expect(b.semanas[0].total).toBe(500);         // S1 = días 1-7
    expect(b.stats).toMatchObject({ dias_con_ventas: 2, promedio_diario: 1000 });
    expect(b.stats.maximo.dia).toBe(20);
    expect(b.stats.minimo.dia).toBe(3);
  });

  it('sin mes anterior el porcentaje es null (no divide por cero)', async () => {
    await crearVenta({ fecha: '2024-03-03', monto: 500 });
    const res = await auth(request(app).get('/api/registro/ventas-sistema/mes/2024-03'));
    expect(res.body.comparativa).toEqual({ diferencia: 500, porcentaje: null });
  });

  it('edita y elimina una venta', async () => {
    const { body: venta } = await crearVenta({ fecha: '2024-03-05', monto: 100 });

    const upd = await auth(request(app).put(`/api/registro/ventas-sistema/${venta.id}`))
      .send({ monto: 300, fecha: '2024-04-01' });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ monto: 300, fecha: '2024-04-01', mes: '2024-04' });

    expect((await auth(request(app).delete(`/api/registro/ventas-sistema/${venta.id}`))).status).toBe(200);
    expect(await VentaSistema.countDocuments()).toBe(0);
  });
});

describe('Registro → Tarjetas', () => {
  it('rechaza un tipo desconocido', async () => {
    const res = await crearTarjeta({ tipo: 'cripto', fecha: '2024-03-05', monto: 100 });
    expect(res.status).toBe(400);
  });

  it('deja los campos de retención/acreditación en null (todavía sin activar)', async () => {
    const { body } = await crearTarjeta({ tipo: 'credito', fecha: '2024-03-05', monto: 100 });
    const doc = await TarjetaTransaccion.findById(body.id).lean();
    expect(doc.retencion_pct).toBeNull();
    expect(doc.monto_neto).toBeNull();
    expect(doc.fecha_acreditacion).toBeNull();
  });

  it('el resumen del día trae las 4 columnas y el total consolidado', async () => {
    await crearTarjeta({ tipo: 'qr', fecha: '2024-03-05', monto: 100, empleado: 'Ana' });
    await crearTarjeta({ tipo: 'qr', fecha: '2024-03-05', monto: 50, empleado: 'Ana' });
    await crearTarjeta({ tipo: 'debito', fecha: '2024-03-05', monto: 200, empleado: 'Beto' });

    const res = await auth(request(app).get('/api/registro/tarjetas/dia/2024-03-05'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(350);
    expect(res.body.por_tipo.qr).toMatchObject({ total: 150, transacciones: 2 });
    expect(res.body.por_tipo.debito.total).toBe(200);
    // Los tipos sin movimiento vienen igual, en cero (el front dibuja 4 columnas fijas).
    expect(res.body.por_tipo.credito).toMatchObject({ total: 0, transacciones: 0 });
    expect(res.body.por_tipo.prepaga).toMatchObject({ total: 0, transacciones: 0 });
  });

  it('agrupa por empleado y manda los sin empleado a "Sin asignar"', async () => {
    await crearTarjeta({ tipo: 'qr', fecha: '2024-03-05', monto: 100, empleado: 'Ana' });
    await crearTarjeta({ tipo: 'credito', fecha: '2024-03-05', monto: 400, empleado: 'Ana' });
    await crearTarjeta({ tipo: 'debito', fecha: '2024-03-05', monto: 50 }); // sin empleado

    const res = await auth(request(app).get('/api/registro/tarjetas/dia/2024-03-05'));
    // Ordenado por total desc: Ana (500) antes que Sin asignar (50).
    expect(res.body.por_empleado[0]).toMatchObject({ empleado: 'Ana', total: 500, qr: 100, credito: 400, transacciones: 2 });
    expect(res.body.por_empleado[1]).toMatchObject({ empleado: 'Sin asignar', total: 50, debito: 50 });

    const mesRes = await auth(request(app).get('/api/registro/tarjetas/mes/2024-03'));
    expect(mesRes.body.por_empleado[0]).toMatchObject({ empleado: 'Ana', total: 500 });
  });

  it('el resumen mensual arma la serie apilada y compara contra el mes anterior', async () => {
    await crearTarjeta({ tipo: 'qr', fecha: '2024-02-10', monto: 100 });     // mes anterior
    await crearTarjeta({ tipo: 'qr', fecha: '2024-03-02', monto: 300 });
    await crearTarjeta({ tipo: 'credito', fecha: '2024-03-02', monto: 200 });

    const res = await auth(request(app).get('/api/registro/tarjetas/mes/2024-03'));
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.total).toBe(500);
    expect(b.mes_anterior).toMatchObject({ mes: '2024-02', total: 100 });
    expect(b.comparativa).toEqual({ diferencia: 400, porcentaje: 400 });
    expect(b.comparativa_tipos.qr).toMatchObject({ actual: 300, anterior: 100, diferencia: 200 });
    expect(b.comparativa_tipos.credito).toMatchObject({ actual: 200, anterior: 0, porcentaje: null });
    expect(b.serie[1]).toMatchObject({ dia: 2, qr: 300, credito: 200, debito: 0, prepaga: 0, total: 500 });
  });

  it('edita el tipo y el monto, y elimina la transacción', async () => {
    const { body: tx } = await crearTarjeta({ tipo: 'qr', fecha: '2024-03-05', monto: 100 });

    const upd = await auth(request(app).put(`/api/registro/tarjetas/${tx.id}`))
      .send({ tipo: 'prepaga', monto: 250 });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ tipo: 'prepaga', monto: 250 });

    expect((await auth(request(app).delete(`/api/registro/tarjetas/${tx.id}`))).status).toBe(200);
    expect(await TarjetaTransaccion.countDocuments()).toBe(0);
  });
});

describe('IVA de Tarjetas y cruce con Venta Sistema', () => {
  // Ejemplo del pedido: 50.000 QR + 30.000 débito + 60.000 crédito + 10.000 prepaga
  // = 150.000 → IVA 21% = 31.500.
  const cargarMesTarjetas = async () => {
    await crearTarjeta({ tipo: 'qr',      fecha: '2026-07-03', monto: 50000 });
    await crearTarjeta({ tipo: 'debito',  fecha: '2026-07-10', monto: 30000 });
    await crearTarjeta({ tipo: 'credito', fecha: '2026-07-17', monto: 60000 });
    await crearTarjeta({ tipo: 'prepaga', fecha: '2026-07-24', monto: 10000 });
  };

  it('el resumen mensual de tarjetas expone el IVA 21% del total', async () => {
    await cargarMesTarjetas();
    const res = await auth(request(app).get('/api/registro/tarjetas/mes/2026-07'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(150000);
    expect(res.body.iva_21).toBe(31500);
    expect(res.body.alicuota).toBe(0.21);
  });

  it('GET /tarjetas/iva/:mes devuelve total e IVA del mes', async () => {
    await cargarMesTarjetas();
    const res = await auth(request(app).get('/api/registro/tarjetas/iva/2026-07'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mes: '2026-07', alicuota: 0.21,
      total_tarjetas: 150000, iva_tarjetas: 31500, transacciones: 4,
    });
  });

  it('el IVA sigue a las transacciones: al borrar una, baja solo', async () => {
    const { body: tx } = await crearTarjeta({ tipo: 'qr', fecha: '2026-07-03', monto: 50000 });
    await crearTarjeta({ tipo: 'debito', fecha: '2026-07-10', monto: 30000 });
    expect((await auth(request(app).get('/api/registro/tarjetas/iva/2026-07'))).body.iva_tarjetas).toBe(16800);

    await auth(request(app).delete(`/api/registro/tarjetas/${tx.id}`));
    expect((await auth(request(app).get('/api/registro/tarjetas/iva/2026-07'))).body.iva_tarjetas).toBe(6300);
  });

  it('el mes de ventas del sistema expone su propio IVA 21%', async () => {
    await crearVenta({ fecha: '2026-07-05', monto: 100000 });
    const res = await auth(request(app).get('/api/registro/ventas-sistema/mes/2026-07'));
    expect(res.body.total).toBe(100000);
    expect(res.body.iva_21).toBe(21000);
  });

  it('alerta cuando tarjetas supera a venta sistema (falta cargar en el sistema)', async () => {
    await cargarMesTarjetas();                                    // IVA 31.500
    await crearVenta({ fecha: '2026-07-05', monto: 100000 });      // IVA 21.000

    const res = await auth(request(app).get('/api/registro/comparativa-iva/2026-07'));
    expect(res.status).toBe(200);
    expect(res.body.tarjetas).toMatchObject({ total: 150000, iva: 31500 });
    expect(res.body.venta_sistema).toMatchObject({ total: 100000, iva: 21000 });
    expect(res.body.diferencia).toBe(10500);
    expect(res.body.alerta).toBe(true);
    expect(res.body.estado).toBe('faltan_en_sistema');
  });

  it('alerta a la inversa cuando venta sistema supera a tarjetas', async () => {
    await crearTarjeta({ tipo: 'qr', fecha: '2026-07-03', monto: 50000 });  // IVA 10.500
    await crearVenta({ fecha: '2026-07-05', monto: 100000 });               // IVA 21.000

    const res = await auth(request(app).get('/api/registro/comparativa-iva/2026-07'));
    expect(res.body.diferencia).toBe(-10500);
    expect(res.body.alerta).toBe(true);
    expect(res.body.estado).toBe('faltan_en_tarjetas');
  });

  it('sin alerta cuando coinciden, y sin_datos si el mes está vacío', async () => {
    await crearTarjeta({ tipo: 'qr', fecha: '2026-07-03', monto: 80000 });
    await crearVenta({ fecha: '2026-07-05', monto: 80000 });

    const igual = await auth(request(app).get('/api/registro/comparativa-iva/2026-07'));
    expect(igual.body.diferencia).toBe(0);
    expect(igual.body.alerta).toBe(false);
    expect(igual.body.estado).toBe('coincide');

    const vacio = await auth(request(app).get('/api/registro/comparativa-iva/2026-09'));
    expect(vacio.body.estado).toBe('sin_datos');
    expect(vacio.body.alerta).toBe(false);
  });

  it('desglosa la diferencia por día', async () => {
    await crearTarjeta({ tipo: 'qr', fecha: '2026-07-03', monto: 50000 });
    await crearVenta({ fecha: '2026-07-03', monto: 50000 });   // ese día cierra
    await crearTarjeta({ tipo: 'debito', fecha: '2026-07-10', monto: 30000 }); // este no

    const { body } = await auth(request(app).get('/api/registro/comparativa-iva/2026-07'));
    expect(body.por_dia).toHaveLength(31);
    expect(body.por_dia[2]).toMatchObject({ dia: 3, iva_tarjetas: 10500, iva_venta_sistema: 10500, diferencia: 0 });
    expect(body.por_dia[9]).toMatchObject({ dia: 10, iva_tarjetas: 6300, iva_venta_sistema: 0, diferencia: 6300 });
  });

  it('rechaza un mes con formato inválido', async () => {
    expect((await auth(request(app).get('/api/registro/comparativa-iva/2026-7'))).status).toBe(400);
    expect((await auth(request(app).get('/api/registro/tarjetas/iva/julio'))).status).toBe(400);
  });
});
