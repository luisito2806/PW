# Doo Barber

Sistema de citas para barberías: el cliente reserva servicio, barbero, fecha y hora desde su celular, y el dueño administra su agenda, bloqueos, reportes y configuración desde un panel. Node.js, Express y SQLite, sin frameworks en el frontend.

## Uso

```bash
cd backend
npm install
ADMIN_PASSWORD="tu-clave" npm start          # Mac/Linux
$env:ADMIN_PASSWORD="tu-clave"; npm start    # Windows PowerShell
```

Abre http://localhost:3000 (clientes) y http://localhost:3000/login.html (panel). Más detalles en [CLAUDE.md](CLAUDE.md).

## Publicar en Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/luisito2806/PW)

El archivo `render.yaml` crea un servicio web gratuito desde la carpeta `backend`:

- `ADMIN_PASSWORD` se genera al azar al crear el servicio. Para verla o cambiarla: en Render abre el servicio → **Environment**.
- `TRUST_PROXY=1` hace que el límite de intentos de inicio de sesión use la IP real de cada visitante y no la del proxy de Render.
- `TZ=America/Mexico_City` para que las horas de las citas coincidan con la hora local.

En el plan gratuito el disco no es permanente: la base SQLite se reinicia cuando el servicio se vuelve a desplegar o se reinicia, así que sirve como demostración. El plan gratuito se duerme tras 15 minutos sin visitas: la primera visita después tarda alrededor de un minuto en cargar. Para usarlo con una barbería real hace falta un disco persistente (plan de pago) o una base de datos externa.
