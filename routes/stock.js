const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { Producto, MovimientoStock, Counter, Subrubro, Rubro } = require('../models');
const requireAdmin = require('../middleware/requireAdmin');
const upload = multer({ storage: multer.memoryStorage() });

const now = () => new Date().toISOString().split('T')[0];
const withId = doc => doc ? { ...doc, id: doc._id } : doc;

// GET /api/stock/productos
router.get('/productos', async (req, res, next) => {
  try {
    const productos = await Producto.find({ activo: true }).lean();
    // Enriquecer con nombre del subrubro si tiene
    const subIds = [...new Set(productos.filter(p => p.subrubro_id).map(p => p.subrubro_id))];
    const subs = subIds.length ? await Subrubro.find({ _id: { $in: subIds } }, { nombre: 1 }).lean() : [];
    const subMap = Object.fromEntries(subs.map(s => [s._id, s.nombre]));
    res.json(productos.map(p => ({ ...withId(p), subrubro_nombre: subMap[p.subrubro_id] || null })));
  } catch (err) { next(err); }
});

// POST /api/stock/productos
router.post('/productos', requireAdmin, async (req, res, next) => {
  try {
    const { nombre, categoria, descripcion, unidad, precio_costo, precio_venta, stock_actual, stock_minimo, subrubro_id } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const id = await Counter.next('productos');
    const p = await Producto.create({
      _id: id, nombre, categoria: categoria || '', descripcion: descripcion || '',
      unidad: unidad || 'unidad',
      precio_costo: Number(precio_costo) || 0,
      precio_venta: Number(precio_venta) || 0,
      stock_actual: Number(stock_actual) || 0,
      stock_minimo: Number(stock_minimo) || 0,
      subrubro_id: subrubro_id ? Number(subrubro_id) : null,
      activo: true, created_at: now(),
    });
    res.json(withId(p.toObject()));
  } catch (err) { next(err); }
});

// PUT /api/stock/productos/bulk-precio
router.put('/productos/bulk-precio', requireAdmin, async (req, res, next) => {
  try {
    const { ids, campo, tipo, valor } = req.body;
    if (!ids?.length || !campo || !tipo || valor === undefined) return res.status(400).json({ error: 'Faltan campos' });
    const v = Number(valor);
    const productos = await Producto.find({ _id: { $in: ids.map(Number) }, activo: true }).lean();

    const aplicar = (precio) => {
      if (!precio) return precio;
      if (tipo === 'porcentaje') return Math.round(precio * (1 + v / 100));
      if (tipo === 'monto') return Math.round(precio + v);
      if (tipo === 'fijar') return v;
      return precio;
    };

    await Promise.all(productos.map(p => {
      const upd = {};
      if (campo === 'costo' || campo === 'ambos') upd.precio_costo = aplicar(p.precio_costo);
      if (campo === 'venta' || campo === 'ambos') upd.precio_venta = aplicar(p.precio_venta);
      return Producto.findByIdAndUpdate(p._id, upd);
    }));

    res.json({ ok: true, updated: productos.length });
  } catch (err) { next(err); }
});

