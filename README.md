# ZOECONNET Signage

Aplicación de señalización digital: convierte cualquier pantalla con navegador (Smart TV, Android TV, Fire Stick, mini PC, tablet) en un cartel digital que se administra desde un panel web.

## Funciones

- **Biblioteca de contenido**: sube imágenes y videos (arrastrar y soltar), con título, descripción, etiquetas, duración y fechas de inicio y vencimiento (insignias *Programado* / *Vencido*). Ordenar, filtrar y buscar.
- **Sitios web**: muestra páginas web (menús, redes, clima, paneles) como un elemento más de la lista.
- **Pantallas**: se vinculan con un código de 6 caracteres. Estado en línea, última conexión, resolución, orientación horizontal o vertical y horario de funcionamiento por día (fuera del horario la pantalla queda en negro).
- **Lista de reproducción por pantalla**: añadir, reordenar arrastrando, duración por elemento, total, vista previa.
- **Visualización periódica** por elemento: mostrar solo entre dos fechas y repetir cada N días, semanas o meses (el día X del mes o el "primer lunes", "último viernes", etc.).
- **Transiciones**: fundido, deslizar, acercar, revelar desde una esquina, barrido o aleatoria, con velocidad y opción de aplicarlas a sitios web.
- **Grupos**: varias pantallas comparten una misma lista y transiciones.
- **Reproductor**: pantalla completa, sin cursor, mantiene la pantalla encendida, sigue reproduciendo si se cae la conexión y se actualiza solo cada 15 segundos.

## Cómo ejecutarlo

Requiere [Node.js](https://nodejs.org) 18 o superior. No tiene dependencias externas.

```bash
ADMIN_PASSWORD=una-clave-segura npm start
```

- Panel: `http://IP-DEL-SERVIDOR:3000` (usuario: cualquiera, contraseña: `ADMIN_PASSWORD`).
- En cada TV: abre `http://IP-DEL-SERVIDOR:3000/player`, anota el código y en el panel ve a **Pantallas → Añadir pantalla**.

Variables de entorno:

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `PORT` | `3000` | Puerto HTTP |
| `ADMIN_PASSWORD` | (vacía) | Protege el panel. Sin ella, cualquiera en la red puede entrar |
| `DATA_DIR` | `./data` | Dónde se guardan `db.json` y los archivos subidos |

Para usarlo desde fuera de tu red local, publícalo en un servidor o VPS detrás de HTTPS (por ejemplo con Caddy o Nginx).

## Estructura

- `server.js`: servidor HTTP, API y almacenamiento (archivo JSON + carpeta de medios).
- `public/index.html`, `public/app.js`, `public/style.css`: panel de control.
- `public/player.html`: reproductor.
- `public/schedule.js`: reglas de programación compartidas (vigencia, repetición, horario).
