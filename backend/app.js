// Las fechas "hoy" y las horas ya pasadas se calculan con la hora local de la barbería
process.env.TZ = process.env.TZ || 'America/Mexico_City';

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Rutas absolutas: funcionan igual sin importar desde qué carpeta se ejecute `node`
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'barberia.db');
// Respaldos diarios junto a la base de datos (en Railway, dentro del mismo volumen)
const RESPALDOS_DIR = process.env.RESPALDOS_DIR || path.join(path.dirname(DB_PATH), 'respaldos');
const RESPALDOS_A_GUARDAR = Number(process.env.RESPALDOS_A_GUARDAR) || 14;

// Evita que un error inesperado tumbe el servidor
process.on('unhandledRejection', (err) => {
    console.error('Error no controlado:', err);
});

// El frontend se sirve desde este mismo servidor, así que CORS solo se habilita
// si se define CORS_ORIGIN (ej. CORS_ORIGIN=https://mi-dominio.com)
if (process.env.CORS_ORIGIN) {
    app.use(cors({ origin: process.env.CORS_ORIGIN.split(',').map(o => o.trim()) }));
}
// Detrás de un proxy (Render, Railway, Nginx...) define TRUST_PROXY=1 para que req.ip sea la IP real
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../frontend')));

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error BD:', err.message);
    } else {
        console.log('Conectado exitosamente a SQLite.');
    }
});

// ─── INICIALIZACIÓN Y MIGRACIÓN DE BASE DE DATOS ─────────────────────
db.serialize(() => {
    // 1. Citas
    db.run(`CREATE TABLE IF NOT EXISTS citas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente TEXT NOT NULL,
        telefono TEXT NOT NULL,
        servicio TEXT NOT NULL,
        precio REAL NOT NULL,
        hora TEXT NOT NULL,
        fecha TEXT NOT NULL,
        estado TEXT DEFAULT 'pendiente',
        barbero_id INTEGER DEFAULT 1,
        barbero_nombre TEXT DEFAULT 'General',
        token_cancelacion TEXT
    )`);

    db.run(`ALTER TABLE citas ADD COLUMN barbero_id INTEGER DEFAULT 1`, () => {});
    db.run(`ALTER TABLE citas ADD COLUMN barbero_nombre TEXT DEFAULT 'General'`, () => {});
    db.run(`ALTER TABLE citas ADD COLUMN token_cancelacion TEXT`, () => {});
    db.run(`ALTER TABLE citas ADD COLUMN duracion_min INTEGER DEFAULT 60`, () => {});
    db.run(`ALTER TABLE citas ADD COLUMN reagendada INTEGER DEFAULT 0`, () => {});
    // Cuándo aceptó el cliente el Aviso de Privacidad (vacío en citas registradas por el admin)
    db.run(`ALTER TABLE citas ADD COLUMN privacidad_aceptada_en TEXT`, () => {});

    // 2. Días completos bloqueados
    db.run(`CREATE TABLE IF NOT EXISTS dias_bloqueados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT UNIQUE NOT NULL,
        motivo TEXT NOT NULL
    )`);

    // 3. Horas específicas bloqueadas
    db.run(`CREATE TABLE IF NOT EXISTS horas_bloqueadas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL,
        motivo TEXT,
        UNIQUE(fecha, hora)
    )`);

    // 4. Servicios dinámicos
    db.run(`CREATE TABLE IF NOT EXISTS servicios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        descripcion TEXT,
        precio REAL NOT NULL,
        duracion TEXT DEFAULT '60 min',
        activo INTEGER DEFAULT 1
    )`, () => {
        db.get(`SELECT COUNT(*) as count FROM servicios`, (err, row) => {
            if (!err && row && row.count === 0) {
                const stmt = db.prepare(`INSERT INTO servicios (nombre, descripcion, precio, duracion) VALUES (?, ?, ?, ?)`);
                stmt.run('Corte Clásico', 'Corte a tijera o a máquina', 150, '30 min');
                stmt.run('Corte + Barba', 'Corte y arreglo de barba', 250, '50 min');
                stmt.run('Corte + Ceja', 'Corte y depilación de cejas', 200, '40 min');
                stmt.run('Servicio Completo', 'Pelo, barba y cejas incluidos', 300, '70 min');
                stmt.finalize();
            }
        });
    });

    // 5. Barberos (Multi-barbero con foto)
    db.run(`CREATE TABLE IF NOT EXISTS barberos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        especialidad TEXT DEFAULT 'Barbero Master',
        foto TEXT DEFAULT '',
        activo INTEGER DEFAULT 1
    )`, () => {
        db.get(`SELECT COUNT(*) as count FROM barberos`, (err, row) => {
            if (!err && row && row.count === 0) {
                db.run(`INSERT INTO barberos (nombre, especialidad) VALUES ('Barbero Principal', 'Corte y Barba')`);
            }
        });
    });

    // 6. Configuración general (Incluye Marca Blanca: nombre_negocio y logo_url)
    db.run(`CREATE TABLE IF NOT EXISTS configuracion (
        clave TEXT PRIMARY KEY,
        valor TEXT
    )`, () => {
        const defaults = [
            ['nombre_negocio', 'Doo Barber'],
            ['logo_url', ''],
            ['color_primario', '#B8893A'],
            ['privacidad_responsable', ''],
            ['privacidad_domicilio', ''],
            ['privacidad_contacto', ''],
            ['wa_template', '¡Hola {{cliente}}! 👋 Te recordamos tu cita en *{{negocio}}*:\n📅 Fecha: {{fecha}}\n🕐 Hora: {{hora}}\n💈 Barbero: {{barbero}}\n✂️ Servicio: {{servicio}}\n💰 Total: ${{precio}} MXN\n\nResponde con un *OK* o un 👍 para confirmar de recibido. ¡Te esperamos! 🙌'],
            ['wa_template_reagendada', '¡Hola {{cliente}}! 🔄 Tu cita en *{{negocio}}* ha sido reagendada:\n📅 Nueva fecha: {{fecha}}\n🕐 Nueva hora: {{hora}}\n💈 Barbero: {{barbero}}\n✂️ Servicio: {{servicio}}\n\nResponde con un *OK* o un 👍 para confirmar. ¡Te esperamos! 🙌'],
            ['hora_apertura', '10'],
            ['hora_cierre', '19'],
            ['maps_url', 'https://maps.google.com'],
            ['max_faltas', '2'],
            ['intervalo_min', '60']
        ];
        const stmt = db.prepare(`INSERT OR IGNORE INTO configuracion (clave, valor) VALUES (?, ?)`);
        defaults.forEach(([k, v]) => stmt.run(k, v));
        stmt.finalize(() => {
            // Migración: el horario único (hora_apertura / hora_cierre) pasa a ser un horario semanal
            db.all(`SELECT clave, valor FROM configuracion WHERE clave IN ('hora_apertura', 'hora_cierre', 'horario_semanal')`, [], (err, rows) => {
                if (err) return console.error('Error migrando horario:', err.message);
                const conf = {};
                rows.forEach(r => { conf[r.clave] = r.valor; });
                if (!conf.horario_semanal) {
                    const horario = horarioSemanalPorDefecto(conf.hora_apertura, conf.hora_cierre);
                    db.run(`INSERT OR IGNORE INTO configuracion (clave, valor) VALUES ('horario_semanal', ?)`, [JSON.stringify(horario)]);
                }
            });
        });
    });
});

