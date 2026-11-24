// ─── AGENDA: HORARIO SEMANAL, DURACIONES Y DISPONIBILIDAD ────────────
import { dbGet, dbAll } from './db.js';

export const DIAS_MAX_RESERVA = 30;
export const INTERVALOS_VALIDOS = [15, 30, 60];
export const DURACION_MIN = 5;
export const DURACION_MAX = 480;

const pad2 = n => String(n).padStart(2, '0');

// "01:30 PM" → 810 (minutos desde medianoche); NaN si el formato no es válido
export function horaAMinutos(hora) {
    const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(hora || '');
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) > 59) return NaN;
    let h = Number(m[1]) % 12;
    if (m[3] === 'PM') h += 12;
    return h * 60 + Number(m[2]);
}

// 810 → "01:30 PM"
export function minutosAHora(min) {
    const h24 = Math.floor(min / 60);
    let h12 = h24 % 12;
    if (h12 === 0) h12 = 12;
    return `${pad2(h12)}:${pad2(min % 60)} ${h24 >= 12 ? 'PM' : 'AM'}`;
}

// "20:30" → 1230
export function hhmmAMinutos(valor) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(valor || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

// "50 min" → 50. Si no se puede leer, se asume 60 minutos
export function duracionAMinutos(texto) {
    const n = parseInt(String(texto || ''), 10);
    return Number.isFinite(n) && n >= DURACION_MIN && n <= DURACION_MAX ? n : 60;
}

// ─── FECHAS EN LA ZONA HORARIA DE LA BARBERÍA ────────────────────────
// Los Workers corren en UTC; "hoy" y "ahora" se calculan en la zona de la barbería
// (variable ZONA_HORARIA en wrangler.jsonc). Las fechas AAAA-MM-DD se manejan en UTC
// solo como calendario, sin hora.
export function ahoraLocal(zona) {
    const partes = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: zona,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).formatToParts(new Date()).map(p => [p.type, p.value])
    );
    return {
        fecha: `${partes.year}-${partes.month}-${partes.day}`,
        minutos: Number(partes.hour) * 60 + Number(partes.minute)
    };
}

export function sumarDias(fechaISO, dias) {
    const [y, m, d] = fechaISO.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}

function diaDeLaSemana(fechaISO) {
    const [y, m, d] = fechaISO.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// ─── HORARIO SEMANAL ─────────────────────────────────────────────────
// Arreglo de 7 días (0 = domingo). Cada día es null (cerrado) o { abre: 'HH:MM', cierra: 'HH:MM' }
export function horarioSemanalPorDefecto() {
    return Array.from({ length: 7 }, () => ({ abre: '10:00', cierra: '20:00' }));
}

export function horarioSemanalValido(horario) {
    return Array.isArray(horario) && horario.length === 7 && horario.every(dia =>
        dia === null || (
            typeof dia === 'object'
            && Number.isFinite(hhmmAMinutos(dia.abre))
            && Number.isFinite(hhmmAMinutos(dia.cierra))
            && hhmmAMinutos(dia.abre) < hhmmAMinutos(dia.cierra)
        )
    );
}

export function parsearHorarioSemanal(texto) {
    try {
        const horario = JSON.parse(texto);
        if (horarioSemanalValido(horario)) return horario;
    } catch {}
    return horarioSemanalPorDefecto();
}

// Minutos de inicio de cada turno: desde que abre, cada `intervalo`, mientras sea antes del cierre
function iniciosDeTurno(horarioDia, intervalo) {
    const inicios = [];
    for (let t = hhmmAMinutos(horarioDia.abre); t < hhmmAMinutos(horarioDia.cierra); t += intervalo) inicios.push(t);
    return inicios;
}

// Todas las horas posibles de la semana (para los selectores del panel)
export function horariosDeLaSemana(conf) {
    const todos = new Set();
    conf.horario.forEach(dia => { if (dia) iniciosDeTurno(dia, conf.intervalo).forEach(t => todos.add(t)); });
    return [...todos].sort((a, b) => a - b).map(minutosAHora);
}

const traslapa = (inicioA, finA, inicioB, finB) => inicioA < finB && inicioB < finA;

// Calcula qué turnos de una fecha están libres para un servicio de `duracion` minutos.
// Un turno está libre si el servicio termina antes del cierre, no choca con una hora
// bloqueada y al menos un barbero (o el elegido) no tiene otra cita en ese rango.
// La reserva final la vuelve a comprobar la base de datos (ver insertarCitaSinEmpalme).
export async function calcularDisponibilidad(db, { fecha, barberoId = 'cualquiera', duracion, conf, excluirCitaId = null, permitirPasado = false }) {
    const diaBloqueado = await dbGet(db, `SELECT motivo FROM dias_bloqueados WHERE fecha = ?`, [fecha]);
    if (diaBloqueado) return { cerrado: true, motivo: diaBloqueado.motivo, horarios: [] };

    const horarioDia = conf.horario[diaDeLaSemana(fecha)];
    if (!horarioDia) return { cerrado: true, motivo: 'Cerrado este día', horarios: [] };

    let barberos = await dbAll(db, `SELECT id, nombre FROM barberos WHERE activo = 1 ORDER BY id ASC`);
    if (barberoId && barberoId !== 'cualquiera') {
        barberos = barberos.filter(b => String(b.id) === String(barberoId));
        if (barberos.length === 0) return { error: 'El barbero seleccionado no está disponible.' };
    }

    const citas = (await dbAll(
        db,
        `SELECT id, barbero_id, inicio_min, fin_min FROM citas WHERE fecha = ? AND estado != 'cancelada'`,
        [fecha]
    )).filter(c => Number(c.id) !== Number(excluirCitaId));

    const bloqueadas = (await dbAll(db, `SELECT hora FROM horas_bloqueadas WHERE fecha = ?`, [fecha]))
        .map(r => horaAMinutos(r.hora))
        .filter(Number.isFinite);

    const ahora = ahoraLocal(conf.zona);
    const cierre = hhmmAMinutos(horarioDia.cierra);

    const horarios = iniciosDeTurno(horarioDia, conf.intervalo).map(inicio => {
        const fin = inicio + duracion;
        const yaPaso = fecha < ahora.fecha || (fecha === ahora.fecha && inicio <= ahora.minutos);
        let libres = [];

        if (fin <= cierre
            && (permitirPasado || !yaPaso)
            && !bloqueadas.some(b => traslapa(inicio, fin, b, b + conf.intervalo))) {
            libres = barberos.filter(b => !citas.some(c =>
                Number(c.barbero_id) === Number(b.id) && traslapa(inicio, fin, c.inicio_min, c.fin_min)
            ));
        }
        return { hora: minutosAHora(inicio), disponible: libres.length > 0, libres };
    });

    return { cerrado: false, horarios };
}

// Condición SQL "este barbero no tiene otra cita que se empalme con [inicio, fin)".
// Va dentro del mismo INSERT/UPDATE: D1 ejecuta cada instrucción de forma atómica, así
// que dos personas reservando al mismo tiempo no pueden quedarse con el mismo turno.
export const SIN_EMPALME = `NOT EXISTS (
    SELECT 1 FROM citas otra
    WHERE otra.fecha = ? AND otra.barbero_id = ? AND otra.estado != 'cancelada'
      AND otra.id != ? AND otra.inicio_min < ? AND otra.fin_min > ?
)`;
export const paramsSinEmpalme = ({ fecha, barberoId, excluirCitaId = 0, inicio, fin }) =>
    [fecha, barberoId, excluirCitaId, fin, inicio];
