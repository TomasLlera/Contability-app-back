const { setupTestDb } = require('./setup');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const app = require('../server');
const { IvaCompra, IvaVenta, IvaConfig } = require('../models');

setupTestDb();

// Firmamos los tokens directo (sin /auth/login) para no toparnos con el rate-limit
// del login, que se satura al hacer muchos logins en una misma suite.
const adminToken = jwt.sign({ usuario: 'admin', role: 'admin', userId: 1 }, process.env.JWT_SECRET);
const viewerToken = jwt.sign({ usuario: 'viewer', role: 'viewer', userId: 2 }, process.env.JWT_SECRET);

const HEADERS = ['Fecha', 'Tipo', 'Documento', 'Nro Doc Emisor', 'Razon Social', 'IVA 21', 'Neto Grav. 21%', 'Neto Gravado', 'Otros Atributos', 'Total IVA', 'Imp. Total'];

// Construye un buffer .xlsx a partir de filas (arrays). `titleRows` agrega filas de título arriba del header.
function buildXlsx(dataRows, { titleRows = 0, sheetName = 'Compras' } = {}) {
  const aoa = [];
  for (let i = 0; i < titleRows; i++) aoa.push([`TITULO ${i + 1}`]);
  aoa.push(HEADERS);
  aoa.push(...dataRows);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const FILA_MARZO_1 = ['05/03/2024', 'Factura A', 'CUIT', '30-111', 'PROV S.A.', '21000', '100000', '100000', '', '21000', '121000'];
const FILA_MARZO_2 = ['18/03/2024', 'Factura B', 'CUIT', '30-222', 'OTRO SRL', '10500', '50000', '50000', 'x', '10500', '60500'];
const FILA_ABRIL_1 = ['10/04/2024', 'Factura A', 'CUIT', '30-111', 'PROV S.A.', '4200', '20000', '20000', '', '4200', '24200'];

const importExcel = (token, buffer, name = 'compras.xlsx', sheet) => {
  let req = request(app).post('/api/iva/compras/import')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', buffer, name);
  if (sheet) req = req.field('sheet', sheet);
  return req;
};

describe('IVA — Compras (import Excel)', () => {

  it('viewer no puede importar (403)', async () => {
    const res = await importExcel(viewerToken, buildXlsx([FILA_MARZO_1]));
    expect(res.status).toBe(403);
  });

  it('parsea todas las columnas y agrupa por mes', async () => {
    const res = await importExcel(adminToken, buildXlsx([FILA_MARZO_1, FILA_MARZO_2]));
    expect(res.status).toBe(200);
    expect(res.body.importadas).toBe(2);

    const filas = await IvaCompra.find({}).sort({ fecha: 1 }).lean();
    expect(filas).toHaveLength(2);
    const f = filas[0];
    expect(f.fecha).toBe('2024-03-05');
    expect(f.mes).toBe('2024-03');
    expect(f.razon_social).toBe('PROV S.A.');
    expect(f.tipo).toBe('Factura A');
    expect(f.nro_doc).toBe('30-111');
    expect(f.iva_21).toBe(21000);
    expect(f.neto_gravado).toBe(100000);
    expect(f.total_iva).toBe(21000);
    expect(f.imp_total).toBe(121000);
  });

  it('detecta la fila de encabezado cuando hay filas de título (AFIP)', async () => {
    const res = await importExcel(adminToken, buildXlsx([FILA_MARZO_1], { titleRows: 2 }), 'afip.xlsx', 'Compras');
    expect(res.status).toBe(200);
    expect(res.body.importadas).toBe(1);
    const f = await IvaCompra.findOne({}).lean();
    expect(f.imp_total).toBe(121000);
    expect(f.razon_social).toBe('PROV S.A.');
  });

  it('acumula múltiples archivos sin reemplazar', async () => {
    await importExcel(adminToken, buildXlsx([FILA_MARZO_1, FILA_MARZO_2]), 'marzo.xlsx');
    const res = await importExcel(adminToken, buildXlsx([FILA_ABRIL_1]), 'abril.xlsx');
    expect(res.body.importadas).toBe(1);
    expect(await IvaCompra.countDocuments()).toBe(3);
  });

  it('omite duplicados (misma fecha + razón social + imp. total)', async () => {
    await importExcel(adminToken, buildXlsx([FILA_MARZO_1, FILA_MARZO_2]), 'a.xlsx');
    // Reimportar el mismo contenido → todo duplicado
    const res = await importExcel(adminToken, buildXlsx([FILA_MARZO_1, FILA_MARZO_2]), 'b.xlsx');
    expect(res.body.importadas).toBe(0);
    expect(res.body.duplicadas).toBe(2);
    expect(await IvaCompra.countDocuments()).toBe(2);

    // Archivo con 1 repetida + 1 nueva
    const res2 = await importExcel(adminToken, buildXlsx([FILA_MARZO_1, FILA_ABRIL_1]), 'c.xlsx');
    expect(res2.body.importadas).toBe(1);
    expect(res2.body.duplicadas).toBe(1);
  });

  it('expone los lotes con archivo y cantidad de filas', async () => {
    await importExcel(adminToken, buildXlsx([FILA_MARZO_1, FILA_MARZO_2]), 'marzo.xlsx');
    const res = await request(app).get('/api/iva/compras/lotes').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].archivo).toBe('marzo.xlsx');
    expect(res.body[0].filas).toBe(2);
    expect(res.body[0].imp_total).toBe(181500);
  });

  it('borra un lote por su id', async () => {
    const imp = await importExcel(adminToken, buildXlsx([FILA_MARZO_1]), 'm.xlsx');
    const lote = imp.body.lote;
    const del = await request(app).delete('/api/iva/compras').query({ lote }).set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    expect(await IvaCompra.countDocuments()).toBe(0);
  });
});

