const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../frontend')));

const db = new sqlite3.Database('./barberia.db', (err) => {
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
            ['wa_template', '¡Hola {{cliente}}! 👋 Te recordamos tu cita en *{{negocio}}*:\n📅 Fecha: {{fecha}}\n🕐 Hora: {{hora}}\n💈 Barbero: {{barbero}}\n✂️ Servicio: {{servicio}}\n💰 Total: ${{precio}} MXN\n\nResponde con un *OK* o un 👍 para confirmar de recibido. ¡Te esperamos! 🙌'],
            ['hora_apertura', '10'],
            ['hora_cierre', '19'],
            ['maps_url', 'https://maps.google.com'],
            ['max_faltas', '2']
        ];
        const stmt = db.prepare(`INSERT OR IGNORE INTO configuracion (clave, valor) VALUES (?, ?)`);
        defaults.forEach(([k, v]) => stmt.run(k, v));
        stmt.finalize();
    });
});

// ─── BOT DE WHATSAPP (BAILEYS CON ANTI-BANEO) ────────────────────────
let waSock = null;
let waStatus = 'desconectado';
let waQrBase64 = null;

async function iniciarWhatsApp() {
    try {
        const {
            default: makeWASocket,
            useMultiFileAuthState,
            DisconnectReason,
            fetchLatestBaileysVersion
        } = await import('@whiskeysockets/baileys');

        const { state, saveCreds } = await useMultiFileAuthState('./wa_auth_info');
        const { version } = await fetchLatestBaileysVersion();

        waSock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' })
        });

        waSock.ev.on('creds.update', saveCreds);

        waSock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                waStatus = 'esperando_qr';
                waQrBase64 = await QRCode.toDataURL(qr);
            }

            if (connection === 'close') {
                waQrBase64 = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                waStatus = 'desconectado';

                if (shouldReconnect) {
                    setTimeout(iniciarWhatsApp, 4000);
                } else {
                    if (fs.existsSync('./wa_auth_info')) {
                        fs.rmSync('./wa_auth_info', { recursive: true, force: true });
                    }
                    setTimeout(iniciarWhatsApp, 2000);
                }
            } else if (connection === 'open') {
                waStatus = 'conectado';
                waQrBase64 = null;
                console.log('✅ WhatsApp conectado y listo para enviar mensajes automáticos');
            }
        });
    } catch (err) {
        console.error('Error iniciando WhatsApp:', err.message);
    }
}

iniciarWhatsApp();

async function enviarWhatsAppAutomatico(cita, textoPersonalizado = null) {
    if (waStatus !== 'conectado' || !waSock) return false;
    try {
        db.all(`SELECT * FROM configuracion`, [], async (err, rows) => {
            const conf = {};
            (rows || []).forEach(r => { conf[r.clave] = r.valor; });

            const nombreNegocio = conf.nombre_negocio || 'Doo Barber';
            let msg = textoPersonalizado || conf.wa_template || `¡Hola {{cliente}}! Tu cita en *${nombreNegocio}* es el {{fecha}} a las {{hora}}.`;

            const [y, m, d] = (cita.fecha || '').split('-');
            const fechaCorta = y ? `${d}-${m}-${y.slice(-2)}` : cita.fecha;

            msg = msg.replace(/\{\{negocio\}\}/g, nombreNegocio)
                     .replace(/\{\{cliente\}\}/g, cita.cliente || '')
                     .replace(/\{\{fecha\}\}/g, fechaCorta)
                     .replace(/\{\{hora\}\}/g, cita.hora || '')
                     .replace(/\{\{servicio\}\}/g, cita.servicio || '')
                     .replace(/\{\{precio\}\}/g, cita.precio || '')
                     .replace(/\{\{barbero\}\}/g, cita.barbero_nombre || 'General');

            const cleanPhone = (cita.telefono || '').replace(/\D/g, '');
            const [result] = await waSock.onWhatsApp(`521${cleanPhone}`, `52${cleanPhone}`);

            if (!result || !result.exists) return;
            const jid = result.jid;

            // Simulación de escritura humana (Anti-Baneo)
            const delayInicial = Math.floor(Math.random() * 2000) + 2000;
            await new Promise(r => setTimeout(r, delayInicial));

            await waSock.sendPresenceUpdate('composing', jid);
            const tiempoEscritura = Math.floor(Math.random() * 2500) + 1500;
            await new Promise(r => setTimeout(r, tiempoEscritura));
            await waSock.sendPresenceUpdate('paused', jid);

            await waSock.sendMessage(jid, { text: msg });
        });
        return true;
    } catch (e) {
        console.error('Error enviando WA:', e.message);
        return false;
    }
}

