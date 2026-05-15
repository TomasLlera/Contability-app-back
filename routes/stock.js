const express = require('express');
const router = express.Router();
const { Producto, MovimientoStock, Counter, Subrubro } = require('../models');
const requireAdmin = require('../middleware/requireAdmin');

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
    const id = await Counter.next('movimientos_stock');
    const mov = await MovimientoStock.create({
      _id: id, producto_id: Number(producto_id), tipo, cantidad: cant,
      observacion: observacion || '', fecha: fecha || now(), created_at: new Date().toISOString(),
    });
    // Actualizar stock_actual del producto
    const delta = tipo === 'entrada' ? cant : tipo === 'salida' ? -cant : cant;
    if (tipo === 'ajuste') {
      await Producto.findByIdAndUpdate(Number(producto_id), { stock_actual: cant });
    } else {
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

module.exports = router;
