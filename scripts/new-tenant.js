#!/usr/bin/env node
// Genera los secretos (JWT_SECRET + credenciales de superadmin) para levantar
// una instancia nueva de la app para otro comercio.
//
// NO toca ninguna base de datos: solo imprime el bloque de variables de entorno
// que tenés que pegar en Render (backend) y el recordatorio de Vercel (frontend).
//
// Uso:
//   node scripts/new-tenant.js <nombre-comercio> [usuario_admin] [password_admin]
//
// Si no pasás usuario -> "admin". Si no pasás password -> se genera una aleatoria.
// El seed del superadmin es lazy: se crea en el PRIMER login usando ADMIN_USER /
// ADMIN_PASSWORD, así que basta con setear estas vars y entrar una vez.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function randomPassword(len = 16) {
  // Sin caracteres ambiguos (0/O, 1/l) para que sea fácil de dictar.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

async function main() {
  const [comercio, usuarioArg, passArg] = process.argv.slice(2);

  if (!comercio) {
    console.error('Falta el nombre del comercio.\n');
    console.error('Uso: node scripts/new-tenant.js <nombre-comercio> [usuario_admin] [password_admin]');
    process.exit(1);
  }

  const usuario = (usuarioArg || 'admin').trim().toLowerCase();
  const password = passArg || randomPassword();
  const generada = !passArg;

  const jwtSecret = crypto.randomBytes(48).toString('base64url'); // ~64 chars, > 32 requerido
  const passHash = await bcrypt.hash(password, 10);

  const line = '='.repeat(64);
  console.log(`\n${line}`);
  console.log(`  INSTANCIA NUEVA — ${comercio}`);
  console.log(line);

  console.log('\n[1] Variables de entorno del BACKEND (Render → Environment):\n');
  console.log(`MONGODB_URI=<connection string de la base NUEVA de este comercio>`);
  console.log(`JWT_SECRET=${jwtSecret}`);
  console.log(`ALLOWED_ORIGINS=<url del frontend de este comercio en Vercel>`);
  console.log(`NODE_ENV=production`);
  console.log(`ADMIN_USER=${usuario}`);
  console.log(`ADMIN_PASSWORD=${passHash}`);
  console.log(`# (opcional) RESEND_API_KEY=<key para alertas por email>`);

  console.log('\n[2] Credenciales para ENTREGAR al comercio (guardalas seguras):\n');
  console.log(`   Usuario:    ${usuario}`);
  console.log(`   Contraseña: ${password}${generada ? '   <-- generada, anotala ahora' : ''}`);
  console.log(`   (la contraseña en claro NO se guarda en ningún lado; en la base va solo el hash)`);

  console.log('\n[3] Frontend (Vercel):');
  console.log(`   VITE_API_URL=<url del backend de este comercio en Render>`);

  console.log(`\n${line}`);
  console.log('  Recordá: base de datos NUEVA y JWT_SECRET ÚNICO por comercio.');
  console.log(`${line}\n`);
}

main().catch(err => {
  console.error('Error generando secretos:', err.message);
  process.exit(1);
});