// PUT /api/stock/productos/:id
router.put('/productos/:id', requireAdmin, async (req, res, next) => {
  try {
    const allowed = ['nombre', 'categoria', 'descripcion', 'unidad', 'precio_costo', 'precio_venta', 'stock_minimo', 'subrubro_id'];
    const upd = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (upd.precio_costo !== undefined) upd.precio_costo = Number(upd.precio_costo);
    if (upd.precio_venta !== undefined) upd.precio_venta = Number(upd.precio_venta);
    if (upd.stock_minimo !== undefined) upd.stock_minimo = Number(upd.stock_minimo);
    if (upd.subrubro_id !== undefined) upd.subrubro_id = upd.subrubro_id ? Number(upd.subrubro_id) : null;
    await Producto.findByIdAndUpdate(Number(req.params.id), upd);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/stock/productos/:id (soft delete)
router.delete('/productos/:id', requireAdmin, async (req, res, next) => {
  try {
    await Producto.findByIdAndUpdate(Number(req.params.id), { activo: false });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/stock/movimientos/:productoId
router.get('/movimientos/:productoId', async (req, res, next) => {
  try {
    const movs = await MovimientoStock.find({ producto_id: Number(req.params.productoId) }).sort({ fecha: -1, _id: -1 }).lean();
    res.json(movs.map(withId));
  } catch (err) { next(err); }
});

// POST /api/stock/movimientos — entrada, salida o ajuste
router.post('/movimientos', requireAdmin, async (req, res, next) => {
  try {
    const { producto_id, tipo, cantidad, observacion, fecha } = req.body;
    if (!producto_id || !tipo || !cantidad) return res.status(400).json({ error: 'Faltan campos' });
    if (!['entrada', 'salida', 'ajuste'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });
    const cant = Number(cantidad);
    const producto = await Producto.findById(Number(producto_id)).lean();
    const id = await Counter.next('movimientos_stock');
    const mov = await MovimientoStock.create({
      _id: id, producto_id: Number(producto_id), tipo, cantidad: cant,
      precio_costo: tipo === 'salida' ? (producto?.precio_costo || null) : null,
      precio_venta: tipo === 'salida' ? (producto?.precio_venta || null) : null,
      observacion: observacion || '', fecha: fecha || now(), created_at: new Date().toISOString(),
    });
    if (tipo === 'ajuste') {
      await Producto.findByIdAndUpdate(Number(producto_id), { stock_actual: cant });
    } else {
      const delta = tipo === 'entrada' ? cant : -cant;
      await Producto.findByIdAndUpdate(Number(producto_id), { $inc: { stock_actual: delta } });
    }
    res.json(withId(mov.toObject()));
  } catch (err) { next(err); }
});

// GET /api/stock/alertas — productos con stock bajo
router.get('/alertas', async (req, res, next) => {
  try {
    const productos = await Producto.find({ activo: true }).lean();
    const bajos = productos.filter(p => p.stock_minimo > 0 && p.stock_actual <= p.stock_minimo);
    res.json(bajos.map(withId));
  } catch (err) { next(err); }
});

// GET /api/stock/export-productos — descarga Excel con todos los productos
router.get('/export-productos', async (req, res, next) => {
  try {
    const productos = await Producto.find({ activo: true }).lean();
    const subIds = [...new Set(productos.filter(p => p.subrubro_id).map(p => p.subrubro_id))];
    const subs = subIds.length ? await Subrubro.find({ _id: { $in: subIds } }, { nombre: 1 }).lean() : [];
    const subMap = Object.fromEntries(subs.map(s => [s._id, s.nombre]));

    const rows = productos.map(p => ({
      Nombre: p.nombre,
      Categoría: p.categoria || '',
      Unidad: p.unidad || 'unidad',
      'Stock Actual': p.stock_actual || 0,
      'Stock Mínimo': p.stock_minimo || 0,
      'Precio Costo': p.precio_costo || 0,
      'Precio Venta': p.precio_venta || 0,
      Subrubro: subMap[p.subrubro_id] || '',
      Descripción: p.descripcion || '',
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [20, 15, 10, 12, 12, 14, 14, 20, 25].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Productos');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="productos.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { next(err); }
});

// POST /api/stock/import-productos — importa productos desde Excel
router.post('/import-productos', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    if (!rows.length) return res.json({ creados: 0, actualizados: 0 });

    // Cargar subrubros para matching
    const allSubs = await Subrubro.find({}, { nombre: 1 }).lean();
    const subByNombre = Object.fromEntries(allSubs.map(s => [s.nombre.toLowerCase().trim(), s._id]));

    let creados = 0, actualizados = 0;
    for (const row of rows) {
      const nombre = (row['Nombre'] || row['nombre'] || '').toString().trim();
      if (!nombre) continue;
      const subrubroNombre = (row['Subrubro'] || row['subrubro'] || '').toString().trim().toLowerCase();
      const subrubro_id = subrubroNombre ? (subByNombre[subrubroNombre] || null) : null;
      const data = {
        nombre,
        categoria: (row['Categoría'] || row['Categoria'] || row['categoria'] || '').toString().trim(),
        unidad: (row['Unidad'] || row['unidad'] || 'unidad').toString().trim(),
        stock_actual: Number(row['Stock Actual'] ?? row['stock_actual'] ?? 0),
        stock_minimo: Number(row['Stock Mínimo'] ?? row['Stock Minimo'] ?? row['stock_minimo'] ?? 0),
        precio_costo: Number(row['Precio Costo'] ?? row['precio_costo'] ?? 0),
        precio_venta: Number(row['Precio Venta'] ?? row['precio_venta'] ?? 0),
        descripcion: (row['Descripción'] || row['Descripcion'] || row['descripcion'] || '').toString().trim(),
        subrubro_id,
      };
      const existing = await Producto.findOne({ nombre: { $regex: `^${nombre}$`, $options: 'i' }, activo: true });
      if (existing) {
        await Producto.findByIdAndUpdate(existing._id, data);
        actualizados++;
      } else {
        const id = await Counter.next('productos');
        await Producto.create({ _id: id, ...data, activo: true, created_at: now() });
        creados++;
      }
    }
    res.json({ creados, actualizados });
  } catch (err) { next(err); }
});

// GET /api/stock/graficas — ventas y ganancia agrupadas por periodo
router.get('/graficas', async (req, res, next) => {
  try {
    const { vista = 'mes', anio } = req.query;
    const year = Number(anio) || new Date().getFullYear();
    const MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

    let query = { tipo: 'salida', precio_venta: { $gt: 0 } };
    if (vista === 'dia') {
      const desde = new Date(); desde.setDate(desde.getDate() - 29);
      query.fecha = { $gte: desde.toISOString().split('T')[0] };
    } else {
      query.fecha = { $gte: `${year}-01-01`, $lte: `${year}-12-31` };
    }

    const movs = await MovimientoStock.find(query).lean();

    const grouped = {};
    for (const m of movs) {
      let key, label;
      if (vista === 'dia') {
        key = m.fecha; label = m.fecha.slice(5); // MM-DD
      } else if (vista === 'mes') {
        key = m.fecha.slice(0, 7); label = MESES[Number(m.fecha.slice(5, 7)) - 1];
      } else { // anio
        key = m.fecha.slice(0, 4); label = key;
      }
      if (!grouped[key]) grouped[key] = { periodo: key, label, ganancia: 0, ingresos: 0, unidades: 0 };
      grouped[key].ganancia += ((m.precio_venta || 0) - (m.precio_costo || 0)) * m.cantidad;
      grouped[key].ingresos += (m.precio_venta || 0) * m.cantidad;
      grouped[key].unidades += m.cantidad;
    }

    // Para vista mes, rellenar meses sin datos
    if (vista === 'mes') {
      for (let i = 0; i < 12; i++) {
        const key = `${year}-${String(i + 1).padStart(2, '0')}`;
        if (!grouped[key]) grouped[key] = { periodo: key, label: MESES[i], ganancia: 0, ingresos: 0, unidades: 0 };
      }
    }

    const datos = Object.values(grouped).sort((a, b) => a.periodo.localeCompare(b.periodo));
    const totales = datos.reduce((acc, d) => ({
      ganancia: acc.ganancia + d.ganancia,
      ingresos: acc.ingresos + d.ingresos,
      unidades: acc.unidades + d.unidades,
    }), { ganancia: 0, ingresos: 0, unidades: 0 });

    res.json({ datos, totales, anio: year });
  } catch (err) { next(err); }
});

module.exports = router;
