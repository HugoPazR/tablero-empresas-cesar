// Recalcula los indicadores del tablero a partir del registro mercantil (RUES, Confecámaras)
// publicado en datos.gov.co y escribe docs/data.json.
// Solo pide AGREGADOS (conteos) a la API: nunca descarga nombres ni documentos.
// Uso: node scripts/actualizar.mjs      (Node 18 o superior, sin dependencias)
import { writeFile, mkdir } from 'node:fs/promises';

const BASE = 'https://www.datos.gov.co/resource/c82u-588k.json';
const CAMARAS = ['VALLEDUPAR', 'AGUACHICA'];
const LIMITE = 50000;
const EN_CAMARAS = `camara_comercio in (${CAMARAS.map((c) => `'${c}'`).join(',')})`;
const ACTIVAS = ['ACTIVA', 'MATRÍCULA NUEVA, CONSTITUCIÓN POR TRASLADO'];

const SOCIEDADES = new Set(['SOCIEDADES POR ACCIONES SIMPLIFICADAS SAS', 'SOCIEDAD LIMITADA', 'SOCIEDAD ANONIMA',
  'EMPRESAS UNIPERSONALES', 'SOCIEDAD EN COMANDITA SIMPLE', 'SOCIEDAD EN COMANDITA POR ACCIONES', 'SOCIEDAD COLECTIVA',
  'EMPRESAS ASOCIATIVAS DE TRABAJO', 'SOCIEDADES AGRARIAS DE TRANSFORMACION', 'EMPRESAS INDUSTRIALES Y COMERCIALES DEL ESTADO',
  'SOCIEDADES DE ECONOMIA MIXTA', 'SOCIEDAD EXTRANJERA']);
const ESAL = 'Entidades sin ánimo de lucro y solidarias';
const tipoDe = (org) => org === 'PERSONA NATURAL' ? 'Persona natural'
  : org === 'SOCIEDADES POR ACCIONES SIMPLIFICADAS SAS' ? 'SAS'
  : SOCIEDADES.has(org) ? 'Otras sociedades' : ESAL;

// Secciones CIIU Rev. 4 A.C. por rango de división (nombres abreviados).
const SECCIONES = [['Agro, ganadería y pesca', 1, 3], ['Minas y canteras', 5, 9], ['Industria manufacturera', 10, 33],
  ['Electricidad y gas', 35, 35], ['Agua y saneamiento', 36, 39], ['Construcción', 41, 43],
  ['Comercio y reparación de vehículos', 45, 47], ['Transporte y almacenamiento', 49, 53], ['Alojamiento y comidas', 55, 56],
  ['Información y comunicaciones', 58, 63], ['Finanzas y seguros', 64, 66], ['Inmobiliarias', 68, 68],
  ['Profesionales, científicas y técnicas', 69, 75], ['Servicios administrativos y de apoyo', 77, 82],
  ['Administración pública', 84, 84], ['Educación', 85, 85], ['Salud y asistencia social', 86, 88],
  ['Arte, entretenimiento y recreación', 90, 93], ['Otros servicios', 94, 96], ['Hogares empleadores', 97, 98],
  ['Organizaciones extraterritoriales', 99, 99]];
const sectorDe = (ciiu) => {
  if (!/^\d{4}$/.test(ciiu || '') || ciiu === '9999') return 'Sin clasificar';
  const d = Number(ciiu.slice(0, 2));
  const s = SECCIONES.find(([, a, b]) => d >= a && d <= b);
  return s ? s[0] : 'Sin clasificar';
};
const TECNOLOGIA = {
  '4741': 'Venta de computadores y equipos de telecomunicaciones', '6201': 'Desarrollo de software',
  '6202': 'Consultoría e instalaciones informáticas', '6209': 'Otros servicios informáticos',
  '6311': 'Procesamiento de datos y hosting', '6312': 'Portales web', '6110': 'Telecomunicaciones alámbricas',
  '6120': 'Telecomunicaciones inalámbricas', '6130': 'Telecomunicaciones satelitales', '6190': 'Otras telecomunicaciones',
  '9511': 'Reparación de computadores', '9512': 'Reparación de equipos de comunicación',
  '8020': 'Sistemas de seguridad (alarmas, cámaras)',
};

async function soql(params) {
  const url = new URL(BASE);
  for (const [k, v] of Object.entries({ ...params, $limit: LIMITE })) url.searchParams.set(k, v);
  const headers = process.env.SOCRATA_APP_TOKEN ? { 'X-App-Token': process.env.SOCRATA_APP_TOKEN } : {};
  for (let intento = 1; ; intento++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const filas = await r.json();
      if (filas.length >= LIMITE) throw new Error('La consulta alcanzó el límite de filas; hay que paginarla.');
      return filas;
    } catch (e) {
      if (intento >= 3) throw e;
      await new Promise((ok) => setTimeout(ok, 5000 * intento));
    }
  }
}
const n = (f) => Number(f.n);
const suma = (filas, cond = () => true) => filas.reduce((t, f) => t + (cond(f) ? n(f) : 0), 0);
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const r2 = (x) => Math.round(x * 100) / 100;
const esEmpresa = (f) => tipoDe(f.organizacion_juridica) !== ESAL;

