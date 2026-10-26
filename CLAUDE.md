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
- `backend/barberia.db` — base de datos local. **No se sube al repo** (está en `.gitignore`).
- `backend/wa_auth_info/` — sesión de WhatsApp (Baileys). **No se sube al repo.**

HTML, CSS y JS de cada pantalla van en el mismo archivo, sin frameworks ni build.

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
- Para código nuevo del backend usar los helpers `dbGet` / `dbAll` / `dbRun` con
  `async/await` en lugar de callbacks anidados.

## Estado del proyecto

Hecho:
1. **Sección 1 — Seguridad** (PR luisito2806/PW#2): login real, límite de intentos,
   precios del servidor, protección XSS, validación de configuración, CSV seguro,
   base de datos fuera del repo.
2. **Sección 2 — Agenda** (PR luisito2806/PW#3): horario semanal, duración de
   servicios, sin empalmes, fechas pasadas/límite de 30 días, WhatsApp sin caídas,
   rutas absolutas.

Pendiente (en este orden):
3. **Sección 3 — Limpieza:**
   - quitar `frontend/config.js` (no se usa);
   - limpiar el `package.json` de la raíz (dependencias duplicadas);
   - el paso 3 "Confirmar" del stepper nunca se activa;
   - `normalizarUrlMaps` está duplicada en `index.html` y `admin.html`;
   - los reportes de "semana" bajan todas las citas y filtran en el navegador (moverlo al servidor con rango de fechas);
   - quitar el sello "Conexión segura" del login mientras no haya HTTPS;
   - quitar `user-scalable=no` en `index.html`;
   - pasar a `async/await` las rutas que quedan con callbacks.
4. **Colores:** el sitio de clientes es claro y el panel y el login son oscuros, sin
   una línea común; el verde menta y los 3 puntos se ven genéricos. Propuestas:
   "Latón" (crema `#F7F4EE`, carbón `#17140F`, acento `#B8893A`) o "Clásico"
   (marino `#1B2A41`, crema `#F4EFE6`, rojo `#B23A2E`). Agregar `color_primario`
   configurable por barbería (marca blanca).
5. **Para vender como SaaS:** multi-negocio (`negocio_id` en todas las tablas,
   subdominio por cliente, usuarios con roles), Postgres, cobro de suscripción
   (Stripe o Mercado Pago), respaldos, HTTPS y Aviso de Privacidad (LFPDPPP).
6. **WhatsApp:** Baileys es una conexión no oficial y pueden banear el número del
   cliente. No usarlo en producción. Plan: proveedor oficial (360dialog, Twilio o
   Gupshup). Con eso, agregar recordatorios automáticos un día antes de la cita.
   Mientras tanto, el panel usa enlaces `wa.me`.
7. **Mejoras de producto:** horario distinto por barbero, anticipo o pago en línea
   para reducir faltas, y cambiar "barbero" por un término configurable según el giro.