// ─── WHATSAPP ────────────────────────────────────────────────────────
// Los mensajes se mandan a mano desde el panel: el botón "WA" de cada cita abre
// WhatsApp (wa.me) con el mensaje ya escrito a partir de las plantillas
// `wa_template` (recordatorio) y `wa_template_reagendada`. No hay envío automático.

// ─── AGENDA: HORARIO SEMANAL, DURACIONES Y DISPONIBILIDAD ────────────
const DIAS_MAX_RESERVA = 30;
const INTERVALOS_VALIDOS = [15, 30, 60];
const DURACION_MIN = 5;
const DURACION_MAX = 480;

const dbGet = (sql, params = []) => new Promise((ok, fallo) => db.get(sql, params, (err, row) => err ? fallo(err) : ok(row)));
const dbAll = (sql, params = []) => new Promise((ok, fallo) => db.all(sql, params, (err, rows) => err ? fallo(err) : ok(rows || [])));
const dbRun = (sql, params = []) => new Promise((ok, fallo) => db.run(sql, params, function(err) { err ? fallo(err) : ok(this); }));

const pad2 = n => String(n).padStart(2, '0');

// "01:30 PM" → 810 (minutos desde medianoche); NaN si el formato no es válido
function horaAMinutos(hora) {
    const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(hora || '');
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) > 59) return NaN;
    let h = Number(m[1]) % 12;
    if (m[3] === 'PM') h += 12;
    return h * 60 + Number(m[2]);
}

// 810 → "01:30 PM"
function minutosAHora(min) {
    const h24 = Math.floor(min / 60);
    let h12 = h24 % 12;
    if (h12 === 0) h12 = 12;
    return `${pad2(h12)}:${pad2(min % 60)} ${h24 >= 12 ? 'PM' : 'AM'}`;
}

