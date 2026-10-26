// ─── CONFIGURACIÓN DEL NEGOCIO Y VALIDACIONES ────────────────────────
import { dbAll } from './db.js';
import { INTERVALOS_VALIDOS, horarioSemanalValido, parsearHorarioSemanal } from './agenda.js';

export const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}$/;
export const ESTADOS_VALIDOS = ['pendiente', 'completada', 'cancelada', 'no_asistio'];
const MAX_IMAGEN_CHARS = 300 * 1024; // ~300 KB en base64 (el frontend las comprime a 150x150)

export function textoValido(valor, max) {
    return typeof valor === 'string' && valor.trim().length > 0 && valor.trim().length <= max;
}

// Solo se aceptan imágenes como data URL (las que genera el compresor del panel) o vacío
export function imagenValida(valor) {
    if (valor === undefined || valor === null || valor === '') return true;
    return typeof valor === 'string'
        && valor.length <= MAX_IMAGEN_CHARS
        && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(valor);
}

// Acepta un link de Google Maps, un <iframe> copiado de Google Maps o una dirección
// escrita a mano, y devuelve siempre un link que abre Google Maps
export function normalizarUrlMaps(valor) {
    let v = typeof valor === 'string' ? valor.trim() : '';
    if (!v) return 'https://maps.google.com';
    const iframe = v.match(/src=["']([^"']+)["']/i);
    if (iframe) v = iframe[1];
    if (/^https?:\/\//i.test(v)) return v;
    if (/^(maps\.app\.goo\.gl|goo\.gl\/maps|www\.google\.|google\.com\/maps)/i.test(v)) return 'https://' + v;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(v)}`;
}

// Claves que el panel puede modificar y cómo se valida cada una
export const CONFIG_EDITABLE = {
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

export async function obtenerConfig(env) {
    const rows = await dbAll(env.DB, `SELECT * FROM configuracion`);
    const conf = {};
    rows.forEach(r => { conf[r.clave] = r.valor; });
    conf.horario = parsearHorarioSemanal(conf.horario_semanal);
    conf.intervalo = INTERVALOS_VALIDOS.includes(Number(conf.intervalo_min)) ? Number(conf.intervalo_min) : 60;
    conf.zona = env.ZONA_HORARIA || 'America/Mexico_City';
    return conf;
}