// ─── GENERADOR DE HORARIOS (1 HORA POR BLOQUE) ───────────────────────
function generarHorarios(inicio = 10, fin = 19) {
    const lista = [];
    for (let h = parseInt(inicio, 10); h <= parseInt(fin, 10); h++) {
        const ampm = h >= 12 ? 'PM' : 'AM';
        let h12 = h % 12;
        if (h12 === 0) h12 = 12;
        lista.push(`${String(h12).padStart(2, '0')}:00 ${ampm}`);
    }
    return lista;
}

// ─── AUTENTICACIÓN ───────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const ADMIN_TOKEN = 'acceso-autorizado-barberia';

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ exito: true, token: ADMIN_TOKEN });
    } else {
        res.status(401).json({ error: 'Contraseña incorrecta' });
    }
});

function verificarAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (authHeader === ADMIN_TOKEN) {
        next();
    } else {
        res.status(403).json({ error: 'Acceso no autorizado' });
    }
}

// ─── ENDPOINTS WHATSAPP ──────────────────────────────────────────────
app.get('/api/whatsapp/status', verificarAdmin, (req, res) => {
    res.json({ status: waStatus, qr: waQrBase64 });
});

app.post('/api/whatsapp/logout', verificarAdmin, async (req, res) => {
    try {
        if (waSock) await waSock.logout();
    } catch {}
    if (fs.existsSync('./wa_auth_info')) {
        fs.rmSync('./wa_auth_info', { recursive: true, force: true });
    }
    waStatus = 'desconectado';
    waQrBase64 = null;
    setTimeout(iniciarWhatsApp, 1500);
    res.json({ mensaje: 'Sesión de WhatsApp reiniciada' });
});

// ─── LIMPIAR BASE DE DATOS DE CITAS Y BLOQUEOS (DEJAR COMO NUEVO) ────
app.delete('/api/reset-citas', verificarAdmin, (req, res) => {
    db.serialize(() => {
        db.run(`DELETE FROM citas`);
        db.run(`DELETE FROM dias_bloqueados`);
        db.run(`DELETE FROM horas_bloqueadas`);
        db.run(`DELETE FROM sqlite_sequence WHERE name IN ('citas', 'dias_bloqueados', 'horas_bloqueadas')`, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ mensaje: 'Base de datos de citas y bloqueos limpia como nueva.' });
        });
    });
});

// ─── CATÁLOGO PÚBLICO (INCLUYE MARCA BLANCA: NOMBRE Y LOGO) ──────────
app.get('/api/catalogo', (req, res) => {
    db.all(`SELECT * FROM servicios WHERE activo = 1 ORDER BY id ASC`, [], (errS, servicios) => {
        db.all(`SELECT * FROM barberos WHERE activo = 1 ORDER BY id ASC`, [], (errB, barberos) => {
            db.all(`SELECT * FROM configuracion`, [], (errC, confRows) => {
                const config = {};
                (confRows || []).forEach(r => { config[r.clave] = r.valor; });
                const horarios = generarHorarios(config.hora_apertura || 10, config.hora_cierre || 19);
                res.json({
                    nombre_negocio: config.nombre_negocio || 'Doo Barber',
                    logo_url: config.logo_url || '',
                    servicios: servicios || [],
                    barberos: barberos || [],
                    horarios,
                    maps_url: config.maps_url || 'https://maps.google.com'
                });
            });
        });
    });
});

// ─── CRUD SERVICIOS ──────────────────────────────────────────────────
app.post('/api/servicios', verificarAdmin, (req, res) => {
    const { nombre, descripcion, precio, duracion } = req.body;
    if (!nombre || precio === undefined) return res.status(400).json({ error: 'Nombre y precio requeridos' });
    db.run(
        `INSERT INTO servicios (nombre, descripcion, precio, duracion, activo) VALUES (?, ?, ?, ?, 1)`,
        [nombre.trim(), (descripcion || '').trim(), Number(precio), duracion || '60 min'],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, mensaje: 'Servicio agregado' });
        }
    );
});