describe('IVA — Config de columnas', () => {

  it('devuelve las 11 columnas con sus defaults', async () => {
    const res = await request(app).get('/api/iva/config').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.columns).toHaveLength(11);
    expect(res.body.columns.find(c => c.key === 'imp_total').default).toBe('Imp. Total');
  });

  it('guarda overrides solo cuando difieren del default', async () => {
    await request(app).put('/api/iva/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mapping: { razon_social: 'Proveedor X', imp_total: 'Imp. Total' } });
    const cfg = await IvaConfig.findById('main').lean();
    expect(cfg.mapping.razon_social).toBe('Proveedor X'); // distinto del default → guardado
    expect(cfg.mapping.imp_total).toBeUndefined();          // igual al default → no guardado
  });

  it('viewer no puede guardar config (403)', async () => {
    const res = await request(app).put('/api/iva/config')
      .set('Authorization', `Bearer ${viewerToken}`).send({ mapping: {} });
    expect(res.status).toBe(403);
  });
});

describe('IVA — Ventas (carga manual)', () => {

  it('crea una venta y la agrupa por mes', async () => {
    const res = await request(app).post('/api/iva/ventas')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fecha: '2024-03-20', total: 200000, concepto: 'Ventas marzo' });
    expect(res.status).toBe(200);
    expect(res.body.mes).toBe('2024-03');
    expect(res.body.total).toBe(200000);
  });

  it('rechaza monto 0 o fecha inválida', async () => {
    const r1 = await request(app).post('/api/iva/ventas').set('Authorization', `Bearer ${adminToken}`).send({ fecha: '2024-03-20', total: 0 });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/iva/ventas').set('Authorization', `Bearer ${adminToken}`).send({ fecha: 'no-fecha', total: 100 });
    expect(r2.status).toBe(400);
  });

  it('viewer no puede cargar ventas (403)', async () => {
    const res = await request(app).post('/api/iva/ventas').set('Authorization', `Bearer ${viewerToken}`).send({ fecha: '2024-03-20', total: 100 });
    expect(res.status).toBe(403);
  });
});

