# Tablero: empresas en Valledupar y el Cesar

Tablero público de indicadores empresariales con datos abiertos del registro mercantil
(RUES, Confecámaras) publicados en [datos.gov.co](https://www.datos.gov.co/d/c82u-588k).
Hecho por [DEVSYSTRA](https://devsystra.com).

## Cómo funciona

| Pieza | Archivo | Qué hace |
| --- | --- | --- |
| Página | `docs/index.html` | Sitio estático, sin dependencias. Lee `data.json` y dibuja cifras, gráficos y tablas. |
| Datos | `docs/data.json` | Indicadores ya calculados (solo conteos). |
| Actualización | `scripts/actualizar.mjs` | Pide agregados a la API de datos.gov.co y reescribe `data.json`. |
| Programación | `.github/workflows/actualizar.yml` | Ejecuta el script cada lunes y publica si hubo cambios. |

La página no consulta la API al abrirse: carga un archivo pequeño ya calculado. Así abre
rápido y no se cae si datos.gov.co está lento.

## Publicarlo

1. Crea un repositorio público en GitHub y sube esta carpeta.
2. En **Settings → Pages**, elige *Deploy from a branch*, rama `main`, carpeta `/docs`.
3. En **Settings → Actions → General**, confirma que los workflows tienen permiso de escritura.
4. En la pestaña **Actions**, ejecuta a mano "Actualizar datos del tablero" para probarlo.

### Dominio: tablero-indicador.devsystra.com

El archivo `docs/CNAME` ya contiene el subdominio. Falta el registro DNS:

1. En Hostinger, abre la zona DNS de `devsystra.com` y crea un registro:
   tipo `CNAME`, nombre `tablero-indicador`, destino `hugopazr.github.io`, TTL por defecto.
2. En GitHub, **Settings → Pages → Custom domain**, confirma `tablero-indicador.devsystra.com`.
3. Cuando GitHub termine de verificar el DNS, activa **Enforce HTTPS**.

## Ejecutarlo en tu equipo

```bash
node scripts/actualizar.mjs        # Node 18 o superior
npx serve docs                     # o: python -m http.server -d docs 8000
```

Opcional: define `SOCRATA_APP_TOKEN` (gratis en datos.gov.co) para tener más cupo de consultas.

## Decisiones de diseño

- **Privacidad:** el script solo pide conteos agregados. Nunca descarga nombres, documentos ni contactos.
- **"Empresa"** = persona natural o sociedad. Las entidades sin ánimo de lucro se cuentan aparte.
- **"Al día"** = matrícula activa renovada en el año de referencia. De enero a marzo la referencia es el año anterior, porque el plazo vence el 31 de marzo.
- **Control de calidad:** si la API devuelve datos vacíos o sospechosos, el script falla y no sobrescribe lo publicado. GitHub avisa por correo cuando un workflow falla.

## Límites

- Las cifras son por jurisdicción de cámara de comercio; el conjunto de datos no trae municipio.
- Las cancelaciones incluyen la depuración anual de matrículas con cinco años sin renovar (Ley 1727 de 2014).
- Los sectores usan nombres cortos; el título oficial de la CIIU Rev. 4 A.C. va en el detalle de cada barra.
- El registro mide formalidad: los negocios informales no aparecen.

## Licencia de los datos

Confecámaras, CC BY-SA 4.0. Si reutilizas las cifras, cita la fuente.