// "20:30" → 1230
function hhmmAMinutos(valor) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(valor || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

// "50 min" → 50. Si no se puede leer, se asume 60 minutos
function duracionAMinutos(texto) {
    const n = parseInt(String(texto || ''), 10);
    return Number.isFinite(n) && n >= DURACION_MIN && n <= DURACION_MAX ? n : 60;
}

function fechaLocalISO(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function sumarDias(fechaISO, dias) {
    const [y, m, d] = fechaISO.split('-').map(Number);
    return fechaLocalISO(new Date(y, m - 1, d + dias));
}

function minutosAhora() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
}

// Horario semanal: arreglo de 7 días (0 = domingo). Cada día es null (cerrado)
// o { abre: 'HH:MM', cierra: 'HH:MM' }. El antiguo hora_cierre era el "último turno",
// por eso el local cierra una hora después.
function horarioSemanalPorDefecto(apertura = 10, cierre = 19) {
    const abre = Math.min(Math.max(parseInt(apertura, 10) || 10, 0), 22);
    const cierra = Math.min(Math.max((parseInt(cierre, 10) || 19) + 1, abre + 1), 23);
    return Array.from({ length: 7 }, () => ({ abre: `${pad2(abre)}:00`, cierra: `${pad2(cierra)}:00` }));
}

function horarioSemanalValido(horario) {
    return Array.isArray(horario) && horario.length === 7 && horario.every(dia =>
        dia === null || (
            typeof dia === 'object'
            && Number.isFinite(hhmmAMinutos(dia.abre))
            && Number.isFinite(hhmmAMinutos(dia.cierra))
            && hhmmAMinutos(dia.abre) < hhmmAMinutos(dia.cierra)
        )
    );
}

function parsearHorarioSemanal(texto) {
    try {
        const horario = JSON.parse(texto);
        if (horarioSemanalValido(horario)) return horario;
    } catch {}
    return horarioSemanalPorDefecto();
}

async function obtenerConfig() {
    const rows = await dbAll(`SELECT * FROM configuracion`);
    const conf = {};
    rows.forEach(r => { conf[r.clave] = r.valor; });
    conf.horario = parsearHorarioSemanal(conf.horario_semanal);
    conf.intervalo = INTERVALOS_VALIDOS.includes(Number(conf.intervalo_min)) ? Number(conf.intervalo_min) : 60;
    return conf;
}

function horarioDeFecha(conf, fechaISO) {
    const [y, m, d] = fechaISO.split('-').map(Number);
    return conf.horario[new Date(y, m - 1, d).getDay()];
}

// Minutos de inicio de cada turno: desde que abre, cada `intervalo`, mientras sea antes del cierre
function iniciosDeTurno(horarioDia, intervalo) {
    const inicios = [];
    for (let t = hhmmAMinutos(horarioDia.abre); t < hhmmAMinutos(horarioDia.cierra); t += intervalo) inicios.push(t);
    return inicios;
}

// Todas las horas posibles de la semana (para los selectores del panel)
function horariosDeLaSemana(conf) {
    const todos = new Set();
    conf.horario.forEach(dia => { if (dia) iniciosDeTurno(dia, conf.intervalo).forEach(t => todos.add(t)); });
    return [...todos].sort((a, b) => a - b).map(minutosAHora);
}

const traslapa = (inicioA, finA, inicioB, finB) => inicioA < finB && inicioB < finA;

// Calcula qué turnos de una fecha están libres para un servicio de `duracion` minutos.
// Un turno está libre si el servicio termina antes del cierre, no choca con una hora
// bloqueada y al menos un barbero (o el elegido) no tiene otra cita en ese rango.
async function calcularDisponibilidad({ fecha, barberoId = 'cualquiera', duracion, conf, excluirCitaId = null, permitirPasado = false }) {
    const diaBloqueado = await dbGet(`SELECT motivo FROM dias_bloqueados WHERE fecha = ?`, [fecha]);
    if (diaBloqueado) return { cerrado: true, motivo: diaBloqueado.motivo, horarios: [] };

    const horarioDia = horarioDeFecha(conf, fecha);
    if (!horarioDia) return { cerrado: true, motivo: 'Cerrado este día', horarios: [] };

    let barberos = await dbAll(`SELECT id, nombre FROM barberos WHERE activo = 1 ORDER BY id ASC`);
    if (barberoId && barberoId !== 'cualquiera') {
        barberos = barberos.filter(b => String(b.id) === String(barberoId));
        if (barberos.length === 0) return { error: 'El barbero seleccionado no está disponible.' };
    }

    const citas = (await dbAll(
        `SELECT id, hora, barbero_id, duracion_min FROM citas WHERE fecha = ? AND estado != 'cancelada'`,
        [fecha]
    ))
        .filter(c => Number(c.id) !== Number(excluirCitaId))
        .map(c => ({ barberoId: Number(c.barbero_id), inicio: horaAMinutos(c.hora), duracion: c.duracion_min || 60 }))
        .filter(c => Number.isFinite(c.inicio));

    const bloqueadas = (await dbAll(`SELECT hora FROM horas_bloqueadas WHERE fecha = ?`, [fecha]))
        .map(r => horaAMinutos(r.hora))
        .filter(Number.isFinite);

    const hoy = fechaLocalISO();
    const ahora = minutosAhora();
    const cierre = hhmmAMinutos(horarioDia.cierra);

    const horarios = iniciosDeTurno(horarioDia, conf.intervalo).map(inicio => {
        const fin = inicio + duracion;
        const yaPaso = fecha < hoy || (fecha === hoy && inicio <= ahora);
        let libres = [];

        if (fin <= cierre
            && (permitirPasado || !yaPaso)
            && !bloqueadas.some(b => traslapa(inicio, fin, b, b + conf.intervalo))) {
            libres = barberos.filter(b => !citas.some(c =>
                c.barberoId === Number(b.id) && traslapa(inicio, fin, c.inicio, c.inicio + c.duracion)
            ));
        }
        return { hora: minutosAHora(inicio), disponible: libres.length > 0, libres };
    });

    return { cerrado: false, horarios };
}

// Las reservas y los cambios de horario se procesan de uno en uno, para que dos
// personas reservando al mismo tiempo no puedan quedarse con el mismo turno.
let colaReservas = Promise.resolve();
function enFilaDeReservas(tarea) {
    const resultado = colaReservas.then(tarea);
    colaReservas = resultado.catch(() => {});
    return resultado;
}

// ─── VALIDACIONES ────────────────────────────────────────────────────
const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const ESTADOS_VALIDOS = ['pendiente', 'completada', 'cancelada', 'no_asistio'];
const MAX_IMAGEN_CHARS = 300 * 1024; // ~300 KB en base64 (el frontend las comprime a 150x150)

function textoValido(valor, max) {
    return typeof valor === 'string' && valor.trim().length > 0 && valor.trim().length <= max;
}

// Solo se aceptan imágenes como data URL (las que genera el compresor del panel) o vacío
function imagenValida(valor) {
    if (valor === undefined || valor === null || valor === '') return true;
    return typeof valor === 'string'
        && valor.length <= MAX_IMAGEN_CHARS
        && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(valor);
}

// Acepta un link de Google Maps, un <iframe> copiado de Google Maps o una dirección
// escrita a mano, y devuelve siempre un link que abre Google Maps
function normalizarUrlMaps(valor) {
    let v = typeof valor === 'string' ? valor.trim() : '';
    if (!v) return 'https://maps.google.com';
    const iframe = v.match(/src=["']([^"']+)["']/i);
    if (iframe) v = iframe[1];
    if (/^https?:\/\//i.test(v)) return v;
    if (/^(maps\.app\.goo\.gl|goo\.gl\/maps|www\.google\.|google\.com\/maps)/i.test(v)) return 'https://' + v;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(v)}`;
}

// Claves que el panel puede modificar y cómo se valida cada una
const CONFIG_EDITABLE = {
    nombre_negocio: v => textoValido(v, 60),
    logo_url:       v => imagenValida(v),
    color_primario: v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v),
    // Datos del responsable para el Aviso de Privacidad (pueden quedar vacíos)
    privacidad_responsable: v => typeof v === 'string' && v.length <= 120,
    privacidad_domicilio:   v => typeof v === 'string' && v.length <= 250,
    privacidad_contacto:    v => typeof v === 'string' && v.length <= 120,
    wa_template:    v => textoValido(v, 1000),
    wa_template_reagendada: v => textoValido(v, 1000),
    horario_semanal: v => {
        try { return typeof v === 'string' && v.length <= 2000 && horarioSemanalValido(JSON.parse(v)); }
        catch { return false; }
    },
    intervalo_min:  v => INTERVALOS_VALIDOS.includes(Number(v)),
    maps_url:       v => typeof v === 'string' && v.length <= 1000 && /^https?:\/\//i.test(v),
    max_faltas:     v => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 50
};

// ─── AUTENTICACIÓN ───────────────────────────────────────────────────
// La contraseña se guarda como hash (scrypt) en la tabla `seguridad`.
// - Si existe ADMIN_PASSWORD en el entorno, se usa y reemplaza el hash guardado.
// - Si no existe y no hay hash, se genera una contraseña aleatoria y se imprime UNA vez en consola.
const SESION_DURACION_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verificarPassword(password, guardado) {
    if (!guardado || typeof password !== 'string') return false;
    const [salt, hash] = guardado.split(':');
    const calculado = crypto.scryptSync(password, salt, 64);
    const esperado = Buffer.from(hash, 'hex');
    return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS seguridad (
        clave TEXT PRIMARY KEY,
        valor TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS sesiones (
        token_hash TEXT PRIMARY KEY,
        expira INTEGER NOT NULL
    )`);
    db.run(`DELETE FROM sesiones WHERE expira < ?`, [Date.now()]);

    db.get(`SELECT valor FROM seguridad WHERE clave = 'admin_password_hash'`, [], (err, row) => {
        if (err) return console.error('Error leyendo seguridad:', err.message);
        if (process.env.ADMIN_PASSWORD) {
            db.run(`INSERT OR REPLACE INTO seguridad (clave, valor) VALUES ('admin_password_hash', ?)`,
                [hashPassword(process.env.ADMIN_PASSWORD)]);
        } else if (!row) {
            const generada = crypto.randomBytes(9).toString('base64url');
            db.run(`INSERT INTO seguridad (clave, valor) VALUES ('admin_password_hash', ?)`, [hashPassword(generada)]);
            console.log('──────────────────────────────────────────────────────────');
            console.log(`🔐 Contraseña de administrador generada: ${generada}`);
            console.log('   Guárdala ahora; no se volverá a mostrar.');
            console.log('   Para cambiarla, arranca con ADMIN_PASSWORD="nueva" node app.js');
            console.log('──────────────────────────────────────────────────────────');
        }
    });
});

