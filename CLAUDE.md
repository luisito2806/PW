# Doo Barber — sistema de citas para barberías (SaaS en desarrollo)

Programa de reservas para barberías que se quiere vender a varios negocios
(marca blanca). En el futuro se quiere usar también para profesionistas 1 a 1
(terapeutas, nutriólogos, etc.), así que conviene no amarrar el código a la
palabra "barbero". Todo el texto de la interfaz está en español de México.

## Estructura

Corre en **Cloudflare Workers** (API con Hono) + **D1** (base de datos SQLite de Cloudflare).

- `src/index.js` — rutas de la API (`/api/*`), login, sesiones y respaldos.
- `src/agenda.js` — horarios, fechas en la zona de la barbería y `calcularDisponibilidad()`.
- `src/config.js` — configuración del negocio (`obtenerConfig()`, `CONFIG_EDITABLE`) y validaciones.
- `src/db.js` — atajos `dbGet` / `dbAll` / `dbRun` sobre D1.
- `migrations/` — esquema de la base de datos. Para cambiar tablas se agrega un archivo
  nuevo (`0002_...sql`); nunca se edita uno ya aplicado.
- `wrangler.jsonc` — configuración de Cloudflare: base D1, zona horaria y archivos estáticos.
- `frontend/` — se sirve tal cual como archivos estáticos (Cloudflare redirige
  `/admin.html` → `/admin`, etc.). `_headers` agrega cabeceras de seguridad.
  - `index.html` — sitio público donde el cliente reserva (servicio → barbero → fecha/hora → datos).
  - `admin.html` — panel del dueño: agenda, walk-in, mover citas, bloqueos, reportes, configuración.
  - `login.html` — acceso al panel.
  - `privacidad.html` — Aviso de Privacidad (LFPDPPP); los datos del responsable se
    configuran en el panel y llegan por `/api/marca`.
  - `tema.js` — compartido por las pantallas: aplica el color de la barbería
    (`aplicarColorPrimario()`) y pinta el logo o el monograma (`pintarMarca()`).

HTML, CSS y JS de cada pantalla van en el mismo archivo, sin frameworks ni build
(la única excepción es `tema.js`).

## Cómo correrlo en tu computadora

```bash
npm install
cp .dev.vars.example .dev.vars     # y pon tu contraseña en ADMIN_PASSWORD
npm run db:migrar:local            # crea la base local (solo la primera vez o con migraciones nuevas)
npm run dev                        # http://localhost:8787 (clientes) y /login (panel)
```

La base local vive en `.wrangler/` (no se sube al repo). En Windows, si PowerShell
bloquea `npm`, usar `npm.cmd`. npm 11+ bloquea scripts de instalación no aprobados:
`esbuild` y `workerd` están aprobados en `allowScripts` de `package.json`.

## Producción (una copia por barbería en Cloudflare, plan gratis)

Cada barbería tiene su propio Worker y su propia base D1:
1. `npx wrangler login`
2. `npx wrangler d1 create doo-barber` y copiar el `database_id` en `wrangler.jsonc`
   (para otra barbería: otro `name` y otra base).
3. `npm run db:migrar` (aplica `migrations/` en Cloudflare).
4. `npx wrangler secret put ADMIN_PASSWORD` (la contraseña del panel; no está en la BD).
5. `npm run deploy`
6. Dominio propio: en Cloudflare, Workers → el Worker → Settings → Domains & Routes → Custom domain
   (el dominio debe estar en Cloudflare; HTTPS automático).

Respaldos: D1 guarda el historial de 7 días (Time Travel:
`npx wrangler d1 time-travel restore doo-barber --timestamp=...`) y el panel descarga
una copia `.sql` que se restaura con `npx wrangler d1 execute doo-barber --remote --file=respaldo.sql`.

Límites del plan gratis que importan: 10 ms de CPU por petición (por eso el login compara
hashes SHA-256 contra el secreto en vez de usar scrypt), 100,000 peticiones al día,
5 GB y 100,000 escrituras diarias en D1.

## Reglas importantes del código

- **Seguridad:** la contraseña del panel es el secreto `ADMIN_PASSWORD` de Cloudflare;
  las sesiones son tokens aleatorios (se guarda su hash en `sesiones`, 7 días) y los
  intentos fallidos se cuentan por IP en `intentos_login`. Las rutas de admin usan
  `verificarAdmin`; las públicas que dan permisos extra al admin usan `detectarAdmin`.
  Header: `Authorization: Bearer <token>`.
- **Nunca confiar en el navegador para precios:** `POST /api/citas` recibe
  `servicio_id` y el servidor toma nombre, precio y duración de la BD.
- **Todo lo que se pinte con `innerHTML` debe pasar por `escapeHtml()`** (existe en
  `index.html` y `admin.html`). No meter textos del usuario dentro de `onclick`;
  pasar solo IDs numéricos y buscar el objeto en JS.
- `PUT /api/config` solo acepta las claves de `CONFIG_EDITABLE`, cada una con su validador.
- **Disponibilidad:** toda la lógica vive en `calcularDisponibilidad()` (backend).
  Considera horario semanal, intervalo de turnos, duración del servicio, horas y
  días bloqueados y las citas de cada barbero. No duplicar esta lógica en el frontend.
