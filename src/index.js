// API del sistema de citas, en Cloudflare Workers (Hono + D1).
// El frontend (carpeta frontend/) lo sirve Cloudflare como archivos estáticos;
// este Worker solo atiende /api/* (ver wrangler.jsonc).
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { dbGet, dbAll, dbRun } from './db.js';
import {
    DIAS_MAX_RESERVA, DURACION_MIN, DURACION_MAX,
    horaAMinutos, duracionAMinutos, ahoraLocal, sumarDias, horariosDeLaSemana,
    calcularDisponibilidad, SIN_EMPALME, paramsSinEmpalme
} from './agenda.js';
import {
    REGEX_FECHA, ESTADOS_VALIDOS, CONFIG_EDITABLE,
    textoValido, imagenValida, normalizarUrlMaps, obtenerConfig
} from './config.js';

const app = new Hono();

app.use('/api/*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Cache-Control', 'no-store');
});
app.use('/api/*', bodyLimit({
    maxSize: 1024 * 1024,
    onError: c => c.json({ error: 'La información enviada es demasiado grande.' }, 413)
}));

// El cuerpo JSON de la petición, o {} si no viene o no es válido
async function leerJson(c) {
    try {
        const body = await c.req.json();
        return body && typeof body === 'object' ? body : {};
    } catch {
        return {};
    }
}

// ─── AUTENTICACIÓN ───────────────────────────────────────────────────
// La contraseña del panel es el secreto ADMIN_PASSWORD de Cloudflare (no se guarda en
// la base de datos). Se cambia con: npx wrangler secret put ADMIN_PASSWORD
const SESION_DURACION_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const MAX_INTENTOS = 5;                              // intentos fallidos por IP...
const BLOQUEO_MS = 15 * 60 * 1000;                   // ...antes de bloquear 15 minutos

const aHex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(texto) {
    return aHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto)));
}

