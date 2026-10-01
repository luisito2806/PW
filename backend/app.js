const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const path = require('path');
app.use(express.static(path.join(__dirname, '../frontend')));

const db = new sqlite3.Database('./barberia.db', (err) => {
    if (err) {
        console.error('Error BD:', err.message);
    } else {
        console.log('Conectado exitosamente a SQLite.');
    }
});

db.serialize(() => {
    // Citas
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

    // Días completos bloqueados
    db.run(`CREATE TABLE IF NOT EXISTS dias_bloqueados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT UNIQUE NOT NULL,
        motivo TEXT NOT NULL
    )`);

    // Horas específicas bloqueadas
    db.run(`CREATE TABLE IF NOT EXISTS horas_bloqueadas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL,
        motivo TEXT,
        UNIQUE(fecha, hora)
    )`);
});

const ADMIN_PASSWORD = 'admin';

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.json({ exito: true, token: 'acceso-autorizado-barberia' });
    } else {
        res.status(401).json({ error: 'Contraseña incorrecta' });
    }
});

function verificarAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (authHeader === 'acceso-autorizado-barberia') {
        next();
    } else {
        res.status(403).json({ error: 'Acceso no autorizado' });
    }
}

// ---------------- DISPONIBILIDAD (CLIENTE) ----------------
app.get('/api/disponibilidad', (req, res) => {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'Fecha requerida' });

    db.get(`SELECT motivo FROM dias_bloqueados WHERE fecha = ?`, [fecha], (err, diaBloqueado) => {
        if (err) return res.status(500).json({ error: err.message });
        if (diaBloqueado) {
            return res.json({ bloqueado: true, motivo: diaBloqueado.motivo, horasOcupadas: [] });
        }

        db.all(`SELECT hora FROM citas WHERE fecha = ? AND estado != 'cancelada'`, [fecha], (errCitas, rowsCitas) => {
            if (errCitas) return res.status(500).json({ error: errCitas.message });

            db.all(`SELECT hora FROM horas_bloqueadas WHERE fecha = ?`, [fecha], (errHoras, rowsHoras) => {
                if (errHoras) return res.status(500).json({ error: errHoras.message });

                const ocupadasCitas = rowsCitas.map(r => r.hora);
                const ocupadasAdmin = rowsHoras.map(r => r.hora);
                const todas = [...new Set([...ocupadasCitas, ...ocupadasAdmin])];

                res.json({ bloqueado: false, horasOcupadas: todas });
            });
        });
    });
});

// Agendar cita
app.post('/api/citas', (req, res) => {
    const { cliente, telefono, servicio, precio, hora, fecha } = req.body;

    const regexTelefono = /^[0-9]{10}$/;
    if (!regexTelefono.test(telefono)) {
        return res.status(400).json({ error: 'El número debe ser de 10 dígitos.' });
    }

    db.get(`SELECT motivo FROM dias_bloqueados WHERE fecha = ?`, [fecha], (err, bloqueado) => {
        if (err) return res.status(500).json({ error: err.message });
        if (bloqueado) return res.status(400).json({ error: `Día no laboral: ${bloqueado.motivo}` });

        db.get(`SELECT id FROM horas_bloqueadas WHERE fecha = ? AND hora = ?`, [fecha, hora], (errH, hBloq) => {
            if (errH) return res.status(500).json({ error: errH.message });
            if (hBloq) return res.status(409).json({ error: 'Horario no disponible por salida o compromiso del barbero.' });

            db.get(`SELECT id FROM citas WHERE fecha = ? AND hora = ? AND estado != 'cancelada'`, [fecha, hora], (errC, cita) => {
                if (errC) return res.status(500).json({ error: errC.message });
                if (cita) return res.status(409).json({ error: 'El horario seleccionado ya fue tomado.' });

                const query = `INSERT INTO citas (cliente, telefono, servicio, precio, hora, fecha, estado) VALUES (?, ?, ?, ?, ?, ?, 'pendiente')`;
                db.run(query, [cliente, telefono, servicio, precio, hora, fecha], function(insErr) {
                    if (insErr) return res.status(500).json({ error: insErr.message });
                    res.json({ mensaje: 'Cita agendada', id: this.lastID });
                });
            });
        });
    });
});

// Cancelar cita (Pública para el propio cliente o protegida para admin)
app.delete('/api/citas/:id', (req, res) => {
    const { id } = req.params;
    db.run(`UPDATE citas SET estado = 'cancelada' WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Cita cancelada correctamente' });
    });
});

// ---------------- PANEL ADMINISTRADOR ----------------
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

// Bloqueo de Días
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

// Bloqueo de Horas (por rango y con motivo opcional)
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

    // Insertar cada hora seleccionada
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