const hoy = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const [{ m: corte }] = await soql({ $select: 'max(fecha_matricula) as m', $where: `${EN_CAMARAS} AND fecha_matricula <= '${hoy}'` });
if (!/^\d{8}$/.test(corte || '')) throw new Error(`Fecha de corte inesperada: ${corte}`);
const ANIO = Number(corte.slice(0, 4)), MMDD = corte.slice(4);
// Año de referencia para "al día": el plazo de renovación vence el 31 de marzo, así que
// de enero a marzo se sigue tomando como referencia el año anterior.
const REF = Number(MMDD.slice(0, 2)) >= 4 ? ANIO : ANIO - 1;
const estados = ACTIVAS.map((e) => `'${e}'`).join(',');
const tramo = (campo) => `((${campo} between '${ANIO}0101' and '${corte}') OR (${campo} between '${ANIO - 1}0101' and '${ANIO - 1}${MMDD}'))`;

const [base, cancel, ytdNuevas, ytdCancel, ciiuAlDia, ciiuNuevas] = await Promise.all([
  soql({ $select: 'camara_comercio,substring(fecha_matricula,1,4) as anio,organizacion_juridica,estado_matricula,ultimo_ano_renovado,count(*) as n',
    $where: EN_CAMARAS, $group: 'camara_comercio,anio,organizacion_juridica,estado_matricula,ultimo_ano_renovado' }),
  soql({ $select: 'camara_comercio,substring(fecha_cancelacion,1,4) as anio,organizacion_juridica,count(*) as n',
    $where: `${EN_CAMARAS} AND fecha_cancelacion is not null`, $group: 'camara_comercio,anio,organizacion_juridica' }),
  soql({ $select: 'camara_comercio,substring(fecha_matricula,1,4) as anio,organizacion_juridica,count(*) as n',
    $where: `${EN_CAMARAS} AND ${tramo('fecha_matricula')}`, $group: 'camara_comercio,anio,organizacion_juridica' }),
  soql({ $select: 'camara_comercio,substring(fecha_cancelacion,1,4) as anio,organizacion_juridica,count(*) as n',
    $where: `${EN_CAMARAS} AND ${tramo('fecha_cancelacion')}`, $group: 'camara_comercio,anio,organizacion_juridica' }),
  soql({ $select: 'camara_comercio,cod_ciiu_act_econ_pri,organizacion_juridica,count(*) as n',
    $where: `${EN_CAMARAS} AND estado_matricula in (${estados}) AND ultimo_ano_renovado >= '${REF}'`,
    $group: 'camara_comercio,cod_ciiu_act_econ_pri,organizacion_juridica' }),
  soql({ $select: 'camara_comercio,cod_ciiu_act_econ_pri,organizacion_juridica,count(*) as n',
    $where: `${EN_CAMARAS} AND fecha_matricula between '${ANIO}0101' and '${corte}'`,
    $group: 'camara_comercio,cod_ciiu_act_econ_pri,organizacion_juridica' }),
]);

const activa = (f) => ACTIVAS.includes(f.estado_matricula);
const alDia = (f) => activa(f) && Number(f.ultimo_ano_renovado) >= REF;
const titulo = (c) => c.charAt(0) + c.slice(1).toLowerCase();