// Límite de intentos de login por IP: 5 intentos fallidos → bloqueo de 15 minutos
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;
const intentosLogin = new Map();

function obtenerToken(req) {
    const header = req.headers['authorization'] || '';
    return header.startsWith('Bearer ') ? header.slice(7) : '';
}

async function esSesionValida(token) {
    if (!token) return false;
    try {
        const row = await dbGet(`SELECT expira FROM sesiones WHERE token_hash = ?`, [hashToken(token)]);
        return !!row && row.expira > Date.now();
    } catch {
        return false;
    }
}

app.post('/api/login', async (req, res) => {
    const ip = req.ip;
    const registro = intentosLogin.get(ip);
    if (registro && registro.bloqueadoHasta > Date.now()) {
        const minutos = Math.ceil((registro.bloqueadoHasta - Date.now()) / 60000);
        return res.status(429).json({ error: `Demasiados intentos. Intenta de nuevo en ${minutos} min.` });
    }

    const { password } = req.body;
    const row = await dbGet(`SELECT valor FROM seguridad WHERE clave = 'admin_password_hash'`);
    if (!row) return res.status(500).json({ error: 'Error de autenticación' });

    if (!verificarPassword(password, row.valor)) {
        // Si ya pasó un bloqueo anterior, el conteo empieza de cero
        const bloqueoVencido = registro && registro.bloqueadoHasta && registro.bloqueadoHasta <= Date.now();
        const intentos = (bloqueoVencido ? 0 : (registro?.intentos || 0)) + 1;
        intentosLogin.set(ip, {
            intentos,
            bloqueadoHasta: intentos >= MAX_INTENTOS ? Date.now() + BLOQUEO_MS : 0
        });
        return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    intentosLogin.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    await dbRun(`INSERT INTO sesiones (token_hash, expira) VALUES (?, ?)`, [hashToken(token), Date.now() + SESION_DURACION_MS]);
    res.json({ exito: true, token });
});

app.post('/api/logout', async (req, res) => {
    const token = obtenerToken(req);
    if (token) await dbRun(`DELETE FROM sesiones WHERE token_hash = ?`, [hashToken(token)]).catch(() => {});
    res.json({ mensaje: 'Sesión cerrada' });
});

async function verificarAdmin(req, res, next) {
    if (await esSesionValida(obtenerToken(req))) return next();
    res.status(401).json({ error: 'Sesión inválida o expirada' });
}

// Para rutas públicas que dan permisos extra al admin (agendar sin límite de faltas, cancelar sin token)
async function detectarAdmin(req, res, next) {
    req.esAdmin = await esSesionValida(obtenerToken(req));
    next();
}

// ─── LIMPIAR BASE DE DATOS DE CITAS Y BLOQUEOS (DEJAR COMO NUEVO) ────
app.delete('/api/reset-citas', verificarAdmin, async (req, res) => {
    await dbRun(`DELETE FROM citas`);
    await dbRun(`DELETE FROM dias_bloqueados`);
    await dbRun(`DELETE FROM horas_bloqueadas`);
    await dbRun(`DELETE FROM sqlite_sequence WHERE name IN ('citas', 'dias_bloqueados', 'horas_bloqueadas')`);
    res.json({ mensaje: 'Base de datos de citas y bloqueos limpia como nueva.' });
});

// ─── RESPALDOS ───────────────────────────────────────────────────────
// Una copia por día (barberia-AAAA-MM-DD.db) en RESPALDOS_DIR; se conservan las
// últimas RESPALDOS_A_GUARDAR. `VACUUM INTO` hace una copia consistente aunque el
// servidor esté atendiendo reservas.
const REGEX_RESPALDO = /^barberia-\d{4}-\d{2}-\d{2}\.db$/;

async function respaldoDiario() {
    try {
        fs.mkdirSync(RESPALDOS_DIR, { recursive: true });
        const archivo = path.join(RESPALDOS_DIR, `barberia-${fechaLocalISO()}.db`);
        if (!fs.existsSync(archivo)) {
            await dbRun(`VACUUM INTO ?`, [archivo]);
            console.log('💾 Respaldo creado:', archivo);
        }
        const viejos = fs.readdirSync(RESPALDOS_DIR).filter(f => REGEX_RESPALDO.test(f)).sort().reverse().slice(RESPALDOS_A_GUARDAR);
        viejos.forEach(f => fs.rmSync(path.join(RESPALDOS_DIR, f), { force: true }));
    } catch (err) {
        console.error('Error creando respaldo:', err.message);
    }
}

// Poco después de arrancar (ya con las tablas creadas) y luego cada hora; solo copia si aún no hay respaldo de hoy
setTimeout(respaldoDiario, 10 * 1000);
setInterval(respaldoDiario, 60 * 60 * 1000);

// Descarga una copia al momento, para guardarla fuera del servidor
app.get('/api/respaldo', verificarAdmin, async (req, res) => {
    const temporal = path.join(os.tmpdir(), `respaldo-${crypto.randomBytes(6).toString('hex')}.db`);
    await dbRun(`VACUUM INTO ?`, [temporal]);
    res.download(temporal, `respaldo-${fechaLocalISO()}.db`, () => fs.rmSync(temporal, { force: true }));
});

// ─── CATÁLOGO PÚBLICO (INCLUYE MARCA BLANCA: NOMBRE Y LOGO) ──────────
app.get('/api/catalogo', async (req, res) => {
    const [servicios, barberos, conf] = await Promise.all([
        dbAll(`SELECT * FROM servicios WHERE activo = 1 ORDER BY id ASC`),
        dbAll(`SELECT * FROM barberos WHERE activo = 1 ORDER BY id ASC`),
        obtenerConfig()
    ]);
    res.json({
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
app.get('/api/marca', async (req, res) => {
    const conf = await obtenerConfig();
    res.json({
        nombre_negocio: conf.nombre_negocio || 'Doo Barber',
        logo_url: conf.logo_url || '',
        color_primario: conf.color_primario || '#B8893A',
        privacidad_responsable: conf.privacidad_responsable || conf.nombre_negocio || 'Doo Barber',
        privacidad_domicilio: conf.privacidad_domicilio || '',
        privacidad_contacto: conf.privacidad_contacto || ''
    });
});

// Para el hosting: confirma que el servidor y la base de datos responden
app.get('/api/salud', async (req, res) => {
    await dbGet(`SELECT 1`);
    res.json({ ok: true });
});

// ─── CRUD SERVICIOS ──────────────────────────────────────────────────
app.post('/api/servicios', verificarAdmin, async (req, res) => {
    const { nombre, descripcion, precio, duracion } = req.body;
    if (!textoValido(nombre, 80)) return res.status(400).json({ error: 'Nombre requerido (máx. 80 caracteres)' });
    const precioNum = Number(precio);
    if (!Number.isFinite(precioNum) || precioNum < 0 || precioNum > 100000) {
        return res.status(400).json({ error: 'Precio inválido' });
    }
    if (descripcion && (typeof descripcion !== 'string' || descripcion.length > 200)) {
        return res.status(400).json({ error: 'Descripción inválida (máx. 200 caracteres)' });
    }
    const duracionNum = parseInt(String(duracion ?? '60'), 10);
    if (!Number.isFinite(duracionNum) || duracionNum < DURACION_MIN || duracionNum > DURACION_MAX) {
        return res.status(400).json({ error: `La duración debe ser entre ${DURACION_MIN} y ${DURACION_MAX} minutos` });
    }
    const insert = await dbRun(
        `INSERT INTO servicios (nombre, descripcion, precio, duracion, activo) VALUES (?, ?, ?, ?, 1)`,
        [nombre.trim(), (descripcion || '').trim(), precioNum, `${duracionNum} min`]
    );
    res.json({ id: insert.lastID, mensaje: 'Servicio agregado' });
});

app.delete('/api/servicios/:id', verificarAdmin, async (req, res) => {
    await dbRun(`UPDATE servicios SET activo = 0 WHERE id = ?`, [req.params.id]);
    res.json({ mensaje: 'Servicio eliminado' });
});

// ─── CRUD BARBEROS ───────────────────────────────────────────────────
app.post('/api/barberos', verificarAdmin, async (req, res) => {
    const { nombre, especialidad, foto } = req.body;
    if (!textoValido(nombre, 60)) return res.status(400).json({ error: 'Nombre requerido (máx. 60 caracteres)' });
    if (especialidad && (typeof especialidad !== 'string' || especialidad.length > 60)) {
        return res.status(400).json({ error: 'Especialidad inválida (máx. 60 caracteres)' });
    }
    if (!imagenValida(foto)) return res.status(400).json({ error: 'Foto inválida' });
    const insert = await dbRun(
        `INSERT INTO barberos (nombre, especialidad, foto, activo) VALUES (?, ?, ?, 1)`,
        [nombre.trim(), (especialidad || 'Barbero').trim(), foto || '']
    );
    res.json({ id: insert.lastID, mensaje: 'Barbero agregado' });
});

app.delete('/api/barberos/:id', verificarAdmin, async (req, res) => {
    await dbRun(`UPDATE barberos SET activo = 0 WHERE id = ?`, [req.params.id]);
    res.json({ mensaje: 'Barbero eliminado' });
});

// ─── CONFIGURACIÓN GENERAL ───────────────────────────────────────────
app.get('/api/config', verificarAdmin, async (req, res) => {
    const conf = await obtenerConfig();
    const { horario, intervalo, ...config } = conf;
    config.horario_semanal = horario;
    config.intervalo_min = intervalo;
    config.horarios = horariosDeLaSemana(conf);
    res.json(config);
});

app.put('/api/config', verificarAdmin, async (req, res) => {
    const { clave } = req.body;
    let { valor } = req.body;
    if (!clave || valor === undefined) return res.status(400).json({ error: 'Faltan datos' });
    if (!Object.prototype.hasOwnProperty.call(CONFIG_EDITABLE, clave)) {
        return res.status(400).json({ error: 'Clave de configuración no permitida' });
    }
    if (clave === 'maps_url') valor = normalizarUrlMaps(valor);
    if (!CONFIG_EDITABLE[clave](valor)) {
        return res.status(400).json({ error: `Valor inválido para ${clave}` });
    }
    const valorFinal = typeof valor === 'string' ? valor.trim() : String(valor);
    await dbRun(`INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?, ?)`, [clave, valorFinal]);
    res.json({ mensaje: 'Configuración actualizada', valor: valorFinal });
});

// Muestra a qué link quedaría convertida una ubicación, sin guardarla (botón "Probar" del panel)
app.get('/api/config/maps-url', verificarAdmin, (req, res) => {
    res.json({ url: normalizarUrlMaps(req.query.valor) });
});

// ─── DISPONIBILIDAD (CLIENTE) ────────────────────────────────────────
app.get('/api/disponibilidad', async (req, res) => {
    const { fecha, barbero_id, servicio_id } = req.query;
    if (!REGEX_FECHA.test(fecha || '')) return res.status(400).json({ error: 'Fecha requerida' });

    const servicio = servicio_id
        ? await dbGet(`SELECT duracion FROM servicios WHERE id = ? AND activo = 1`, [servicio_id])
        : null;
    const conf = await obtenerConfig();
    const disp = await calcularDisponibilidad({
        fecha,
        barberoId: barbero_id || 'cualquiera',
        duracion: duracionAMinutos(servicio?.duracion),
        conf
    });

    if (disp.error) return res.status(400).json({ error: disp.error });
    if (disp.cerrado) return res.json({ bloqueado: true, motivo: disp.motivo, horarios: [] });
    res.json({
        bloqueado: false,
        horarios: disp.horarios.map(({ hora, disponible }) => ({ hora, disponible }))
    });
});

// ─── VERIFICAR ESTADO DE TICKET ACTIVO EN EL CELULAR DEL CLIENTE ─────
// Requiere el token de cancelación que recibió el cliente al agendar, para que
// nadie pueda consultar citas ajenas probando IDs consecutivos.
app.get('/api/citas/:id/ticket-status', async (req, res) => {
    const { id } = req.params;
    const tokenCliente = String(req.query.token || '');
    if (!tokenCliente) return res.json({ activa: false });
    const row = await dbGet(
        `SELECT id, cliente, servicio, precio, fecha, hora, estado, barbero_nombre FROM citas WHERE id = ? AND token_cancelacion = ?`,
        [id, tokenCliente]
    );
    if (!row) return res.json({ activa: false });
    res.json({ activa: row.estado === 'pendiente', cita: row });
});

// ─── AGENDAR CITA ────────────────────────────────────────────────────
// El precio y el nombre del servicio se toman de la base de datos a partir de
// servicio_id; nunca se confía en lo que manda el navegador.
app.post('/api/citas', detectarAdmin, async (req, res) => {
    const { telefono, servicio_id, hora, fecha, barbero_id } = req.body;
    const cliente = typeof req.body.cliente === 'string' ? req.body.cliente.trim() : '';
    const esAdmin = req.esAdmin;

    if (!textoValido(cliente, 80)) {
        return res.status(400).json({ error: 'Ingresa un nombre válido (máx. 80 caracteres).' });
    }
    if (!/^[0-9]{10}$/.test(telefono)) {
        return res.status(400).json({ error: 'El número debe ser de 10 dígitos.' });
    }
    if (!REGEX_FECHA.test(fecha || '')) {
        return res.status(400).json({ error: 'Fecha inválida.' });
    }
    if (!esAdmin && req.body.acepta_privacidad !== true) {
        return res.status(400).json({ error: 'Debes aceptar el Aviso de Privacidad para reservar.' });
    }

    const srv = await dbGet(`SELECT nombre, precio, duracion FROM servicios WHERE id = ? AND activo = 1`, [servicio_id]);
    if (!srv) return res.status(400).json({ error: 'El servicio seleccionado no está disponible.' });

    const conf = await obtenerConfig();

    // El administrador puede registrar citas pasadas o de clientes con faltas; el cliente no
    if (!esAdmin) {
        const hoy = fechaLocalISO();
        if (fecha < hoy) return res.status(400).json({ error: 'No se puede agendar en una fecha pasada.' });
        if (fecha > sumarDias(hoy, DIAS_MAX_RESERVA)) {
            return res.status(400).json({ error: `Solo se puede agendar con hasta ${DIAS_MAX_RESERVA} días de anticipación.` });
        }

        const maxFaltas = Number(conf.max_faltas || 2);
        const rowFaltas = await dbGet(`SELECT COUNT(*) as faltas FROM citas WHERE telefono = ? AND estado = 'no_asistio'`, [telefono]);
        if ((rowFaltas?.faltas || 0) >= maxFaltas) {
            return res.status(403).json({
                error: 'Tu número registra inasistencias previas sin aviso. Contáctanos directamente para agendar.'
            });
        }
    }

    const duracion = duracionAMinutos(srv.duracion);

    const resultado = await enFilaDeReservas(async () => {
        const disp = await calcularDisponibilidad({ fecha, barberoId: barbero_id, duracion, conf, permitirPasado: esAdmin });
        if (disp.error) return { status: 400, body: { error: disp.error } };
        if (disp.cerrado) return { status: 400, body: { error: `Día no disponible: ${disp.motivo}` } };

        const turno = disp.horarios.find(h => h.hora === hora);
        if (!turno) return { status: 400, body: { error: 'Horario inválido.' } };
        if (!turno.disponible) {
            return { status: 409, body: { error: 'Ese horario ya no está disponible. Elige otro, por favor.' } };
        }

        const barbero = turno.libres[0];
        const tokenCancelacion = crypto.randomBytes(12).toString('hex');
        const insert = await dbRun(
            `INSERT INTO citas (cliente, telefono, servicio, precio, hora, fecha, estado, barbero_id, barbero_nombre, token_cancelacion, duracion_min, privacidad_aceptada_en)
             VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?)`,
            [cliente, telefono, srv.nombre, srv.precio, hora, fecha, barbero.id, barbero.nombre, tokenCancelacion, duracion,
             esAdmin ? null : new Date().toISOString()]
        );

        return {
            status: 200,
            body: {
                mensaje: 'Cita agendada',
                id: insert.lastID,
                barbero_nombre: barbero.nombre,
                token_cancelacion: tokenCancelacion
            }
        };
    });

    res.status(resultado.status).json(resultado.body);
});

// ─── REAGENDAR / MOVER CITA EN UN CLIC (ADMIN) ───────────────────────
app.patch('/api/citas/:id/reagendar', verificarAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { fecha, hora, barbero_id } = req.body;

    if (!fecha || !hora) {
        return res.status(400).json({ error: 'Fecha y hora son requeridas para reagendar.' });
    }
    if (!REGEX_FECHA.test(fecha) || !Number.isFinite(horaAMinutos(hora))) {
        return res.status(400).json({ error: 'Fecha u hora inválida.' });
    }

    const citaActual = await dbGet(`SELECT * FROM citas WHERE id = ?`, [id]);
    if (!citaActual) return res.status(404).json({ error: 'Cita no encontrada.' });

    const conf = await obtenerConfig();

    const resultado = await enFilaDeReservas(async () => {
        const disp = await calcularDisponibilidad({
            fecha,
            barberoId: barbero_id || citaActual.barbero_id,
            duracion: citaActual.duracion_min || 60,
            conf,
            excluirCitaId: id,
            permitirPasado: true
        });
        if (disp.error) return { status: 400, body: { error: disp.error } };
        if (disp.cerrado) return { status: 400, body: { error: `Ese día no está disponible: ${disp.motivo}` } };

        const turno = disp.horarios.find(h => h.hora === hora);
        if (!turno) return { status: 400, body: { error: 'Esa hora está fuera del horario de ese día.' } };
        if (!turno.disponible) {
            return { status: 409, body: { error: 'El barbero ya tiene otra cita o un bloqueo en ese horario, o el servicio terminaría después del cierre.' } };
        }

        const barbero = turno.libres[0];
        // `reagendada` hace que el botón de WhatsApp del panel use la plantilla de cita reagendada
        await dbRun(
            `UPDATE citas SET fecha = ?, hora = ?, barbero_id = ?, barbero_nombre = ?, reagendada = 1 WHERE id = ?`,
            [fecha, hora, barbero.id, barbero.nombre, id]
        );
        return { status: 200, body: { mensaje: 'Cita reagendada correctamente' } };
    });

    res.status(resultado.status).json(resultado.body);
});

// ─── CANCELAR CITA ───────────────────────────────────────────────────
app.delete('/api/citas/:id', detectarAdmin, async (req, res) => {
    const { id } = req.params;
    const tokenCliente = req.query.token;

    if (req.esAdmin) {
        await dbRun(`UPDATE citas SET estado = 'cancelada' WHERE id = ?`, [id]);
        return res.json({ mensaje: 'Cita cancelada correctamente' });
    }
    if (!tokenCliente) return res.status(403).json({ error: 'Token de cancelación requerido' });
    const update = await dbRun(`UPDATE citas SET estado = 'cancelada' WHERE id = ? AND token_cancelacion = ?`, [id, tokenCliente]);
    if (update.changes === 0) return res.status(403).json({ error: 'No autorizado para cancelar esta cita' });
    res.json({ mensaje: 'Cita cancelada correctamente' });
});

// ─── PANEL ADMINISTRADOR (REPORTES Y AGENDA) ─────────────────────────
// Filtros opcionales: `fecha` (un día) o `desde` / `hasta` (rango, ambos incluidos) y `barbero_id`
app.get('/api/reportes', verificarAdmin, async (req, res) => {
    const { fecha, desde, hasta, barbero_id } = req.query;
    if ([fecha, desde, hasta].some(f => f && !REGEX_FECHA.test(f))) {
        return res.status(400).json({ error: 'Fecha inválida' });
    }

    const condiciones = [];
    const params = [];
    if (fecha) { condiciones.push(`c.fecha = ?`); params.push(fecha); }
    if (desde) { condiciones.push(`c.fecha >= ?`); params.push(desde); }
    if (hasta) { condiciones.push(`c.fecha <= ?`); params.push(hasta); }
    if (barbero_id) { condiciones.push(`c.barbero_id = ?`); params.push(barbero_id); }
    const filtro = condiciones.map(c => ` AND ${c}`).join('');

    const [citas, desglose] = await Promise.all([
        dbAll(`
            SELECT c.*,
            (SELECT COUNT(*) FROM citas c2 WHERE c2.telefono = c.telefono AND c2.estado = 'no_asistio') as faltas_cliente
            FROM citas c WHERE 1=1${filtro}
            ORDER BY c.fecha ASC, c.hora ASC`, params),
        dbAll(`
            SELECT c.servicio, COUNT(*) as cantidad, SUM(c.precio) as total
            FROM citas c WHERE c.estado = 'completada'${filtro}
            GROUP BY c.servicio`, params)
    ]);

    res.json({
        citas,
        desglose,
        totalGanancias: desglose.reduce((acc, curr) => acc + (curr.total || 0), 0),
        totalCitas: citas.length
    });
});

app.patch('/api/citas/:id/estado', verificarAdmin, async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    if (!ESTADOS_VALIDOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
    await dbRun(`UPDATE citas SET estado = ? WHERE id = ?`, [estado, id]);
    res.json({ mensaje: 'Estado actualizado' });
});

// ─── BLOQUEO DE DÍAS Y HORAS ─────────────────────────────────────────
app.get('/api/bloqueos', verificarAdmin, async (req, res) => {
    res.json(await dbAll(`SELECT * FROM dias_bloqueados ORDER BY fecha ASC`));
});

app.post('/api/bloqueos', verificarAdmin, async (req, res) => {
    const { fecha, motivo, forzar } = req.body;
    if (!REGEX_FECHA.test(fecha || '')) return res.status(400).json({ error: 'Fecha requerida' });
    if (motivo && (typeof motivo !== 'string' || motivo.length > 120)) {
        return res.status(400).json({ error: 'Motivo inválido (máx. 120 caracteres)' });
    }
    const motivoFinal = motivo ? motivo.trim() : 'No laboral / descanso';

    const citas = await dbAll(`SELECT id, cliente, telefono, hora FROM citas WHERE fecha = ? AND estado != 'cancelada'`, [fecha]);
    if (citas.length > 0 && !forzar) {
        return res.status(409).json({
            advertencia: true,
            totalCitas: citas.length,
            citas,
            mensaje: `Hay ${citas.length} citas agendadas ese día.`
        });
    }
    await dbRun(`INSERT OR REPLACE INTO dias_bloqueados (fecha, motivo) VALUES (?, ?)`, [fecha, motivoFinal]);
    if (forzar && citas.length > 0) {
        await dbRun(`UPDATE citas SET estado = 'cancelada' WHERE fecha = ? AND estado != 'cancelada'`, [fecha]);
        return res.json({ mensaje: 'Día bloqueado y citas canceladas.' });
    }
    res.json({ mensaje: 'Día bloqueado exitosamente.' });
});

app.delete('/api/bloqueos/:id', verificarAdmin, async (req, res) => {
    await dbRun(`DELETE FROM dias_bloqueados WHERE id = ?`, [req.params.id]);
    res.json({ mensaje: 'Día desbloqueado' });
});

app.get('/api/horas-bloqueadas', verificarAdmin, async (req, res) => {
    res.json(await dbAll(`SELECT * FROM horas_bloqueadas ORDER BY fecha ASC, hora ASC`));
});

app.post('/api/horas-bloqueadas-rango', verificarAdmin, async (req, res) => {
    const { fecha, horas, motivo } = req.body;
    if (!REGEX_FECHA.test(fecha || '') || !Array.isArray(horas) || horas.length === 0 || horas.length > 24
        || horas.some(h => !Number.isFinite(horaAMinutos(h)))) {
        return res.status(400).json({ error: 'Fecha y horas requeridas' });
    }
    if (motivo && (typeof motivo !== 'string' || motivo.length > 120)) {
        return res.status(400).json({ error: 'Motivo inválido (máx. 120 caracteres)' });
    }
    const motivoFinal = (motivo && motivo.trim().length > 0) ? motivo.trim() : 'Salida / Compromiso';

    for (const h of horas) {
        await dbRun(`INSERT OR REPLACE INTO horas_bloqueadas (fecha, hora, motivo) VALUES (?, ?, ?)`, [fecha, h, motivoFinal]);
    }
    res.json({ mensaje: `${horas.length} horario(s) bloqueado(s) correctamente.` });
});

app.delete('/api/horas-bloqueadas/:id', verificarAdmin, async (req, res) => {
    await dbRun(`DELETE FROM horas_bloqueadas WHERE id = ?`, [req.params.id]);
    res.json({ mensaje: 'Horario liberado' });
});

// Cualquier error no previsto en una ruta responde 500 en JSON en lugar de una página HTML
app.use((err, req, res, next) => {
    console.error('Error en', req.method, req.path, err);
    res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(PORT, () => {
    console.log(`Backend corriendo en http://localhost:${PORT}`);
});