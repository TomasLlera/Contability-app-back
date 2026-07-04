const express = require('express');
const router = express.Router();
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { audit } = require('../middleware/audit');

async function sendVencimientosEmail(to, vencimientos) {
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const fmt = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n ?? 0);

  const rows = vencimientos.map(v => {
    const estado = v.dias_restantes < 0
      ? `<span style="color:#dc2626">Vencida hace ${Math.abs(v.dias_restantes)} día${Math.abs(v.dias_restantes) !== 1 ? 's' : ''}</span>`
      : v.dias_restantes === 0
        ? `<span style="color:#dc2626">Vence hoy</span>`
        : `<span style="color:#d97706">Vence en ${v.dias_restantes} día${v.dias_restantes !== 1 ? 's' : ''}</span>`;
    return `
      <tr style="border-bottom:1px solid #e2e8f0">
        <td style="padding:10px 12px">${v.subrubro?.nombre || '-'}</td>
        <td style="padding:10px 12px;color:#64748b">${v.rubro?.nombre || '-'}</td>
        <td style="padding:10px 12px;font-weight:600">${fmt(v.monto)}</td>
        <td style="padding:10px 12px">${v.fecha_vencimiento}</td>
        <td style="padding:10px 12px">${estado}</td>
      </tr>`;
  }).join('');

  const html = `
    <div style="font-family:sans-serif;max-width:640px;margin:0 auto;color:#1e293b">
      <div style="background:#1e40af;padding:24px;border-radius:12px 12px 0 0">
        <h1 style="margin:0;color:white;font-size:20px">⚠️ Alerta de vencimientos</h1>
        <p style="margin:6px 0 0;color:#bfdbfe;font-size:14px">${vencimientos.length} factura${vencimientos.length !== 1 ? 's' : ''} requieren atención</p>
      </div>
      <div style="background:#f8fafc;padding:0;border-radius:0 0 12px 12px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="background:#e2e8f0">
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Proveedor</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Rubro</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Monto</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Vencimiento</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Estado</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p style="font-size:12px;color:#94a3b8;margin-top:16px;text-align:center">Contabilidad App</p>
    </div>`;

  await resend.emails.send({
    from: 'Contabilidad <alertas@resend.dev>',
    to,
    subject: `⚠️ ${vencimientos.length} factura${vencimientos.length !== 1 ? 's' : ''} por vencer`,
    html,
  });
}

// GET /api/config
router.get('/', async (req, res, next) => {
  try {
    const cfg = await db.getConfig();
    res.json(cfg);
  } catch (err) { next(err); }
});

// PUT /api/config
router.put('/', requireAdmin, audit('app_config'), async (req, res, next) => {
  try {
    const allowed = ['email_alertas', 'alertas_activas', 'dias_anticipacion', 'dashboard_tablas'];
    const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const cfg = await db.updateConfig(data);
    res.json(cfg);
  } catch (err) { next(err); }
});

// POST /api/config/test-email — envía un email de prueba con los vencimientos actuales
router.post('/test-email', requireAdmin, async (req, res, next) => {
  try {
    const cfg = await db.getConfig();
    if (!cfg.email_alertas) return res.status(400).json({ error: 'No hay email configurado' });
    if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY no configurada en el servidor' });
    const vencimientos = await db.getVencimientos(cfg.dias_anticipacion || 7);
    if (vencimientos.length === 0) return res.status(200).json({ message: 'No hay vencimientos próximos para enviar' });
    await sendVencimientosEmail(cfg.email_alertas, vencimientos);
    res.json({ message: `Email enviado a ${cfg.email_alertas} con ${vencimientos.length} vencimiento${vencimientos.length !== 1 ? 's' : ''}` });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.sendVencimientosEmail = sendVencimientosEmail;
