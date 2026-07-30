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

  it('sin tipo explícito la venta queda como ticket (no inventa facturación)', async () => {
    const { body } = await crearVenta({ fecha: '2024-03-05', monto: 15000 });
    expect(body.tipo).toBe('ticket');
  });

  it('rechaza un tipo de venta desconocido', async () => {
    expect((await crearVenta({ tipo: 'remito', fecha: '2024-03-05', monto: 100 })).status).toBe(400);
  });

  it('reclasifica ticket ↔ facturado por PUT', async () => {
    const { body: venta } = await crearVenta({ tipo: 'ticket', fecha: '2024-03-05', monto: 100 });
    const upd = await auth(request(app).put(`/api/registro/ventas-sistema/${venta.id}`)).send({ tipo: 'facturado' });
    expect(upd.status).toBe(200);
    expect(upd.body.tipo).toBe('facturado');

    expect((await auth(request(app).put(`/api/registro/ventas-sistema/${venta.id}`)).send({ tipo: 'nada' })).status).toBe(400);
  });

  it('las ventas guardadas sin tipo se leen como ticket', async () => {
    // Simula una carga previa a que existiera el campo: se inserta sin `tipo`.
    await VentaSistema.collection.insertOne({ _id: 9001, fecha: '2024-03-05', mes: '2024-03', monto: 7000, concepto: 'legacy' });

    const res = await auth(request(app).get('/api/registro/ventas-sistema/mes/2024-03'));
    expect(res.body.total).toBe(7000);
    expect(res.body.total_ticket).toBe(7000);
    expect(res.body.total_facturado).toBe(0);
    expect(res.body.iva_21).toBe(0);
    expect(res.body.ventas[0].tipo).toBe('ticket');
  });

  it('separa ticket y facturado, y el IVA 21% sale SOLO del facturado', async () => {
    await crearVenta({ tipo: 'ticket',    fecha: '2024-03-05', monto: 40000 });
    await crearVenta({ tipo: 'facturado', fecha: '2024-03-05', monto: 100000 });
    await crearVenta({ tipo: 'facturado', fecha: '2024-03-20', monto: 50000 });

    const dia = await auth(request(app).get('/api/registro/ventas-sistema/dia/2024-03-05'));
    expect(dia.body).toMatchObject({ total: 140000, total_ticket: 40000, total_facturado: 100000, iva_21: 21000, alicuota: 0.21 });
    expect(dia.body.por_tipo.ticket).toMatchObject({ total: 40000, cantidad: 1 });

    const mes = await auth(request(app).get('/api/registro/ventas-sistema/mes/2024-03'));
    // Total = ticket + facturado; IVA = 21% de 150.000 (el ticket no lo genera).
    expect(mes.body).toMatchObject({ total: 190000, total_ticket: 40000, total_facturado: 150000, iva_21: 31500 });
    // Serie diaria desglosada por tipo, para poder apilarla en el gráfico.
    expect(mes.body.serie[4]).toMatchObject({ dia: 5, ticket: 40000, facturado: 100000, total: 140000 });
    expect(mes.body.comparativa_tipos.facturado).toMatchObject({ actual: 150000, anterior: 0, porcentaje: null });
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

describe('Comparativa mensual — Facturado vs Tarjetas', () => {
  // 50.000 QR + 30.000 débito + 60.000 crédito + 10.000 prepaga = 150.000.
  const cargarMesTarjetas = async () => {
    await crearTarjeta({ tipo: 'qr',      fecha: '2026-07-03', monto: 50000 });
    await crearTarjeta({ tipo: 'debito',  fecha: '2026-07-10', monto: 30000 });
    await crearTarjeta({ tipo: 'credito', fecha: '2026-07-17', monto: 60000 });
    await crearTarjeta({ tipo: 'prepaga', fecha: '2026-07-24', monto: 10000 });
  };

  it('tarjetas no expone IVA: el 21% sale solo del facturado de Venta Sistema', async () => {
    await cargarMesTarjetas();
    const tarj = await auth(request(app).get('/api/registro/tarjetas/mes/2026-07'));
    expect(tarj.body.total).toBe(150000);
    expect(tarj.body.iva_21).toBeUndefined();
    expect(tarj.body.alicuota).toBeUndefined();
    expect(tarj.body.mes_anterior.iva_21).toBeUndefined();
  });

  it('el endpoint de IVA de tarjetas ya no existe', async () => {
    expect((await auth(request(app).get('/api/registro/tarjetas/iva/2026-07'))).status).toBe(404);
  });

  it('alerta cuando tarjetas supera lo facturado (cobros sin facturar)', async () => {
    await cargarMesTarjetas();                                                  // 150.000 por tarjeta
    await crearVenta({ tipo: 'facturado', fecha: '2026-07-05', monto: 120000 }); // 120.000 facturados
    await crearVenta({ tipo: 'ticket',    fecha: '2026-07-05', monto: 90000 });  // fuera del cruce

    const res = await auth(request(app).get('/api/registro/comparativa-ventas/2026-07'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mes: '2026-07', anio: 2026,
      total_facturado: 120000, total_tarjetas: 150000,
      diferencia: 30000, alerta: true, estado: 'faltan_en_sistema',
    });
    // El ticket NO entra en la comparación, pero se informa aparte junto al total.
    expect(res.body.venta_sistema).toMatchObject({
      total: 210000, total_ticket: 90000, total_facturado: 120000, iva_21: 25200, cantidad: 2,
    });
    expect(res.body.tarjetas).toMatchObject({ total: 150000, transacciones: 4 });
    // Porcentaje sobre el mayor de los dos: 30.000 / 150.000 = 20%.
    expect(res.body.porcentaje).toBe(20);
  });

  it('un mes cargado 100% como ticket deja lo facturado en cero', async () => {
    await crearTarjeta({ tipo: 'qr', fecha: '2026-07-03', monto: 50000 });
    await crearVenta({ tipo: 'ticket', fecha: '2026-07-05', monto: 50000 });

    const res = await auth(request(app).get('/api/registro/comparativa-ventas/2026-07'));
    expect(res.body.total_facturado).toBe(0);
    expect(res.body.diferencia).toBe(50000);
    expect(res.body.estado).toBe('faltan_en_sistema');
  });

  it('alerta a la inversa cuando lo facturado supera a tarjetas', async () => {
    await crearTarjeta({ tipo: 'qr', fecha: '2026-07-03', monto: 50000 });
    await crearVenta({ tipo: 'facturado', fecha: '2026-07-05', monto: 100000 });

    const res = await auth(request(app).get('/api/registro/comparativa-ventas/2026-07'));
    expect(res.body.diferencia).toBe(-50000);
    expect(res.body.alerta).toBe(true);
    expect(res.body.estado).toBe('faltan_en_tarjetas');
  });

  it('sin alerta cuando coinciden, y sin_datos si el mes está vacío', async () => {
    await crearTarjeta({ tipo: 'qr', fecha: '2026-07-03', monto: 150000 });
    await crearVenta({ tipo: 'facturado', fecha: '2026-07-05', monto: 150000 });

    const igual = await auth(request(app).get('/api/registro/comparativa-ventas/2026-07'));
    expect(igual.body.diferencia).toBe(0);
    expect(igual.body.alerta).toBe(false);
    expect(igual.body.estado).toBe('coincide');

    const vacio = await auth(request(app).get('/api/registro/comparativa-ventas/2026-09'));
    expect(vacio.body.estado).toBe('sin_datos');
    expect(vacio.body.alerta).toBe(false);
    expect(vacio.body.porcentaje).toBeNull();
  });

  it('desglosa la diferencia por día, con el ticket como columna informativa', async () => {
    await crearTarjeta({ tipo: 'qr', fecha: '2026-07-03', monto: 50000 });
    await crearVenta({ tipo: 'facturado', fecha: '2026-07-03', monto: 50000 });  // ese día cierra
    await crearTarjeta({ tipo: 'debito', fecha: '2026-07-10', monto: 30000 });   // este no
    await crearVenta({ tipo: 'ticket', fecha: '2026-07-10', monto: 30000 });     // cargado como ticket

    const { body } = await auth(request(app).get('/api/registro/comparativa-ventas/2026-07'));
    expect(body.por_dia).toHaveLength(31);
    expect(body.por_dia[2]).toMatchObject({ dia: 3, total_tarjetas: 50000, total_facturado: 50000, total_ticket: 0, diferencia: 0 });
    expect(body.por_dia[9]).toMatchObject({ dia: 10, total_tarjetas: 30000, total_facturado: 0, total_ticket: 30000, diferencia: 30000 });
  });

  it('rechaza un mes con formato inválido', async () => {
    expect((await auth(request(app).get('/api/registro/comparativa-ventas/2026-7'))).status).toBe(400);
    expect((await auth(request(app).get('/api/registro/comparativa-ventas/julio'))).status).toBe(400);
  });
});
