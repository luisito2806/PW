# Doo Barber — sistema de citas para barberías (SaaS en desarrollo)

Programa de reservas para barberías que se quiere vender a varios negocios
(marca blanca). En el futuro se quiere usar también para profesionistas 1 a 1
(terapeutas, nutriólogos, etc.), así que conviene no amarrar el código a la
palabra "barbero". Todo el texto de la interfaz está en español de México.

## Estructura

- `backend/app.js` — servidor Express + SQLite (un solo archivo). También sirve el frontend.
- `frontend/index.html` — sitio público donde el cliente reserva (servicio → barbero → fecha/hora → datos).
- `frontend/admin.html` — panel del dueño: agenda, walk-in, mover citas, bloqueos, reportes, configuración.
- `frontend/login.html` — acceso al panel.
- `frontend/tema.js` — compartido por las tres pantallas: aplica el color de la barbería
  (`aplicarColorPrimario()`) y pinta el logo o el monograma (`pintarMarca()`).
- `backend/barberia.db` — base de datos local. **No se sube al repo** (está en `.gitignore`).
- `backend/wa_auth_info/` — restos de la antigua sesión de Baileys; ya no se usa y se puede borrar.

HTML, CSS y JS de cada pantalla van en el mismo archivo, sin frameworks ni build
(la única excepción es `tema.js`).

## Cómo correrlo

```bash
cd backend
npm install
ADMIN_PASSWORD="tu-clave" npm start          # Mac/Linux
$env:ADMIN_PASSWORD="tu-clave"; npm start    # Windows PowerShell
```

Abrir http://localhost:3000 (clientes) y http://localhost:3000/login.html (panel).

Variables de entorno: `ADMIN_PASSWORD` (si falta y no hay clave guardada, se genera
una al azar y se imprime una vez), `PORT`, `DB_PATH`, `TZ` (por defecto
`America/Mexico_City`), `CORS_ORIGIN`, `TRUST_PROXY`.

## Reglas importantes del código

- **Seguridad:** el login usa hash scrypt y sesiones aleatorias en la tabla `sesiones`
  (7 días). Las rutas de admin usan `verificarAdmin`; las públicas que dan permisos
  extra al admin usan `detectarAdmin`. Header: `Authorization: Bearer <token>`.
- **Nunca confiar en el navegador para precios:** `POST /api/citas` recibe
  `servicio_id` y el servidor toma nombre, precio y duración de la BD.
- **Todo lo que se pinte con `innerHTML` debe pasar por `escapeHtml()`** (existe en
  `index.html` y `admin.html`). No meter textos del usuario dentro de `onclick`;
  pasar solo IDs numéricos y buscar el objeto en JS.
- `PUT /api/config` solo acepta las claves de `CONFIG_EDITABLE`, cada una con su validador.
- **Disponibilidad:** toda la lógica vive en `calcularDisponibilidad()` (backend).
  Considera horario semanal, intervalo de turnos, duración del servicio, horas y
  días bloqueados y las citas de cada barbero. Crear o mover citas pasa por
  `enFilaDeReservas()` para evitar empalmes simultáneos. No duplicar esta lógica
  en el frontend.
- Horario semanal: config `horario_semanal` = JSON de 7 días (0 = domingo), cada
  día `null` (cerrado) o `{ "abre": "HH:MM", "cierra": "HH:MM" }`. Intervalo de
  turnos: `intervalo_min` (15, 30 o 60). Las horas de las citas se guardan como
  texto `"01:30 PM"`.
- Las rutas del backend usan los helpers `dbGet` / `dbAll` / `dbRun` con
  `async/await` (no callbacks). Express 5 manda los errores de rutas `async` al
  manejador final, que responde 500 en JSON.
- La ubicación de Google Maps se convierte en link solo en el servidor
  (`normalizarUrlMaps()` en `app.js`): al guardar `maps_url`, en `/api/catalogo`
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
- `GET /api/marca` (pública) devuelve nombre, logo y color; la usa el login.
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
6. **WhatsApp manual** (rama `whatsapp-manual`): se quitó Baileys y el envío automático;
   mensajes precargados con `wa.me` y plantilla aparte para citas reagendadas.

Pendiente (en este orden):
5. **Para vender como SaaS:** multi-negocio (`negocio_id` en todas las tablas,
   subdominio por cliente, usuarios con roles), Postgres, cobro de suscripción
   (Stripe o Mercado Pago), respaldos, HTTPS y Aviso de Privacidad (LFPDPPP).
7. **Mejoras de producto:** horario distinto por barbero, anticipo o pago en línea
   para reducir faltas, y cambiar "barbero" por un término configurable según el giro.
