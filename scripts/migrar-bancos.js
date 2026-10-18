#!/usr/bin/env node
// Migración a multi-banco (Caja del Día). Idempotente: se puede correr varias veces.
//
//   node scripts/migrar-bancos.js --dry-run              # solo informa qué cambiaría
//   node scripts/migrar-bancos.js                        # aplica
//   node scripts/migrar-bancos.js --nombre "Banco Galicia"
//
// 1. Si no hay ningún banco, crea uno (por defecto "Banco principal") como predeterminado.
// 2. Le asigna los saldos en cuenta y todo lo que es transferencia sin banco:
//    ítems de Caja, pagos de subrubros y cargas de sumatoria (solo los que tienen
//    banco_id null: correrlo de nuevo no cambia nada).
// 3. Verifica que, día por día, el saldo en cuenta y los gastos / ingresos por
//    transferencia den exactamente lo mismo antes y después. Si no, sale con error.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const iNombre = args.indexOf('--nombre');
const NOMBRE = iNombre >= 0 && args[iNombre + 1] ? args[iNombre + 1] : 'Banco principal';
// --banco "Banco Provincia" (nombre o id): banco EXISTENTE al que va el historial,
// aunque no sea el predeterminado.
const iBanco = args.indexOf('--banco');
const BANCO = iBanco >= 0 && args[iBanco + 1] ? args[iBanco + 1] : null;

// Totales por día que la migración no puede cambiar.
async function totalesPorDia(CajaMovimiento) {
  const r = await CajaMovimiento.aggregate([
    { $match: { $or: [{ tipo: 'saldo_cuenta' }, { metodo: 'transferencia' }] } },
    { $group: { _id: { fecha: '$fecha', tipo: '$tipo' }, total: { $sum: '$monto' }, n: { $sum: 1 } } },
  ]);
  return new Map(r.map(x => [`${x._id.fecha}|${x._id.tipo}`, `${Math.round(x.total * 100) / 100}#${x.n}`]));
}

async function main() {
  if (!process.env.MONGODB_URI) { console.error('MONGODB_URI no definida'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI);
  const { Banco, CajaMovimiento, Movimiento, MovimientoSumatoria, Counter } = require('../models');

  console.log(DRY ? '== MODO PRUEBA (no se escribe nada) ==' : '== MIGRACIÓN A MULTI-BANCO ==');
  const antes = await totalesPorDia(CajaMovimiento);

  let banco;
  if (BANCO) {
    banco = /^\d+$/.test(BANCO)
      ? await Banco.findById(Number(BANCO)).lean()
      : await Banco.findOne({ nombre: { $regex: new RegExp(`^${BANCO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } }).lean();
    if (!banco) { console.error(`No existe el banco "${BANCO}"`); await mongoose.disconnect(); process.exit(1); }
  } else {
    banco = await Banco.findOne({ es_predeterminado: true }).lean() || await Banco.findOne().sort({ orden: 1, _id: 1 }).lean();
  }
  if (banco) {
    console.log(`Banco existente: #${banco._id} "${banco.nombre}" (se usa para lo que no tiene banco)`);
  } else if (DRY) {
    console.log(`Crearía el banco "${NOMBRE}" como predeterminado`);
  } else {
    const id = await Counter.next('bancos');
    await Banco.create({ _id: id, nombre: NOMBRE, color: '#2563eb', es_predeterminado: true, activo: true, orden: 0, created_at: new Date().toISOString() });
    banco = await Banco.findById(id).lean();
    console.log(`Creado el banco #${id} "${NOMBRE}" (predeterminado)`);
  }

  const filtros = [
    ['Saldos en cuenta', CajaMovimiento, { tipo: 'saldo_cuenta', banco_id: null }],
    ['Ítems de Caja por transferencia', CajaMovimiento, { tipo: { $ne: 'saldo_cuenta' }, metodo: 'transferencia', banco_id: null }],
    ['Pagos de subrubros por transferencia', Movimiento, { tipo: 'pago', metodo_pago: 'transferencia', banco_id: null }],
    ['Cargas de sumatoria por transferencia', MovimientoSumatoria, { metodo: 'transferencia', banco_id: null }],
  ];
  for (const [label, Model, filtro] of filtros) {
    const n = await Model.countDocuments(filtro);
    if (DRY || !banco) {
      console.log(`${label}: ${n} ${DRY ? 'se asignarían' : 'sin banco'}`);
    } else {
      const r = await Model.updateMany(filtro, { $set: { banco_id: banco._id } });
      console.log(`${label}: ${r.modifiedCount} asignados al banco #${banco._id}`);
    }
  }

  const despues = await totalesPorDia(CajaMovimiento);
  const distintos = [...new Set([...antes.keys(), ...despues.keys()])].filter(k => antes.get(k) !== despues.get(k));
  if (distintos.length) {
    console.error(`ERROR: ${distintos.length} totales diarios cambiaron:`, distintos.slice(0, 10));
    await mongoose.disconnect();
    process.exit(2);
  }
  console.log(`Verificación OK: ${antes.size} totales diarios idénticos antes y después.`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