describe('IVA — Cruce mensual (resumen)', () => {

  it('calcula la diferencia ventas - compras por mes y los totales', async () => {
    // Marzo: compras imp 181500, ventas 200000 → +18500 (a favor)
    // Abril: compras imp 24200, ventas 15000 → -9200 (en contra)
    await importExcel(adminToken, buildXlsx([FILA_MARZO_1, FILA_MARZO_2, FILA_ABRIL_1]), 'todo.xlsx');
    await request(app).post('/api/iva/ventas').set('Authorization', `Bearer ${adminToken}`).send({ fecha: '2024-03-20', total: 200000 });
    await request(app).post('/api/iva/ventas').set('Authorization', `Bearer ${adminToken}`).send({ fecha: '2024-04-15', total: 15000 });

    const res = await request(app).get('/api/iva/resumen').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const marzo = res.body.meses.find(m => m.mes === '2024-03');
    const abril = res.body.meses.find(m => m.mes === '2024-04');
    expect(marzo.compras.imp_total).toBe(181500);
    expect(marzo.compras.total_iva).toBe(31500);
    expect(marzo.ventas).toBe(200000);
    expect(marzo.diferencia).toBe(168500); // ventas 200000 - IVA compras 31500
    expect(abril.diferencia).toBe(10800);  // ventas 15000 - IVA compras 4200

    expect(res.body.totales.compras_imp_total).toBe(205700);
    expect(res.body.totales.ventas).toBe(215000);
    expect(res.body.totales.diferencia).toBe(179300); // 168500 + 10800
  });

  it('meses vienen ordenados del más reciente al más antiguo', async () => {
    await importExcel(adminToken, buildXlsx([FILA_MARZO_1, FILA_ABRIL_1]), 'x.xlsx');
    const res = await request(app).get('/api/iva/resumen').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.meses[0].mes).toBe('2024-04');
    expect(res.body.meses[1].mes).toBe('2024-03');
  });

  it('las notas de crédito restan del total y se desglosan por tipo', async () => {
    // Marzo: Factura A 121000 + Nota de Crédito 60500 (resta) → neto 60500
    const NC_MARZO = ['20/03/2024', 'Nota de Crédito A', 'CUIT', '30-111', 'PROV S.A.', '10500', '50000', '50000', '', '10500', '60500'];
    await importExcel(adminToken, buildXlsx([FILA_MARZO_1, NC_MARZO]), 'nc.xlsx');

    const res = await request(app).get('/api/iva/resumen').set('Authorization', `Bearer ${adminToken}`);
    const marzo = res.body.meses.find(m => m.mes === '2024-03');
    expect(marzo.compras.imp_total).toBe(60500);          // 121000 - 60500
    expect(marzo.compras.facturas).toBe(121000);
    expect(marzo.compras.notas_credito).toBe(60500);
    expect(marzo.compras.por_tipo['Nota de Crédito A'].es_nc).toBe(true);
    expect(marzo.compras.por_tipo['Factura A'].es_nc).toBe(false);

    expect(res.body.totales.compras_imp_total).toBe(60500);
    expect(res.body.totales.compras_notas_credito).toBe(60500);
    expect(res.body.tipos.find(t => t.tipo === 'Nota de Crédito A').es_nc).toBe(true);
  });
});

describe('IVA — Export del cruce mensual', () => {

  it('exporta el cruce en Excel con datos cargados', async () => {
    await importExcel(adminToken, buildXlsx([FILA_MARZO_1, FILA_ABRIL_1]), 'todo.xlsx');
    await request(app).post('/api/iva/ventas').set('Authorization', `Bearer ${adminToken}`).send({ fecha: '2024-03-20', total: 200000 });

    const res = await request(app).get('/api/iva/export-resumen')
      .set('Authorization', `Bearer ${adminToken}`).buffer().parse((r, cb) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('exporta el cruce en PDF con datos cargados', async () => {
    await importExcel(adminToken, buildXlsx([FILA_MARZO_1, FILA_ABRIL_1]), 'todo.xlsx');
    await request(app).post('/api/iva/ventas').set('Authorization', `Bearer ${adminToken}`).send({ fecha: '2024-03-20', total: 200000 });

    const res = await request(app).get('/api/iva/export-resumen-pdf')
      .set('Authorization', `Bearer ${adminToken}`).buffer().parse((r, cb) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });
});