app.delete('/api/servicios/:id', verificarAdmin, (req, res) => {
    db.run(`UPDATE servicios SET activo = 0 WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Servicio eliminado' });
    });
});

// ─── CRUD BARBEROS ───────────────────────────────────────────────────
app.post('/api/barberos', verificarAdmin, (req, res) => {
    const { nombre, especialidad, foto } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    db.run(
        `INSERT INTO barberos (nombre, especialidad, foto, activo) VALUES (?, ?, ?, 1)`,
        [nombre.trim(), (especialidad || 'Barbero').trim(), foto || ''],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, mensaje: 'Barbero agregado' });
        }
    );
});

app.delete('/api/barberos/:id', verificarAdmin, (req, res) => {
    db.run(`UPDATE barberos SET activo = 0 WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Barbero eliminado' });
    });
});

// ─── CONFIGURACIÓN GENERAL ───────────────────────────────────────────
app.get('/api/config', verificarAdmin, (req, res) => {
    db.all(`SELECT * FROM configuracion`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const config = {};
        rows.forEach(r => { config[r.clave] = r.valor; });
        config.horarios = generarHorarios(config.hora_apertura || 10, config.hora_cierre || 19);
        res.json(config);
    });
});

app.put('/api/config', verificarAdmin, (req, res) => {
    const { clave, valor } = req.body;
    if (!clave || valor === undefined) return res.status(400).json({ error: 'Faltan datos' });
    db.run(`INSERT OR REPLACE INTO configuracion (clave, valor) VALUES (?, ?)`, [clave, String(valor)], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Configuración actualizada' });
    });
});

// ─── DISPONIBILIDAD (CLIENTE) ────────────────────────────────────────
app.get('/api/disponibilidad', (req, res) => {
    const { fecha, barbero_id } = req.query;
    if (!fecha) return res.status(400).json({ error: 'Fecha requerida' });

    db.get(`SELECT motivo FROM dias_bloqueados WHERE fecha = ?`, [fecha], (err, diaBloqueado) => {
        if (err) return res.status(500).json({ error: err.message });
        if (diaBloqueado) {
            return res.json({ bloqueado: true, motivo: diaBloqueado.motivo, horasOcupadas: [] });
        }

        db.all(`SELECT id FROM barberos WHERE activo = 1`, [], (errB, barberosActivos) => {
            const totalBarberos = (barberosActivos && barberosActivos.length) ? barberosActivos.length : 1;

            db.all(`SELECT hora, barbero_id FROM citas WHERE fecha = ? AND estado != 'cancelada'`, [fecha], (errCitas, rowsCitas) => {
                if (errCitas) return res.status(500).json({ error: errCitas.message });

                db.all(`SELECT hora FROM horas_bloqueadas WHERE fecha = ?`, [fecha], (errHoras, rowsHoras) => {
                    if (errHoras) return res.status(500).json({ error: errHoras.message });

                    const ocupadasAdmin = rowsHoras.map(r => r.hora);
                    let ocupadasCitas = [];

                    if (barbero_id && barbero_id !== 'cualquiera') {
                        ocupadasCitas = rowsCitas
                            .filter(r => String(r.barbero_id) === String(barbero_id))
                            .map(r => r.hora);
                    } else {
                        const conteoPorHora = {};
                        rowsCitas.forEach(r => {
                            conteoPorHora[r.hora] = (conteoPorHora[r.hora] || 0) + 1;
                        });
                        ocupadasCitas = Object.keys(conteoPorHora).filter(h => conteoPorHora[h] >= totalBarberos);
                    }

                    const todas = [...new Set([...ocupadasCitas, ...ocupadasAdmin])];
                    res.json({ bloqueado: false, horasOcupadas: todas });
                });
            });
        });
    });
});