function tokenAleatorio(bytes) {
    return aHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// Comparación en tiempo constante, para no revelar cuántos caracteres coinciden
function igualesSeguro(a, b) {
    if (a.length !== b.length) return false;
    let diferencia = 0;
    for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diferencia === 0;
}

function obtenerToken(c) {
    const header = c.req.header('Authorization') || '';
    return header.startsWith('Bearer ') ? header.slice(7) : '';
}

async function esSesionValida(c) {
    const token = obtenerToken(c);
    if (!token) return false;
    const row = await dbGet(c.env.DB, `SELECT expira FROM sesiones WHERE token_hash = ?`, [await sha256Hex(token)]);
    return !!row && row.expira > Date.now();
}

async function verificarAdmin(c, next) {
    if (!(await esSesionValida(c))) return c.json({ error: 'Sesión inválida o expirada' }, 401);
    await next();
}

// Para rutas públicas que dan permisos extra al admin (agendar sin límite de faltas, cancelar sin token)
async function detectarAdmin(c, next) {
    c.set('esAdmin', await esSesionValida(c));
    await next();
}

app.post('/api/login', async c => {
    if (!c.env.ADMIN_PASSWORD) {
        return c.json({ error: 'Falta configurar la contraseña del panel (ADMIN_PASSWORD).' }, 500);
    }
    const db = c.env.DB;
    const ip = c.req.header('CF-Connecting-IP') || 'local';
    const ahora = Date.now();

    const registro = await dbGet(db, `SELECT intentos, bloqueado_hasta FROM intentos_login WHERE ip = ?`, [ip]);
    if (registro && registro.bloqueado_hasta > ahora) {
        const minutos = Math.ceil((registro.bloqueado_hasta - ahora) / 60000);
        return c.json({ error: `Demasiados intentos. Intenta de nuevo en ${minutos} min.` }, 429);
    }

    const { password } = await leerJson(c);
    const correcta = typeof password === 'string'
        && igualesSeguro(await sha256Hex(password), await sha256Hex(c.env.ADMIN_PASSWORD));

    if (!correcta) {
        // Si ya pasó un bloqueo anterior, el conteo empieza de cero
        const bloqueoVencido = registro && registro.bloqueado_hasta && registro.bloqueado_hasta <= ahora;
        const intentos = (bloqueoVencido ? 0 : (registro?.intentos || 0)) + 1;
        await dbRun(db,
            `INSERT INTO intentos_login (ip, intentos, bloqueado_hasta) VALUES (?, ?, ?)
             ON CONFLICT (ip) DO UPDATE SET intentos = excluded.intentos, bloqueado_hasta = excluded.bloqueado_hasta`,
            [ip, intentos, intentos >= MAX_INTENTOS ? ahora + BLOQUEO_MS : 0]);
        return c.json({ error: 'Contraseña incorrecta' }, 401);
    }

    const token = tokenAleatorio(32);
    await dbRun(db, `DELETE FROM intentos_login WHERE ip = ?`, [ip]);
    await dbRun(db, `DELETE FROM sesiones WHERE expira < ?`, [ahora]);
    await dbRun(db, `INSERT INTO sesiones (token_hash, expira) VALUES (?, ?)`, [await sha256Hex(token), ahora + SESION_DURACION_MS]);
    return c.json({ exito: true, token });
});

app.post('/api/logout', async c => {
    const token = obtenerToken(c);
    if (token) await dbRun(c.env.DB, `DELETE FROM sesiones WHERE token_hash = ?`, [await sha256Hex(token)]);
    return c.json({ mensaje: 'Sesión cerrada' });
});

// ─── LIMPIAR BASE DE DATOS DE CITAS Y BLOQUEOS (DEJAR COMO NUEVO) ────
app.delete('/api/reset-citas', verificarAdmin, async c => {
    const db = c.env.DB;
    await db.batch([
        db.prepare(`DELETE FROM citas`),
        db.prepare(`DELETE FROM dias_bloqueados`),
        db.prepare(`DELETE FROM horas_bloqueadas`),
        db.prepare(`DELETE FROM sqlite_sequence WHERE name IN ('citas', 'dias_bloqueados', 'horas_bloqueadas')`)
    ]);
    return c.json({ mensaje: 'Base de datos de citas y bloqueos limpia como nueva.' });
});

// ─── RESPALDOS ───────────────────────────────────────────────────────
// Cloudflare guarda el historial de D1 (Time Travel: 7 días en el plan gratis) y permite
// regresar la base a cualquier minuto de ese periodo. Además, el panel descarga una copia
// en SQL para guardarla fuera de Cloudflare; para restaurarla:
//   npx wrangler d1 execute doo-barber --remote --file=respaldo.sql
const TABLAS_RESPALDO = ['configuracion', 'servicios', 'barberos', 'citas', 'dias_bloqueados', 'horas_bloqueadas'];

function valorSql(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
}

app.get('/api/respaldo', verificarAdmin, async c => {
    const db = c.env.DB;
    const { fecha } = ahoraLocal(c.env.ZONA_HORARIA || 'America/Mexico_City');
    const lineas = [
        `-- Respaldo de la base de datos del ${fecha}`,
        `-- Restaurar: npx wrangler d1 execute doo-barber --remote --file=respaldo-${fecha}.sql`,
        `-- (borra los datos actuales de estas tablas y los reemplaza por los del respaldo)`,
        ''
    ];
    for (const tabla of TABLAS_RESPALDO) lineas.push(`DELETE FROM ${tabla};`);
    for (const tabla of TABLAS_RESPALDO) {
        for (const fila of await dbAll(db, `SELECT * FROM ${tabla}`)) {
            const columnas = Object.keys(fila);
            lineas.push(`INSERT INTO ${tabla} (${columnas.join(', ')}) VALUES (${columnas.map(k => valorSql(fila[k])).join(', ')});`);
        }
    }
    return c.body(lineas.join('\n') + '\n', 200, {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Disposition': `attachment; filename="respaldo-${fecha}.sql"`
    });
});

// ─── CATÁLOGO PÚBLICO (INCLUYE MARCA BLANCA: NOMBRE Y LOGO) ──────────
app.get('/api/catalogo', async c => {
    const db = c.env.DB;
    const [servicios, barberos, conf] = await Promise.all([
        dbAll(db, `SELECT * FROM servicios WHERE activo = 1 ORDER BY id ASC`),
        dbAll(db, `SELECT * FROM barberos WHERE activo = 1 ORDER BY id ASC`),
        obtenerConfig(c.env)
    ]);
    return c.json({
        nombre_negocio: conf.nombre_negocio || 'Doo Barber',
        logo_url: conf.logo_url || '',
        color_primario: conf.color_primario || '#B8893A',
        servicios,
        barberos,
        horarios: horariosDeLaSemana(conf),
        horario_semanal: conf.horario,
        intervalo_min: conf.intervalo,
        dias_max_reserva: DIAS_MAX_RESERVA,
        maps_url: normalizarUrlMaps(conf.maps_url)
    });
});

// Identidad del negocio, para pantallas que no necesitan el catálogo (login, aviso de privacidad)
app.get('/api/marca', async c => {
    const conf = await obtenerConfig(c.env);
    return c.json({
        nombre_negocio: conf.nombre_negocio || 'Doo Barber',
        logo_url: conf.logo_url || '',
        color_primario: conf.color_primario || '#B8893A',
        privacidad_responsable: conf.privacidad_responsable || conf.nombre_negocio || 'Doo Barber',
        privacidad_domicilio: conf.privacidad_domicilio || '',
        privacidad_contacto: conf.privacidad_contacto || ''
    });
});

// Confirma que el Worker y la base de datos responden
app.get('/api/salud', async c => {
    await dbGet(c.env.DB, `SELECT 1`);
    return c.json({ ok: true });
});

// ─── CRUD SERVICIOS ──────────────────────────────────────────────────
app.post('/api/servicios', verificarAdmin, async c => {
    const { nombre, descripcion, precio, duracion } = await leerJson(c);
    if (!textoValido(nombre, 80)) return c.json({ error: 'Nombre requerido (máx. 80 caracteres)' }, 400);
    const precioNum = Number(precio);
    if (!Number.isFinite(precioNum) || precioNum < 0 || precioNum > 100000) {
        return c.json({ error: 'Precio inválido' }, 400);
    }
    if (descripcion && (typeof descripcion !== 'string' || descripcion.length > 200)) {
        return c.json({ error: 'Descripción inválida (máx. 200 caracteres)' }, 400);
    }
    const duracionNum = parseInt(String(duracion ?? '60'), 10);
    if (!Number.isFinite(duracionNum) || duracionNum < DURACION_MIN || duracionNum > DURACION_MAX) {
        return c.json({ error: `La duración debe ser entre ${DURACION_MIN} y ${DURACION_MAX} minutos` }, 400);
    }
    const insert = await dbRun(c.env.DB,
        `INSERT INTO servicios (nombre, descripcion, precio, duracion, activo) VALUES (?, ?, ?, ?, 1)`,
        [nombre.trim(), (descripcion || '').trim(), precioNum, `${duracionNum} min`]
    );
    return c.json({ id: insert.lastID, mensaje: 'Servicio agregado' });
});

app.delete('/api/servicios/:id', verificarAdmin, async c => {
    await dbRun(c.env.DB, `UPDATE servicios SET activo = 0 WHERE id = ?`, [c.req.param('id')]);
    return c.json({ mensaje: 'Servicio eliminado' });
});

// ─── CRUD BARBEROS ───────────────────────────────────────────────────
app.post('/api/barberos', verificarAdmin, async c => {
    const { nombre, especialidad, foto } = await leerJson(c);
    if (!textoValido(nombre, 60)) return c.json({ error: 'Nombre requerido (máx. 60 caracteres)' }, 400);
    if (especialidad && (typeof especialidad !== 'string' || especialidad.length > 60)) {
        return c.json({ error: 'Especialidad inválida (máx. 60 caracteres)' }, 400);
    }
    if (!imagenValida(foto)) return c.json({ error: 'Foto inválida' }, 400);
    const insert = await dbRun(c.env.DB,
        `INSERT INTO barberos (nombre, especialidad, foto, activo) VALUES (?, ?, ?, 1)`,
        [nombre.trim(), (especialidad || 'Barbero').trim(), foto || '']
    );
    return c.json({ id: insert.lastID, mensaje: 'Barbero agregado' });
});

app.delete('/api/barberos/:id', verificarAdmin, async c => {
    await dbRun(c.env.DB, `UPDATE barberos SET activo = 0 WHERE id = ?`, [c.req.param('id')]);
    return c.json({ mensaje: 'Barbero eliminado' });
});

// ─── CONFIGURACIÓN GENERAL ───────────────────────────────────────────
app.get('/api/config', verificarAdmin, async c => {
    const conf = await obtenerConfig(c.env);
    const { horario, intervalo, zona, ...config } = conf;
    config.horario_semanal = horario;
    config.intervalo_min = intervalo;
    config.horarios = horariosDeLaSemana(conf);
    return c.json(config);
});

app.put('/api/config', verificarAdmin, async c => {
    const body = await leerJson(c);
    const { clave } = body;
    let { valor } = body;
    if (!clave || valor === undefined) return c.json({ error: 'Faltan datos' }, 400);
    if (!Object.prototype.hasOwnProperty.call(CONFIG_EDITABLE, clave)) {
        return c.json({ error: 'Clave de configuración no permitida' }, 400);
    }
    if (clave === 'maps_url') valor = normalizarUrlMaps(valor);
    if (!CONFIG_EDITABLE[clave](valor)) {
        return c.json({ error: `Valor inválido para ${clave}` }, 400);
    }
    const valorFinal = typeof valor === 'string' ? valor.trim() : String(valor);
    await dbRun(c.env.DB, `INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?, ?)`, [clave, valorFinal]);
    return c.json({ mensaje: 'Configuración actualizada', valor: valorFinal });
});

// Muestra a qué link quedaría convertida una ubicación, sin guardarla (botón "Probar" del panel)
app.get('/api/config/maps-url', verificarAdmin, c => {
    return c.json({ url: normalizarUrlMaps(c.req.query('valor')) });
});

// ─── DISPONIBILIDAD (CLIENTE) ────────────────────────────────────────
app.get('/api/disponibilidad', async c => {
    const { fecha, barbero_id, servicio_id } = c.req.query();
    if (!REGEX_FECHA.test(fecha || '')) return c.json({ error: 'Fecha requerida' }, 400);

    const servicio = servicio_id
        ? await dbGet(c.env.DB, `SELECT duracion FROM servicios WHERE id = ? AND activo = 1`, [servicio_id])
        : null;
    const conf = await obtenerConfig(c.env);
    const disp = await calcularDisponibilidad(c.env.DB, {
        fecha,
        barberoId: barbero_id || 'cualquiera',
        duracion: duracionAMinutos(servicio?.duracion),
        conf
    });

    if (disp.error) return c.json({ error: disp.error }, 400);
    if (disp.cerrado) return c.json({ bloqueado: true, motivo: disp.motivo, horarios: [] });
    return c.json({
        bloqueado: false,
        horarios: disp.horarios.map(({ hora, disponible }) => ({ hora, disponible }))
    });
});

// ─── VERIFICAR ESTADO DE TICKET ACTIVO EN EL CELULAR DEL CLIENTE ─────
// Requiere el token de cancelación que recibió el cliente al agendar, para que
// nadie pueda consultar citas ajenas probando IDs consecutivos.
app.get('/api/citas/:id/ticket-status', async c => {
    const tokenCliente = String(c.req.query('token') || '');
    if (!tokenCliente) return c.json({ activa: false });
    const row = await dbGet(c.env.DB,
        `SELECT id, cliente, servicio, precio, fecha, hora, estado, barbero_nombre FROM citas WHERE id = ? AND token_cancelacion = ?`,
        [c.req.param('id'), tokenCliente]
    );
    if (!row) return c.json({ activa: false });
    return c.json({ activa: row.estado === 'pendiente', cita: row });
});

// ─── AGENDAR CITA ────────────────────────────────────────────────────
// El precio y el nombre del servicio se toman de la base de datos a partir de
// servicio_id; nunca se confía en lo que manda el navegador.
app.post('/api/citas', detectarAdmin, async c => {
    const db = c.env.DB;
    const body = await leerJson(c);
    const { telefono, servicio_id, hora, fecha, barbero_id } = body;
    const cliente = typeof body.cliente === 'string' ? body.cliente.trim() : '';
    const esAdmin = c.get('esAdmin');

    if (!textoValido(cliente, 80)) {
        return c.json({ error: 'Ingresa un nombre válido (máx. 80 caracteres).' }, 400);
    }
    if (!/^[0-9]{10}$/.test(telefono)) {
        return c.json({ error: 'El número debe ser de 10 dígitos.' }, 400);
    }
    if (!REGEX_FECHA.test(fecha || '')) {
        return c.json({ error: 'Fecha inválida.' }, 400);
    }
    if (!esAdmin && body.acepta_privacidad !== true) {
        return c.json({ error: 'Debes aceptar el Aviso de Privacidad para reservar.' }, 400);
    }

    const srv = await dbGet(db, `SELECT nombre, precio, duracion FROM servicios WHERE id = ? AND activo = 1`, [servicio_id]);
    if (!srv) return c.json({ error: 'El servicio seleccionado no está disponible.' }, 400);

    const conf = await obtenerConfig(c.env);

    // El administrador puede registrar citas pasadas o de clientes con faltas; el cliente no
    if (!esAdmin) {
        const hoy = ahoraLocal(conf.zona).fecha;
        if (fecha < hoy) return c.json({ error: 'No se puede agendar en una fecha pasada.' }, 400);
        if (fecha > sumarDias(hoy, DIAS_MAX_RESERVA)) {
            return c.json({ error: `Solo se puede agendar con hasta ${DIAS_MAX_RESERVA} días de anticipación.` }, 400);
        }

        const maxFaltas = Number(conf.max_faltas || 2);
        const rowFaltas = await dbGet(db, `SELECT COUNT(*) as faltas FROM citas WHERE telefono = ? AND estado = 'no_asistio'`, [telefono]);
        if ((rowFaltas?.faltas || 0) >= maxFaltas) {
            return c.json({
                error: 'Tu número registra inasistencias previas sin aviso. Contáctanos directamente para agendar.'
            }, 403);
        }
    }

    const duracion = duracionAMinutos(srv.duracion);
    const disp = await calcularDisponibilidad(db, { fecha, barberoId: barbero_id, duracion, conf, permitirPasado: esAdmin });
    if (disp.error) return c.json({ error: disp.error }, 400);
    if (disp.cerrado) return c.json({ error: `Día no disponible: ${disp.motivo}` }, 400);

    const turno = disp.horarios.find(h => h.hora === hora);
    if (!turno) return c.json({ error: 'Horario inválido.' }, 400);

    // Se intenta con cada barbero libre; el INSERT solo ocurre si en ese instante
    // el barbero sigue sin otra cita en ese rango (ver SIN_EMPALME)
    const inicio = horaAMinutos(hora);
    const fin = inicio + duracion;
    const tokenCancelacion = tokenAleatorio(12);
    const privacidadAceptadaEn = esAdmin ? null : new Date().toISOString();
    for (const barbero of turno.libres) {
        const insert = await dbRun(db,
            `INSERT INTO citas (cliente, telefono, servicio, precio, hora, fecha, inicio_min, fin_min, duracion_min,
                                estado, barbero_id, barbero_nombre, token_cancelacion, privacidad_aceptada_en)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?
             WHERE ${SIN_EMPALME}`,
            [cliente, telefono, srv.nombre, srv.precio, hora, fecha, inicio, fin, duracion,
             barbero.id, barbero.nombre, tokenCancelacion, privacidadAceptadaEn,
             ...paramsSinEmpalme({ fecha, barberoId: barbero.id, inicio, fin })]
        );
        if (insert.changes === 1) {
            return c.json({
                mensaje: 'Cita agendada',
                id: insert.lastID,
                barbero_nombre: barbero.nombre,
                token_cancelacion: tokenCancelacion
            });
        }
    }
    return c.json({ error: 'Ese horario ya no está disponible. Elige otro, por favor.' }, 409);
});

// ─── REAGENDAR / MOVER CITA EN UN CLIC (ADMIN) ───────────────────────
app.patch('/api/citas/:id/reagendar', verificarAdmin, async c => {
    const db = c.env.DB;
    const id = Number(c.req.param('id'));
    const { fecha, hora, barbero_id } = await leerJson(c);

    if (!fecha || !hora) {
        return c.json({ error: 'Fecha y hora son requeridas para reagendar.' }, 400);
    }
    if (!REGEX_FECHA.test(fecha) || !Number.isFinite(horaAMinutos(hora))) {
        return c.json({ error: 'Fecha u hora inválida.' }, 400);
    }

    const citaActual = await dbGet(db, `SELECT * FROM citas WHERE id = ?`, [id]);
    if (!citaActual) return c.json({ error: 'Cita no encontrada.' }, 404);

    const conf = await obtenerConfig(c.env);
    const duracion = citaActual.duracion_min || 60;
    const disp = await calcularDisponibilidad(db, {
        fecha,
        barberoId: barbero_id || citaActual.barbero_id,
        duracion,
        conf,
        excluirCitaId: id,
        permitirPasado: true
    });
    if (disp.error) return c.json({ error: disp.error }, 400);
    if (disp.cerrado) return c.json({ error: `Ese día no está disponible: ${disp.motivo}` }, 400);

    const turno = disp.horarios.find(h => h.hora === hora);
    if (!turno) return c.json({ error: 'Esa hora está fuera del horario de ese día.' }, 400);

    // `reagendada` hace que el botón de WhatsApp del panel use la plantilla de cita reagendada
    const inicio = horaAMinutos(hora);
    const fin = inicio + duracion;
    for (const barbero of turno.libres) {
        const update = await dbRun(db,
            `UPDATE citas SET fecha = ?, hora = ?, inicio_min = ?, fin_min = ?, barbero_id = ?, barbero_nombre = ?, reagendada = 1
             WHERE id = ? AND ${SIN_EMPALME}`,
            [fecha, hora, inicio, fin, barbero.id, barbero.nombre, id,
             ...paramsSinEmpalme({ fecha, barberoId: barbero.id, excluirCitaId: id, inicio, fin })]
        );
        if (update.changes === 1) return c.json({ mensaje: 'Cita reagendada correctamente' });
    }
    return c.json({ error: 'El barbero ya tiene otra cita o un bloqueo en ese horario, o el servicio terminaría después del cierre.' }, 409);
});

// ─── CANCELAR CITA ───────────────────────────────────────────────────
app.delete('/api/citas/:id', detectarAdmin, async c => {
    const id = c.req.param('id');
    const tokenCliente = c.req.query('token');

    if (c.get('esAdmin')) {
        await dbRun(c.env.DB, `UPDATE citas SET estado = 'cancelada' WHERE id = ?`, [id]);
        return c.json({ mensaje: 'Cita cancelada correctamente' });
    }
    if (!tokenCliente) return c.json({ error: 'Token de cancelación requerido' }, 403);
    const update = await dbRun(c.env.DB, `UPDATE citas SET estado = 'cancelada' WHERE id = ? AND token_cancelacion = ?`, [id, tokenCliente]);
    if (update.changes === 0) return c.json({ error: 'No autorizado para cancelar esta cita' }, 403);
    return c.json({ mensaje: 'Cita cancelada correctamente' });
});

// ─── PANEL ADMINISTRADOR (REPORTES Y AGENDA) ─────────────────────────
// Filtros opcionales: `fecha` (un día) o `desde` / `hasta` (rango, ambos incluidos) y `barbero_id`
app.get('/api/reportes', verificarAdmin, async c => {
    const { fecha, desde, hasta, barbero_id } = c.req.query();
    if ([fecha, desde, hasta].some(f => f && !REGEX_FECHA.test(f))) {
        return c.json({ error: 'Fecha inválida' }, 400);
    }

    const condiciones = [];
    const params = [];
    if (fecha) { condiciones.push(`c.fecha = ?`); params.push(fecha); }
    if (desde) { condiciones.push(`c.fecha >= ?`); params.push(desde); }
    if (hasta) { condiciones.push(`c.fecha <= ?`); params.push(hasta); }
    if (barbero_id) { condiciones.push(`c.barbero_id = ?`); params.push(barbero_id); }
    const filtro = condiciones.map(cond => ` AND ${cond}`).join('');

    const [citas, desglose] = await Promise.all([
        dbAll(c.env.DB, `
            SELECT c.*,
            (SELECT COUNT(*) FROM citas c2 WHERE c2.telefono = c.telefono AND c2.estado = 'no_asistio') as faltas_cliente
            FROM citas c WHERE 1=1${filtro}
            ORDER BY c.fecha ASC, c.inicio_min ASC`, params),
        dbAll(c.env.DB, `
            SELECT c.servicio, COUNT(*) as cantidad, SUM(c.precio) as total
            FROM citas c WHERE c.estado = 'completada'${filtro}
            GROUP BY c.servicio`, params)
    ]);

    return c.json({
        citas,
        desglose,
        totalGanancias: desglose.reduce((acc, curr) => acc + (curr.total || 0), 0),
        totalCitas: citas.length
    });
});

app.patch('/api/citas/:id/estado', verificarAdmin, async c => {
    const { estado } = await leerJson(c);
    if (!ESTADOS_VALIDOS.includes(estado)) return c.json({ error: 'Estado inválido' }, 400);
    await dbRun(c.env.DB, `UPDATE citas SET estado = ? WHERE id = ?`, [estado, c.req.param('id')]);
    return c.json({ mensaje: 'Estado actualizado' });
});

// ─── BLOQUEO DE DÍAS Y HORAS ─────────────────────────────────────────
app.get('/api/bloqueos', verificarAdmin, async c => {
    return c.json(await dbAll(c.env.DB, `SELECT * FROM dias_bloqueados ORDER BY fecha ASC`));
});

app.post('/api/bloqueos', verificarAdmin, async c => {
    const db = c.env.DB;
    const { fecha, motivo, forzar } = await leerJson(c);
    if (!REGEX_FECHA.test(fecha || '')) return c.json({ error: 'Fecha requerida' }, 400);
    if (motivo && (typeof motivo !== 'string' || motivo.length > 120)) {
        return c.json({ error: 'Motivo inválido (máx. 120 caracteres)' }, 400);
    }
    const motivoFinal = motivo ? motivo.trim() : 'No laboral / descanso';

    const citas = await dbAll(db, `SELECT id, cliente, telefono, hora FROM citas WHERE fecha = ? AND estado != 'cancelada'`, [fecha]);
    if (citas.length > 0 && !forzar) {
        return c.json({
            advertencia: true,
            totalCitas: citas.length,
            citas,
            mensaje: `Hay ${citas.length} citas agendadas ese día.`
        }, 409);
    }
    await dbRun(db, `INSERT OR REPLACE INTO dias_bloqueados (fecha, motivo) VALUES (?, ?)`, [fecha, motivoFinal]);
    if (forzar && citas.length > 0) {
        await dbRun(db, `UPDATE citas SET estado = 'cancelada' WHERE fecha = ? AND estado != 'cancelada'`, [fecha]);
        return c.json({ mensaje: 'Día bloqueado y citas canceladas.' });
    }
    return c.json({ mensaje: 'Día bloqueado exitosamente.' });
});

app.delete('/api/bloqueos/:id', verificarAdmin, async c => {
    await dbRun(c.env.DB, `DELETE FROM dias_bloqueados WHERE id = ?`, [c.req.param('id')]);
    return c.json({ mensaje: 'Día desbloqueado' });
});

app.get('/api/horas-bloqueadas', verificarAdmin, async c => {
    return c.json(await dbAll(c.env.DB, `SELECT * FROM horas_bloqueadas ORDER BY fecha ASC, hora ASC`));
});

app.post('/api/horas-bloqueadas-rango', verificarAdmin, async c => {
    const db = c.env.DB;
    const { fecha, horas, motivo } = await leerJson(c);
    if (!REGEX_FECHA.test(fecha || '') || !Array.isArray(horas) || horas.length === 0 || horas.length > 24
        || horas.some(h => !Number.isFinite(horaAMinutos(h)))) {
        return c.json({ error: 'Fecha y horas requeridas' }, 400);
    }
    if (motivo && (typeof motivo !== 'string' || motivo.length > 120)) {
        return c.json({ error: 'Motivo inválido (máx. 120 caracteres)' }, 400);
    }
    const motivoFinal = (motivo && motivo.trim().length > 0) ? motivo.trim() : 'Salida / Compromiso';

    await db.batch(horas.map(h =>
        db.prepare(`INSERT OR REPLACE INTO horas_bloqueadas (fecha, hora, motivo) VALUES (?, ?, ?)`).bind(fecha, h, motivoFinal)
    ));
    return c.json({ mensaje: `${horas.length} horario(s) bloqueado(s) correctamente.` });
});

app.delete('/api/horas-bloqueadas/:id', verificarAdmin, async c => {
    await dbRun(c.env.DB, `DELETE FROM horas_bloqueadas WHERE id = ?`, [c.req.param('id')]);
    return c.json({ mensaje: 'Horario liberado' });
});

// Rutas de API que no existen y errores no previstos responden en JSON, no con una página HTML
app.notFound(c => c.json({ error: 'Ruta no encontrada' }, 404));
app.onError((err, c) => {
    console.error('Error en', c.req.method, c.req.path, err);
    return c.json({ error: 'Error interno del servidor' }, 500);
});

export default app;
