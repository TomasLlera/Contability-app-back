# Contability App — Backend

API REST de la aplicación de contabilidad **CA-Gestión / Contability**. Gestiona
locales, rubros, subrubros y movimientos (facturas, pagos, notas, ajustes), con
importación/exportación de Excel, caja, stock, IVA, alertas por email y auditoría
completa de mutaciones.

- **Producción:** https://contability-app-back.onrender.com
- **Frontend:** https://contability-app-front.vercel.app

## Stack

- **Node.js + Express** (puerto `3001`)
- **MongoDB Atlas** vía **Mongoose**
- **JWT** para autenticación · **bcryptjs** para hashing
- **helmet** + **express-rate-limit** para hardening
- **pino** para logging estructurado (con redacción de campos sensibles)
- **xlsx** import/export · **pdfkit** para PDFs · **resend** para emails
- **Jest + supertest + mongodb-memory-server** para tests

## Requisitos

- Node.js 20+
- Una base MongoDB (Atlas o local)

## Puesta en marcha

```bash
cd backend
npm install
cp .env.example .env   # y completá las variables (ver abajo)
npm run dev            # nodemon con auto-reload en http://localhost:3001
```

## Variables de entorno (`.env`)

| Variable          | Requerida | Descripción                                                        |
|-------------------|:---------:|--------------------------------------------------------------------|
| `MONGODB_URI`     |     ✅     | Connection string de MongoDB Atlas                                 |
| `JWT_SECRET`      |     ✅     | Secreto de **al menos 32 caracteres** (se valida al iniciar)       |
| `PORT`            |     —     | Puerto del servidor (default `3001`)                               |
| `ALLOWED_ORIGINS` |     —     | Orígenes CORS separados por coma. Vacío = `*` (solo dev)           |
| `LOG_LEVEL`       |     —     | Nivel de pino (`info` por default)                                 |
| `NODE_ENV`        |     —     | `production` recomendado en prod                                   |
| `ADMIN_USER`      |     —     | Usuario admin a sembrar si la DB no tiene usuarios                 |
| `ADMIN_PASSWORD`  |     —     | Hash bcrypt del admin a sembrar                                    |
| `RESEND_API_KEY`  |     —     | Key de Resend para alertas por email                              |

El servidor **valida las variables requeridas al arrancar** y aborta si faltan.

## Scripts

```bash
npm run dev         # nodemon (auto-reload)
npm start           # node server.js (producción)
npm test            # jest + mongodb-memory-server (--runInBand)
npm run test:watch  # jest en modo watch
npm test -- tests/movimientos.test.js   # un solo archivo
npm test -- -t "nombre del test"        # un solo test por nombre
npm run backup      # exporta toda la DB a backups/backup-<ts>.json
npm run restore -- backups/<archivo>.json [--drop]
node migrate.js     # one-shot: importa contability.json legacy a Mongo (destructivo)
```

## Estructura

```
backend/
├── server.js            # Entry: Express, JWT middleware, rate-limit, shutdown limpio
├── db.js                # Toda la lógica de negocio y queries (CRUD, cálculos, dedup)
├── models.js            # Schemas Mongoose + IDs auto-increment (Counter)
├── logger.js            # pino con redacción de password/token (fallback a console)
├── middleware/
│   ├── errorHandler.js  # async wrapper + handler global
│   ├── requireAdmin.js  # rol admin
│   └── audit.js         # registra cada mutación (redacta passwords)
├── routes/              # una por recurso (ver abajo)
├── scripts/             # backup.js / restore.js
└── tests/               # jest + supertest + mongodb-memory-server
```

## API

Todas las rutas cuelgan de `/api`. Salvo `/api/auth` y `/api/health`, **requieren JWT**
(header `Authorization: Bearer <token>`).

| Recurso        | Ruta base            | Notas                                        |
|----------------|----------------------|----------------------------------------------|
| Health         | `GET /api/health`    | Público, sin JWT. Estado de Mongo + uptime   |
| Auth           | `/api/auth`          | Login (rate-limited), refresh                |
| Locales        | `/api/locales`       |                                              |
| Rubros         | `/api/rubros`        | Incluye import-config de Excel               |
| Subrubros      | `/api/subrubros`     |                                              |
| Campos         | `/api/campos`        | Campos custom por rubro                      |
| Categorías     | `/api/categorias`    | Reglas de cálculo                            |
| Movimientos    | `/api/movimientos`   | Entidad central. Vencimientos, search, export|
| Caja           | `/api/caja`          | Subsistema de caja                           |
| Stock          | `/api/stock`         | Productos + movimientos de stock             |
| Dashboard      | `/api/dashboard`     | Resúmenes, tendencias, comparaciones         |
| Config         | `/api/config`        | Singleton `AppConfig` (alertas, dashboard)   |
| Users          | `/api/users`         | Solo admin                                   |
| Audit          | `/api/audit`         | Solo admin, paginado                         |

## Modelo de datos

```
Local → Rubro → Subrubro → Movimiento
                        ↑
                   Campo (campos custom por Rubro)
                   Categoria (reglas de cálculo)
```

- **Movimiento** es la entidad central (facturas, pagos, notas, ajustes). Soporta
  pagos vinculados (`facturas_vinculadas_ids`) y campos extra (`campos_extra`).
- **Producto + MovimientoStock** — subsistema de inventario.
- **CajaMovimiento + CajaConfig** — subsistema de caja.
- **AppConfig** — singleton de settings globales (alertas por email, días de
  anticipación, tablas del dashboard).

## Auth y roles

- Roles: `admin` (acceso total) y `viewer` (solo lectura).
- Las rutas admin usan el middleware `requireAdmin`.
- Si no hay usuarios en la DB, se siembra uno desde `ADMIN_USER` / `ADMIN_PASSWORD`.
- Logins exitosos y fallidos quedan registrados en `Audit`.

## Auditoría

Toda mutación pasa por el middleware `audit(recurso)` y se persiste en la colección
`Audit`: usuario, IP, acción (`create`/`update`/`delete`/`login`/`login_failed`),
recurso, `recurso_id` y un `diff` con payload y respuesta (passwords/tokens
redactados). Consultable en `GET /api/audit` (solo admin).

## Deploy

Desplegado en **Render**. Cada push a `main` dispara el redeploy automático.

> ⚠️ Ocasionalmente Render no redespliega hasta forzarlo desde su dashboard.