- **Sin empalmes aunque reserven al mismo tiempo:** el INSERT/UPDATE de una cita lleva
  la condición `SIN_EMPALME` (`src/agenda.js`), así que la base solo la guarda si el
  barbero sigue libre en ese instante. Por eso las citas guardan `inicio_min` y
  `fin_min` (minutos desde medianoche) además de la hora en texto.
- **Fechas:** los Workers corren en UTC. "Hoy" y "ahora" se sacan con `ahoraLocal(zona)`
  usando `ZONA_HORARIA` de `wrangler.jsonc`; nunca usar `new Date().getDate()` directo.
- Horario semanal: config `horario_semanal` = JSON de 7 días (0 = domingo), cada
  día `null` (cerrado) o `{ "abre": "HH:MM", "cierra": "HH:MM" }`. Intervalo de
  turnos: `intervalo_min` (15, 30 o 60). Las horas de las citas se guardan como
  texto `"01:30 PM"`.
- Las rutas usan `dbGet(db, sql, params)` / `dbAll` / `dbRun` de `src/db.js` con
  `c.env.DB`. Los errores no previstos llegan a `app.onError`, que responde 500 en JSON.
- La ubicación de Google Maps se convierte en link solo en el servidor
  (`normalizarUrlMaps()` en `src/config.js`): al guardar `maps_url`, en `/api/catalogo`
  y en `GET /api/config/maps-url` (botón "Probar" del panel).
- **Colores (paleta "Latón", todo claro):** crema `#F7F4EE`, carbón `#17140F`,
  acento `#B8893A`. Cada pantalla define sus colores como variables en `:root`; no
  escribir colores sueltos. El acento es configurable (`color_primario`) y `tema.js`
  deriva de él `--on-accent` (texto encima del acento), `--accent-text` (acento como
  texto sobre crema) y `--accent-on-dark` (sobre carbón). Usar esas variables en vez
  de `color: var(--accent)`, que no se lee sobre crema. Los tonos suaves se sacan con
  `color-mix(in srgb, var(--accent) 12%, transparent)`.
- **WhatsApp es manual** (decisión del dueño: las APIs oficiales salen del presupuesto).
  No hay envío automático ni Baileys. El botón "WA" de cada cita en el panel abre
  `wa.me` con el mensaje armado desde `wa_template` (recordatorio) o, si la cita se
  movió (`citas.reagendada = 1`), desde `wa_template_reagendada` ("Avisar cambio").
  Variables: `{{negocio}} {{cliente}} {{fecha}} {{hora}} {{barbero}} {{servicio}} {{precio}}`.
- `GET /api/marca` (pública) devuelve nombre, logo, color y datos del Aviso de Privacidad;
  la usan el login y `privacidad.html`.
- **Aviso de Privacidad:** el cliente debe aceptarlo para reservar (`acepta_privacidad: true`
  en `POST /api/citas`; el admin no lo necesita). Se guarda la fecha en `citas.privacidad_aceptada_en`.
  Si cambian los datos que se recaban o para qué se usan, actualizar `privacidad.html` y su fecha.
- `GET /api/reportes` acepta `fecha` (un día) o `desde` / `hasta` (rango) y
  `barbero_id`; los filtros se hacen en SQL, no en el navegador.

## Estado del proyecto

Hecho:
1. **Sección 1 — Seguridad** (PR luisito2806/PW#2): login real, límite de intentos,
   precios del servidor, protección XSS, validación de configuración, CSV seguro,
   base de datos fuera del repo.
2. **Sección 2 — Agenda** (PR luisito2806/PW#3): horario semanal, duración de
   servicios, sin empalmes, fechas pasadas/límite de 30 días, WhatsApp sin caídas,
   rutas absolutas.
3. **Sección 3 — Limpieza** (PR luisito2806/PW#5): sin `config.js`, `package.json`
   de la raíz solo con scripts, paso 3 del stepper activo al confirmar, Maps
   normalizado en el servidor, reportes de semana por rango en SQL, sin sello
   "Conexión segura", zoom permitido en móvil, rutas con `async/await`.
4. **Sección 4 — Colores** (PR luisito2806/PW#6): paleta "Latón" en claro para
   clientes, login y panel; monograma con la inicial en lugar de los 3 puntos;
   `color_primario` configurable en el panel (Configuración → Identidad del Negocio).
6. **WhatsApp manual** (PR luisito2806/PW#7): se quitó Baileys y el envío automático;
   mensajes precargados con `wa.me` y plantilla aparte para citas reagendadas.
5a. **Listo para la primera barbería** (PR luisito2806/PW#8): Railway
   (`railway.json`, `/api/salud`), respaldos diarios y descargables, Aviso de
   Privacidad con aceptación obligatoria, dependencias sin vulnerabilidades.
5a'. **Migración a Cloudflare** (PR luisito2806/PW#9): Workers + Hono + D1 en lugar
   de Express + SQLite en Railway (gratis y más estable); reservas atómicas en SQL,
   respaldos con Time Travel y descarga `.sql`.

Pendiente (en este orden):
5b. **Cuando haya ~10 barberías:** una sola plataforma multi-negocio (`negocio_id` en
   todas las tablas, subdominio por cliente, usuarios con roles), Postgres, registro
   y cobro de suscripción (Mercado Pago o Stripe).
7. **Mejoras de producto:** horario distinto por barbero, anticipo o pago en línea
   para reducir faltas, y cambiar "barbero" por un término configurable según el giro.
