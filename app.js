const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ----------------------------------------------------
// BASE DE DATOS
// ----------------------------------------------------
const db = new sqlite3.Database('./barberia.db', (err) => {
    if (err) {
        console.error('Error al conectar a la base de datos:', err.message);
    } else {
        console.log('Conectado exitosamente a la base de datos SQLite.');
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS citas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente TEXT NOT NULL,
        telefono TEXT NOT NULL,
        servicio TEXT NOT NULL,
        precio REAL NOT NULL,
        hora TEXT NOT NULL,
        fecha TEXT NOT NULL,
        estado TEXT DEFAULT 'pendiente'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS dias_bloqueados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT UNIQUE NOT NULL,
        motivo TEXT NOT NULL
    )`);
});

// ----------------------------------------------------
// AUTENTICACIÓN Y SEGURIDAD
// ----------------------------------------------------
const ADMIN_PASSWORD = 'admin'; // Cambia la clave si deseas

// Iniciar sesión
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ exito: true, token: 'acceso-autorizado-barberia' });
    } else {
        res.status(401).json({ error: 'Contraseña incorrecta' });
    }
});

// Middleware para proteger rutas administrativas
function verificarAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (authHeader === 'acceso-autorizado-barberia') {
        next();
    } else {
        res.status(403).json({ error: 'Acceso denegado: debes iniciar sesión.' });
    }
}

// ----------------------------------------------------
// RUTAS PÚBLICAS (Para clientes)
// ----------------------------------------------------

// Consultar disponibilidad (horas ocupadas y días bloqueados)
app.get('/api/disponibilidad', (req, res) => {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'La fecha es requerida' });

    db.get(`SELECT motivo FROM dias_bloqueados WHERE fecha = ?`, [fecha], (err, diaBloqueado) => {
        if (err) return res.status(500).json({ error: err.message });
        if (diaBloqueado) {
            return res.json({ bloqueado: true, motivo: diaBloqueado.motivo, horasOcupadas: [] });
        }

        db.all(`SELECT hora FROM citas WHERE fecha = ? AND estado != 'cancelada'`, [fecha], (errCitas, rows) => {
            if (errCitas) return res.status(500).json({ error: errCitas.message });
            res.json({ bloqueado: false, horasOcupadas: rows.map(r => r.hora) });
        });
    });
});

// Agendar cita
app.post('/api/citas', (req, res) => {
    const { cliente, telefono, servicio, precio, hora, fecha } = req.body;

    const regexTelefono = /^[0-9]{10}$/;
    if (!regexTelefono.test(telefono)) {
        return res.status(400).json({ error: 'El número de teléfono debe ser de 10 dígitos.' });
    }

    db.get(`SELECT motivo FROM dias_bloqueados WHERE fecha = ?`, [fecha], (err, bloqueado) => {
        if (err) return res.status(500).json({ error: err.message });
        if (bloqueado) {
            return res.status(400).json({ error: `Este día no laboramos: ${bloqueado.motivo}` });
        }

        db.get(`SELECT id FROM citas WHERE fecha = ? AND hora = ? AND estado != 'cancelada'`, [fecha, hora], (errHora, row) => {
            if (errHora) return res.status(500).json({ error: errHora.message });
            if (row) return res.status(409).json({ error: 'El horario seleccionado ya no está disponible.' });

            const insertQuery = `INSERT INTO citas (cliente, telefono, servicio, precio, hora, fecha, estado) VALUES (?, ?, ?, ?, ?, ?, 'pendiente')`;
            db.run(insertQuery, [cliente, telefono, servicio, precio, hora, fecha], function(insErr) {
                if (insErr) return res.status(500).json({ error: insErr.message });
                res.json({ mensaje: 'Cita agendada con éxito', id: this.lastID });
            });
        });
    });
});

// ----------------------------------------------------
// RUTAS PROTEGIDAS (Panel Admin)
// ----------------------------------------------------

// Reportes financieros y citas
app.get('/api/reportes', verificarAdmin, (req, res) => {
    const { fecha } = req.query;
    let queryCitas = `SELECT * FROM citas`;
    let queryDesglose = `SELECT servicio, COUNT(*) as cantidad, SUM(precio) as total FROM citas WHERE estado = 'completada'`;
    const paramsCitas = [];
    const paramsDesglose = [];

    if (fecha) {
        queryCitas += ` WHERE fecha = ?`;
        queryDesglose += ` AND fecha = ?`;
        paramsCitas.push(fecha);
        paramsDesglose.push(fecha);
    }

    queryCitas += ` ORDER BY fecha ASC, hora ASC`;
    queryDesglose += ` GROUP BY servicio`;

    db.all(queryCitas, paramsCitas, (err, citas) => {
        if (err) return res.status(500).json({ error: err.message });

        db.all(queryDesglose, paramsDesglose, (errDesglose, desglose) => {
            if (errDesglose) return res.status(500).json({ error: errDesglose.message });

            const rowsDesglose = desglose || [];
            const totalGanancias = rowsDesglose.reduce((acc, curr) => acc + (curr.total || 0), 0);
            
            res.json({
                citas: citas || [],
                desglose: rowsDesglose,
                totalGanancias: totalGanancias,
                totalCitas: (citas || []).length
            });
        });
    });
});

// Cambiar estado (pendiente / completada)
app.patch('/api/citas/:id/estado', verificarAdmin, (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;

    if (!['pendiente', 'completada'].includes(estado)) {
        return res.status(400).json({ error: 'Estado inválido' });
    }

    db.run(`UPDATE citas SET estado = ? WHERE id = ?`, [estado, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Estado actualizado correctamente' });
    });
});

// Cancelar/Eliminar cita
app.delete('/api/citas/:id', verificarAdmin, (req, res) => {
    const { id } = req.params;
    db.run(`DELETE FROM citas WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Cita cancelada correctamente' });
    });
});