const camaras = {};
for (const cam of CAMARAS) {
  const de = (filas) => filas.filter((f) => f.camara_comercio === cam);
  const b = de(base), bEmp = b.filter(esEmpresa);
  const anioDe = (filas, a) => suma(filas.filter(esEmpresa), (f) => Number(f.anio) === a);
  const nuevas = anioDe(de(ytdNuevas), ANIO), nuevasPrev = anioDe(de(ytdNuevas), ANIO - 1);
  const cancs = anioDe(de(ytdCancel), ANIO), cancsPrev = anioDe(de(ytdCancel), ANIO - 1);
  const activas = suma(bEmp, activa), alDiaN = suma(bEmp, alDia);

  const resumen = {
    activas, al_dia: alDiaN, pct_al_dia: pct(alDiaN, activas),
    nuevas, nuevas_prev: nuevasPrev, var_nuevas_pct: pct(nuevas - nuevasPrev, nuevasPrev),
    canceladas: cancs, canceladas_prev: cancsPrev, var_canceladas_pct: pct(cancs - cancsPrev, cancsPrev),
    nuevas_por_cancelada: cancs ? r2(nuevas / cancs) : null,
    entidades_sin_animo_lucro_al_dia: suma(b, (f) => !esEmpresa(f) && alDia(f)),
  };

  const anual = [];
  for (let a = ANIO - 10; a <= ANIO; a++) {
    const nv = suma(bEmp, (f) => Number(f.anio) === a), cn = anioDe(de(cancel), a);
    anual.push({ anio: a, nuevas: nv, canceladas: cn, saldo: nv - cn, parcial: a === ANIO });
  }

  const acum = (filas, clave) => filas.reduce((m, f) => m.set(clave(f), (m.get(clave(f)) || 0) + n(f)), new Map());
  const sAl = acum(de(ciiuAlDia).filter(esEmpresa), (f) => sectorDe(f.cod_ciiu_act_econ_pri));
  const sNu = acum(de(ciiuNuevas).filter(esEmpresa), (f) => sectorDe(f.cod_ciiu_act_econ_pri));
  const totAl = [...sAl.values()].reduce((x, y) => x + y, 0), totNu = [...sNu.values()].reduce((x, y) => x + y, 0);
  const sectores = [...new Set([...sAl.keys(), ...sNu.keys()])]
    .map((s) => ({ sector: s, al_dia: sAl.get(s) || 0, pct_al_dia: pct(sAl.get(s) || 0, totAl), nuevas: sNu.get(s) || 0, pct_nuevas: pct(sNu.get(s) || 0, totNu) }))
    .sort((x, y) => y.al_dia - x.al_dia);

  const tAl = acum(b.filter(alDia), (f) => tipoDe(f.organizacion_juridica));
  const tNu = acum(b.filter((f) => Number(f.anio) === ANIO), (f) => tipoDe(f.organizacion_juridica));
  const tTotAl = [...tAl.values()].reduce((x, y) => x + y, 0), tTotNu = [...tNu.values()].reduce((x, y) => x + y, 0);
  const tipos = ['Persona natural', 'SAS', 'Otras sociedades', ESAL]
    .map((t) => ({ tipo: t, al_dia: tAl.get(t) || 0, pct_al_dia: pct(tAl.get(t) || 0, tTotAl), nuevas: tNu.get(t) || 0, pct_nuevas: pct(tNu.get(t) || 0, tTotNu) }))
    .sort((x, y) => y.al_dia - x.al_dia);

  const supervivencia = [];
  for (let a = REF - 10; a <= REF - 1; a++) {
    const coh = bEmp.filter((f) => Number(f.anio) === a);
    const grupo = (filas) => ({ matriculadas: suma(filas), al_dia: suma(filas, alDia), pct_al_dia: pct(suma(filas, alDia), suma(filas)) });
    supervivencia.push({ cohorte: a, todas: grupo(coh),
      naturales: grupo(coh.filter((f) => f.organizacion_juridica === 'PERSONA NATURAL')),
      sociedades: grupo(coh.filter((f) => f.organizacion_juridica !== 'PERSONA NATURAL')) });
  }

  const cAl = acum(de(ciiuAlDia).filter(esEmpresa), (f) => f.cod_ciiu_act_econ_pri);
  const cNu = acum(de(ciiuNuevas).filter(esEmpresa), (f) => f.cod_ciiu_act_econ_pri);
  const tecnologia = Object.entries(TECNOLOGIA)
    .map(([ciiu, actividad]) => ({ ciiu, actividad, al_dia: cAl.get(ciiu) || 0, nuevas: cNu.get(ciiu) || 0 }))
    .sort((x, y) => y.al_dia - x.al_dia);

  // Control de calidad: si algo viene vacío, no se sobrescribe el archivo publicado.
  if (!(activas > 0 && alDiaN > 0 && nuevas > 0 && sectores.length > 5)) throw new Error(`Datos sospechosos para ${cam}; no se actualiza.`);
  camaras[cam] = { nombre: titulo(cam), resumen, anual, sectores, tipos, supervivencia, tecnologia };
}

const salida = {
  meta: {
    corte: `${corte.slice(0, 4)}-${corte.slice(4, 6)}-${corte.slice(6)}`, anio: ANIO, anio_referencia: REF,
    generado: new Date().toISOString(),
    fuente: 'Confecámaras (RUES): Personas Naturales, Personas Jurídicas y Entidades Sin Ánimo de Lucro',
    fuente_url: 'https://www.datos.gov.co/d/c82u-588k', licencia: 'CC BY-SA 4.0',
  },
  camaras,
};
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await writeFile(new URL('../docs/data.json', import.meta.url), JSON.stringify(salida, null, 1) + '\n');
console.log(`OK: corte ${salida.meta.corte}, referencia ${REF}.`, CAMARAS.map((c) => `${c}: ${camaras[c].resumen.al_dia} al día, ${camaras[c].resumen.nuevas} nuevas`).join(' | '));