// ─── VERIFICAR ESTADO DE TICKET ACTIVO EN EL CELULAR DEL CLIENTE ─────
app.get('/api/citas/:id/ticket-status', (req, res) => {
    const { id } = req.params;
    db.get(`SELECT id, cliente, servicio, precio, fecha, hora, estado, barbero_nombre FROM citas WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json({ activa: false });
        const activa = (row.estado === 'pendiente');
        res.json({ activa, cita: row });
    });
});

// ─── AGENDAR CITA ────────────────────────────────────────────────────
app.post('/api/citas', (req, res) => {
    const { cliente, telefono, servicio, precio, hora, fecha, barbero_id } = req.body;
    const esAdmin = req.headers['authorization'] === ADMIN_TOKEN;

    const regexTelefono = /^[0-9]{10}$/;
    if (!regexTelefono.test(telefono)) {
        return res.status(400).json({ error: 'El número debe ser de 10 dígitos.' });
    }

    db.get(`SELECT valor FROM configuracion WHERE clave = 'max_faltas'`, [], (errConf, rowMax) => {
        const maxFaltas = Number(rowMax?.valor || 2);

        db.get(
            `SELECT COUNT(*) as faltas FROM citas WHERE telefono = ? AND estado = 'no_asistio'`,
            [telefono],
            (errF, rowFaltas) => {
                if (!esAdmin && (rowFaltas?.faltas || 0) >= maxFaltas) {
                    return res.status(403).json({
                        error: 'Tu número registra inasistencias previas sin aviso. Contáctanos directamente para agendar.'
                    });
                }

                db.get(`SELECT motivo FROM dias_bloqueados WHERE fecha = ?`, [fecha], (err, bloqueado) => {
                    if (err) return res.status(500).json({ error: err.message });
                    if (bloqueado) return res.status(400).json({ error: `Día no laboral: ${bloqueado.motivo}` });

                    db.get(`SELECT id FROM horas_bloqueadas WHERE fecha = ? AND hora = ?`, [fecha, hora], (errH, hBloq) => {
                        if (errH) return res.status(500).json({ error: errH.message });
                        if (hBloq) return res.status(409).json({ error: 'Horario no disponible por salida o compromiso del barbero.' });

                        db.all(`SELECT * FROM barberos WHERE activo = 1`, [], (errB, barberos) => {
                            const listaBarberos = (barberos && barberos.length > 0)
                                ? barberos
                                : [{ id: 1, nombre: 'Barbero Principal' }];

                            db.all(
                                `SELECT barbero_id FROM citas WHERE fecha = ? AND hora = ? AND estado != 'cancelada'`,
                                [fecha, hora],
                                (errC, citasEnHora) => {
                                    if (errC) return res.status(500).json({ error: errC.message });
                                    const ocupadosIds = (citasEnHora || []).map(c => Number(c.barbero_id));
                                    let barberoElegido = null;

                                    if (barbero_id && barbero_id !== 'cualquiera') {
                                        if (ocupadosIds.includes(Number(barbero_id))) {
                                            return res.status(409).json({ error: 'Este barbero ya tiene una cita en ese horario.' });
                                        }
                                        barberoElegido = listaBarberos.find(b => Number(b.id) === Number(barbero_id)) || listaBarberos[0];
                                    } else {
                                        const disponibles = listaBarberos.filter(b => !ocupadosIds.includes(Number(b.id)));
                                        if (disponibles.length === 0) {
                                            return res.status(409).json({ error: 'El horario seleccionado ya fue tomado.' });
                                        }
                                        barberoElegido = disponibles[0];
                                    }

                                    const tokenCancelacion = crypto.randomBytes(12).toString('hex');
                                    const query = `INSERT INTO citas (cliente, telefono, servicio, precio, hora, fecha, estado, barbero_id, barbero_nombre, token_cancelacion)
                                                   VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?)`;

                                    db.run(
                                        query,
                                        [cliente, telefono, servicio, precio, hora, fecha, barberoElegido.id, barberoElegido.nombre, tokenCancelacion],
                                        function(insErr) {
                                            if (insErr) return res.status(500).json({ error: insErr.message });

                                            const citaCreada = {
                                                id: this.lastID,
                                                cliente,
                                                telefono,
                                                servicio,
                                                precio,
                                                hora,
                                                fecha,
                                                barbero_nombre: barberoElegido.nombre
                                            };

                                            enviarWhatsAppAutomatico(citaCreada);

                                            res.json({
                                                mensaje: 'Cita agendada',
                                                id: this.lastID,
                                                barbero_nombre: barberoElegido.nombre,
                                                token_cancelacion: tokenCancelacion
                                            });
                                        }
                                    );
                                }
                            );
                        });
                    });
                });
            }
        );
    });
});

// ─── REAGENDAR / MOVER CITA EN UN CLIC (ADMIN) ───────────────────────
app.patch('/api/citas/:id/reagendar', verificarAdmin, (req, res) => {
    const { id } = req.params;
    const { fecha, hora, barbero_id } = req.body;

    if (!fecha || !hora) {
        return res.status(400).json({ error: 'Fecha y hora son requeridas para reagendar.' });
    }

    db.get(`SELECT * FROM citas WHERE id = ?`, [id], (errCita, citaActual) => {
        if (errCita || !citaActual) return res.status(404).json({ error: 'Cita no encontrada.' });

        db.get(`SELECT motivo FROM dias_bloqueados WHERE fecha = ?`, [fecha], (errDia, diaBloq) => {
            if (diaBloq) return res.status(400).json({ error: `Ese día está bloqueado: ${diaBloq.motivo}` });

            db.get(`SELECT id FROM horas_bloqueadas WHERE fecha = ? AND hora = ?`, [fecha, hora], (errHora, horaBloq) => {
                if (horaBloq) return res.status(409).json({ error: 'Esa hora está bloqueada en la agenda.' });

                const idBarberoFinal = Number(barbero_id || citaActual.barbero_id || 1);

                db.get(
                    `SELECT id FROM citas WHERE fecha = ? AND hora = ? AND barbero_id = ? AND estado != 'cancelada' AND id != ?`,
                    [fecha, hora, idBarberoFinal, id],
                    (errOcup, citaOcupada) => {
                        if (citaOcupada) {
                            return res.status(409).json({ error: 'El barbero seleccionado ya tiene otra cita en esa fecha y hora.' });
                        }

                        db.get(`SELECT nombre FROM barberos WHERE id = ?`, [idBarberoFinal], (errB, rowBarbero) => {
                            const nombreBarberoFinal = rowBarbero ? rowBarbero.nombre : (citaActual.barbero_nombre || 'General');

                            db.run(
                                `UPDATE citas SET fecha = ?, hora = ?, barbero_id = ?, barbero_nombre = ? WHERE id = ?`,
                                [fecha, hora, idBarberoFinal, nombreBarberoFinal, id],
                                function(errUpd) {
                                    if (errUpd) return res.status(500).json({ error: errUpd.message });

                                    const citaActualizada = {
                                        ...citaActual,
                                        fecha,
                                        hora,
                                        barbero_id: idBarberoFinal,
                                        barbero_nombre: nombreBarberoFinal
                                    };

                                    enviarWhatsAppAutomatico(
                                        citaActualizada,
                                        `¡Hola {{cliente}}! 🔄 Tu cita en *{{negocio}}* ha sido reagendada:\n📅 Nueva Fecha: {{fecha}}\n🕐 Nueva Hora: {{hora}}\n💈 Barbero: {{barbero}}\n✂️ Servicio: {{servicio}}\n\n¡Te esperamos! 🙌`
                                    );

                                    res.json({ mensaje: 'Cita reagendada correctamente' });
                                }
                            );
                        });
                    }
                );
            });
        });
    });
});

// ─── CANCELAR CITA ───────────────────────────────────────────────────
app.delete('/api/citas/:id', (req, res) => {
    const { id } = req.params;
    const tokenCliente = req.query.token;
    const esAdmin = req.headers['authorization'] === ADMIN_TOKEN;

    if (esAdmin) {
        db.run(`UPDATE citas SET estado = 'cancelada' WHERE id = ?`, [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ mensaje: 'Cita cancelada correctamente' });
        });
    } else {
        if (!tokenCliente) return res.status(403).json({ error: 'Token de cancelación requerido' });
        db.run(`UPDATE citas SET estado = 'cancelada' WHERE id = ? AND token_cancelacion = ?`, [id, tokenCliente], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(403).json({ error: 'No autorizado para cancelar esta cita' });
            res.json({ mensaje: 'Cita cancelada correctamente' });
        });
    }
});

// ─── PANEL ADMINISTRADOR (REPORTES Y AGENDA) ─────────────────────────
app.get('/api/reportes', verificarAdmin, (req, res) => {
    const { fecha, barbero_id } = req.query;
    let queryCitas = `
        SELECT c.*,
        (SELECT COUNT(*) FROM citas c2 WHERE c2.telefono = c.telefono AND c2.estado = 'no_asistio') as faltas_cliente
        FROM citas c WHERE 1=1
    `;
    let queryDesglose = `SELECT servicio, COUNT(*) as cantidad, SUM(precio) as total FROM citas WHERE estado = 'completada'`;
    const paramsCitas = [];
    const paramsDesglose = [];

    if (fecha) {
        queryCitas += ` AND c.fecha = ?`;
        queryDesglose += ` AND fecha = ?`;
        paramsCitas.push(fecha);
        paramsDesglose.push(fecha);
    }

    if (barbero_id) {
        queryCitas += ` AND c.barbero_id = ?`;
        queryDesglose += ` AND barbero_id = ?`;
        paramsCitas.push(barbero_id);
        paramsDesglose.push(barbero_id);
    }

    queryCitas += ` ORDER BY c.fecha ASC, c.hora ASC`;
    queryDesglose += ` GROUP BY servicio`;

    db.all(queryCitas, paramsCitas, (err, citas) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all(queryDesglose, paramsDesglose, (errD, desglose) => {
            if (errD) return res.status(500).json({ error: errD.message });
            const rows = desglose || [];
            res.json({
                citas: citas || [],
                desglose: rows,
                totalGanancias: rows.reduce((acc, curr) => acc + (curr.total || 0), 0),
                totalCitas: (citas || []).length
            });
        });
    });
});

app.patch('/api/citas/:id/estado', verificarAdmin, (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    db.run(`UPDATE citas SET estado = ? WHERE id = ?`, [estado, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Estado actualizado' });
    });
});

// ─── BLOQUEO DE DÍAS Y HORAS ─────────────────────────────────────────
app.get('/api/bloqueos', verificarAdmin, (req, res) => {
    db.all(`SELECT * FROM dias_bloqueados ORDER BY fecha ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/bloqueos', verificarAdmin, (req, res) => {
    const { fecha, motivo, forzar } = req.body;
    if (!fecha) return res.status(400).json({ error: 'Fecha requerida' });
    const motivoFinal = motivo ? motivo.trim() : 'No laboral / descanso';

    db.all(`SELECT id, cliente, telefono, hora FROM citas WHERE fecha = ? AND estado != 'cancelada'`, [fecha], (err, citas) => {
        if (err) return res.status(500).json({ error: err.message });
        if (citas.length > 0 && !forzar) {
            return res.status(409).json({
                advertencia: true,
                totalCitas: citas.length,
                citas,
                mensaje: `Hay ${citas.length} citas agendadas ese día.`
            });
        }
        db.run(`INSERT OR REPLACE INTO dias_bloqueados (fecha, motivo) VALUES (?, ?)`, [fecha, motivoFinal], function(errB) {
            if (errB) return res.status(500).json({ error: errB.message });
            if (forzar && citas.length > 0) {
                db.run(`UPDATE citas SET estado = 'cancelada' WHERE fecha = ? AND estado != 'cancelada'`, [fecha], () => {
                    res.json({ mensaje: 'Día bloqueado y citas canceladas.' });
                });
            } else {
                res.json({ mensaje: 'Día bloqueado exitosamente.' });
            }
        });
    });
});