// Listar bloqueos
app.get('/api/bloqueos', verificarAdmin, (req, res) => {
    db.all(`SELECT * FROM dias_bloqueados ORDER BY fecha ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Bloquear fecha
app.post('/api/bloqueos', verificarAdmin, (req, res) => {
    const { fecha, motivo, forzar } = req.body;
    if (!fecha || !motivo) return res.status(400).json({ error: 'Campos requeridos' });

    db.all(`SELECT id, cliente, telefono, hora FROM citas WHERE fecha = ? AND estado != 'cancelada'`, [fecha], (err, citasExistentes) => {
        if (err) return res.status(500).json({ error: err.message });

        if (citasExistentes.length > 0 && !forzar) {
            return res.status(409).json({
                advertencia: true,
                totalCitas: citasExistentes.length,
                citas: citasExistentes,
                mensaje: `Existen ${citasExistentes.length} cita(s) agendada(s) para este día.`
            });
        }

        db.run(`INSERT OR REPLACE INTO dias_bloqueados (fecha, motivo) VALUES (?, ?)`, [fecha, motivo], function(errBloqueo) {
            if (errBloqueo) return res.status(500).json({ error: errBloqueo.message });

            if (forzar && citasExistentes.length > 0) {
                db.run(`UPDATE citas SET estado = 'cancelada' WHERE fecha = ? AND estado != 'cancelada'`, [fecha], (errUpdate) => {
                    if (errUpdate) return res.status(500).json({ error: errUpdate.message });
                    res.json({ mensaje: 'Día bloqueado y citas canceladas.' });
                });
            } else {
                res.json({ mensaje: 'Día bloqueado exitosamente.' });
            }
        });
    });
});

// Desbloquear fecha
app.delete('/api/bloqueos/:id', verificarAdmin, (req, res) => {
    const { id } = req.params;
    db.run(`DELETE FROM dias_bloqueados WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Día desbloqueado correctamente' });
    });
});

// Encender el servidor
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});