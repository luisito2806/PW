-- Esquema inicial de la base de datos (Cloudflare D1, compatible con SQLite).
-- Se aplica con: npm run db:migrar:local  (o db:migrar para la base en Cloudflare)

-- Citas. La hora se guarda como texto ("01:30 PM") para mostrarla, y además como
-- minutos desde medianoche (inicio_min / fin_min) para detectar empalmes en SQL.
CREATE TABLE citas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente TEXT NOT NULL,
    telefono TEXT NOT NULL,
    servicio TEXT NOT NULL,
    precio REAL NOT NULL,
    hora TEXT NOT NULL,
    fecha TEXT NOT NULL,
    inicio_min INTEGER NOT NULL,
    fin_min INTEGER NOT NULL,
    duracion_min INTEGER NOT NULL DEFAULT 60,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    barbero_id INTEGER NOT NULL,
    barbero_nombre TEXT NOT NULL,
    token_cancelacion TEXT,
    reagendada INTEGER NOT NULL DEFAULT 0,
    -- Cuándo aceptó el cliente el Aviso de Privacidad (vacío en citas registradas por el admin)
    privacidad_aceptada_en TEXT
);
CREATE INDEX idx_citas_fecha ON citas (fecha, barbero_id);
CREATE INDEX idx_citas_telefono ON citas (telefono);

-- Días completos bloqueados
CREATE TABLE dias_bloqueados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT UNIQUE NOT NULL,
    motivo TEXT NOT NULL
);

-- Horas específicas bloqueadas
CREATE TABLE horas_bloqueadas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    hora TEXT NOT NULL,
    motivo TEXT,
    UNIQUE (fecha, hora)
);

-- Servicios. La duración se guarda como texto ("50 min")
CREATE TABLE servicios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    descripcion TEXT,
    precio REAL NOT NULL,
    duracion TEXT NOT NULL DEFAULT '60 min',
    activo INTEGER NOT NULL DEFAULT 1
);

-- Barberos (con foto opcional como data URL)
CREATE TABLE barberos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    especialidad TEXT DEFAULT 'Barbero',
    foto TEXT DEFAULT '',
    activo INTEGER NOT NULL DEFAULT 1
);

-- Configuración general (clave → valor)
CREATE TABLE configuracion (
    clave TEXT PRIMARY KEY,
    valor TEXT
);

-- Sesiones del panel (se guarda el hash del token, nunca el token)
CREATE TABLE sesiones (
    token_hash TEXT PRIMARY KEY,
    expira INTEGER NOT NULL
);

-- Intentos fallidos de login por IP
CREATE TABLE intentos_login (
    ip TEXT PRIMARY KEY,
    intentos INTEGER NOT NULL,
    bloqueado_hasta INTEGER NOT NULL DEFAULT 0
);

-- Datos de arranque
INSERT INTO servicios (nombre, descripcion, precio, duracion) VALUES
    ('Corte Clásico', 'Corte a tijera o a máquina', 150, '30 min'),
    ('Corte + Barba', 'Corte y arreglo de barba', 250, '50 min'),
    ('Corte + Ceja', 'Corte y depilación de cejas', 200, '40 min'),
    ('Servicio Completo', 'Pelo, barba y cejas incluidos', 300, '70 min');

INSERT INTO barberos (nombre, especialidad) VALUES ('Barbero Principal', 'Corte y Barba');

-- En las plantillas, "\n" se convierte en salto de línea con replace()
INSERT INTO configuracion (clave, valor) VALUES
    ('nombre_negocio', 'Doo Barber'),
    ('logo_url', ''),
    ('color_primario', '#B8893A'),
    ('privacidad_responsable', ''),
    ('privacidad_domicilio', ''),
    ('privacidad_contacto', ''),
    ('wa_template', replace('¡Hola {{cliente}}! 👋 Te recordamos tu cita en *{{negocio}}*:\n📅 Fecha: {{fecha}}\n🕐 Hora: {{hora}}\n💈 Barbero: {{barbero}}\n✂️ Servicio: {{servicio}}\n💰 Total: ${{precio}} MXN\n\nResponde con un *OK* o un 👍 para confirmar de recibido. ¡Te esperamos! 🙌', '\n', char(10))),
    ('wa_template_reagendada', replace('¡Hola {{cliente}}! 🔄 Tu cita en *{{negocio}}* ha sido reagendada:\n📅 Nueva fecha: {{fecha}}\n🕐 Nueva hora: {{hora}}\n💈 Barbero: {{barbero}}\n✂️ Servicio: {{servicio}}\n\nResponde con un *OK* o un 👍 para confirmar. ¡Te esperamos! 🙌', '\n', char(10))),
    ('horario_semanal', '[{"abre":"10:00","cierra":"20:00"},{"abre":"10:00","cierra":"20:00"},{"abre":"10:00","cierra":"20:00"},{"abre":"10:00","cierra":"20:00"},{"abre":"10:00","cierra":"20:00"},{"abre":"10:00","cierra":"20:00"},{"abre":"10:00","cierra":"20:00"}]'),
    ('intervalo_min', '60'),
    ('maps_url', 'https://maps.google.com'),
    ('max_faltas', '2');