app.delete('/api/bloqueos/:id', verificarAdmin, (req, res) => {
    db.run(`DELETE FROM dias_bloqueados WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Día desbloqueado' });
    });
});

app.get('/api/horas-bloqueadas', verificarAdmin, (req, res) => {
    db.all(`SELECT * FROM horas_bloqueadas ORDER BY fecha ASC, hora ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/horas-bloqueadas-rango', verificarAdmin, (req, res) => {
    const { fecha, horas, motivo } = req.body;
    if (!fecha || !Array.isArray(horas) || horas.length === 0) {
        return res.status(400).json({ error: 'Fecha y horas requeridas' });
    }
    const motivoFinal = (motivo && motivo.trim().length > 0) ? motivo.trim() : 'Salida / Compromiso';

    const stmt = db.prepare(`INSERT OR REPLACE INTO horas_bloqueadas (fecha, hora, motivo) VALUES (?, ?, ?)`);
    horas.forEach(h => {
        stmt.run(fecha, h, motivoFinal);
    });
    stmt.finalize((err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: `${horas.length} horario(s) bloqueado(s) correctamente.` });
    });
});

app.delete('/api/horas-bloqueadas/:id', verificarAdmin, (req, res) => {
    db.run(`DELETE FROM horas_bloqueadas WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Horario liberado' });
    });
});

app.listen(PORT, () => {
    console.log(`Backend corriendo en http://localhost:${PORT}`);
});