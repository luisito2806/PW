// Tema compartido por el sitio de clientes, el login y el panel.
// Cada barbería elige su color_primario (marca blanca); de ese color se derivan
// las variables CSS que necesitan las tres pantallas:
//   --accent          fondo de botones y detalles
//   --on-accent       texto encima de --accent (carbón o blanco, el que se lea mejor)
//   --accent-text     el acento usado como texto sobre fondo crema
//   --accent-on-dark  el acento usado como texto sobre fondo carbón
// --accent-hover, --accent-dim y --accent-glow se calculan en el CSS con color-mix().

const COLOR_PRIMARIO_DEFAULT = '#B8893A';
const TEMA_FONDO_CLARO  = '#F7F4EE';
const TEMA_FONDO_OSCURO = '#17140F';

function hexARgb(hex) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

function rgbAHex(rgb) {
    return '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function luminancia(hex) {
    const [r, g, b] = hexARgb(hex).map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contraste(a, b) {
    const [x, y] = [luminancia(a), luminancia(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
}

// Mezcla el color con `hacia` poco a poco hasta que tenga buen contraste contra `fondo`
function ajustarContraste(hex, fondo, hacia, minimo = 4.5) {
    const origen = hexARgb(hex);
    const destino = hexARgb(hacia);
    for (let p = 0; p <= 1; p += 0.05) {
        const color = rgbAHex(origen.map((v, i) => v + (destino[i] - v) * p));
        if (contraste(color, fondo) >= minimo) return color;
    }
    return hacia;
}

// `recordar = false` sirve para vistas previas que todavía no se guardan
function aplicarColorPrimario(hex, recordar = true) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) hex = COLOR_PRIMARIO_DEFAULT;
    const raiz = document.documentElement.style;
    raiz.setProperty('--accent', hex);
    raiz.setProperty('--on-accent', contraste(hex, TEMA_FONDO_OSCURO) >= contraste(hex, '#ffffff') ? TEMA_FONDO_OSCURO : '#ffffff');
    raiz.setProperty('--accent-text', ajustarContraste(hex, TEMA_FONDO_CLARO, '#000000'));
    raiz.setProperty('--accent-on-dark', ajustarContraste(hex, TEMA_FONDO_OSCURO, '#ffffff'));
    // Se recuerda para pintar el color correcto desde el primer instante en la siguiente visita
    if (recordar) try { localStorage.setItem('colorPrimario', hex); } catch {}
}

// Logo del negocio: la imagen subida o, si no hay, un monograma con la inicial del nombre.
// Se arma con nodos del DOM (no innerHTML) para no tener que escapar el nombre.
function pintarMarca(contenedor, nombre, logoUrl) {
    if (!contenedor) return;
    contenedor.replaceChildren();
    if (logoUrl) {
        const img = document.createElement('img');
        img.src = logoUrl;
        img.alt = 'Logo';
        img.className = 'marca-logo';
        contenedor.appendChild(img);
    } else {
        const mono = document.createElement('span');
        mono.className = 'marca-monograma';
        mono.textContent = (String(nombre || '').trim()[0] || 'D').toUpperCase();
        contenedor.appendChild(mono);
    }
}

let colorGuardado = null;
try { colorGuardado = localStorage.getItem('colorPrimario'); } catch {}
aplicarColorPrimario(colorGuardado, false);
