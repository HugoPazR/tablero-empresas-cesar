// Recalcula los indicadores del tablero a partir del registro mercantil (RUES, Confecámaras)
// publicado en datos.gov.co y escribe docs/data.json.
// Solo pide AGREGADOS (conteos) a la API: nunca descarga nombres ni documentos.
// Uso: node scripts/actualizar.mjs      (Node 18 o superior, sin dependencias)
import { writeFile, mkdir } from 'node:fs/promises';

const BASE = 'https://www.datos.gov.co/resource/c82u-588k.json';
const CAMARAS = ['VALLEDUPAR', 'AGUACHICA'];
const LIMITE = 500000;
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

// Secciones CIIU Rev. 4 A.C.: [nombre corto, división inicial, división final, título oficial].
const SECCIONES = [
  ['Agricultura, ganadería y pesca', 1, 3, 'Agricultura, ganadería, caza, silvicultura y pesca'],
  ['Minas y canteras', 5, 9, 'Explotación de minas y canteras'],
  ['Industrias manufactureras', 10, 33, 'Industrias manufactureras'],
  ['Electricidad y gas', 35, 35, 'Suministro de electricidad, gas, vapor y aire acondicionado'],
  ['Agua, residuos y saneamiento', 36, 39, 'Distribución de agua; evacuación y tratamiento de aguas residuales, gestión de desechos y actividades de saneamiento ambiental'],
  ['Construcción', 41, 43, 'Construcción'],
  ['Comercio; reparación de vehículos', 45, 47, 'Comercio al por mayor y al por menor; reparación de vehículos automotores y motocicletas'],
  ['Transporte y almacenamiento', 49, 53, 'Transporte y almacenamiento'],
  ['Alojamiento y servicios de comida', 55, 56, 'Alojamiento y servicios de comida'],
  ['Información y comunicaciones', 58, 63, 'Información y comunicaciones'],
  ['Finanzas y seguros', 64, 66, 'Actividades financieras y de seguros'],
  ['Actividades inmobiliarias', 68, 68, 'Actividades inmobiliarias'],
  ['Profesionales, científicas y técnicas', 69, 75, 'Actividades profesionales, científicas y técnicas'],
  ['Servicios administrativos y de apoyo', 77, 82, 'Actividades de servicios administrativos y de apoyo'],
  ['Administración pública y defensa', 84, 84, 'Administración pública y defensa; planes de seguridad social de afiliación obligatoria'],
  ['Educación', 85, 85, 'Educación'],
  ['Salud y asistencia social', 86, 88, 'Actividades de atención de la salud humana y de asistencia social'],
  ['Arte, entretenimiento y recreación', 90, 93, 'Actividades artísticas, de entretenimiento y recreación'],
  ['Otras actividades de servicios', 94, 96, 'Otras actividades de servicios'],
  ['Hogares empleadores', 97, 98, 'Actividades de los hogares individuales en calidad de empleadores; actividades no diferenciadas de los hogares individuales como productores de bienes y servicios para uso propio'],
  ['Organizaciones extraterritoriales', 99, 99, 'Actividades de organizaciones y entidades extraterritoriales'],
];
const sectorDe = (ciiu) => {
  if (!/^\d{4}$/.test(ciiu || '') || ciiu === '9999') return 'Sin clasificar';
  const d = Number(ciiu.slice(0, 2));
  const s = SECCIONES.find(([, a, b]) => d >= a && d <= b);
  return s ? s[0] : 'Sin clasificar';
};
// Títulos oficiales de la CIIU Rev. 4 A.C. (Resolución DIAN 139 de 2012).
const TECNOLOGIA = {
  '4741': 'Comercio al por menor de computadores, equipos periféricos, programas de informática y equipos de telecomunicaciones en establecimientos especializados',
  '6110': 'Actividades de telecomunicaciones alámbricas',
  '6120': 'Actividades de telecomunicaciones inalámbricas',
  '6130': 'Actividades de telecomunicación satelital',
  '6190': 'Otras actividades de telecomunicaciones',
  '6201': 'Actividades de desarrollo de sistemas informáticos (planificación, análisis, diseño, programación, pruebas)',
  '6202': 'Actividades de consultoría informática y actividades de administración de instalaciones informáticas',
  '6209': 'Otras actividades de tecnologías de información y actividades de servicios informáticos',
  '6311': 'Procesamiento de datos, alojamiento (hosting) y actividades relacionadas',
  '6312': 'Portales web',
  '8020': 'Actividades de servicios de sistemas de seguridad',
  '9511': 'Mantenimiento y reparación de computadores y de equipo periférico',
  '9512': 'Mantenimiento y reparación de equipos de comunicación',
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

const hoy = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const [{ m: corte }] = await soql({ $select: 'max(fecha_matricula) as m', $where: `${EN_CAMARAS} AND fecha_matricula <= '${hoy}'` });
if (!/^\d{8}$/.test(corte || '')) throw new Error(`Fecha de corte inesperada: ${corte}`);
const ANIO = Number(corte.slice(0, 4)), MMDD = corte.slice(4);
// Año de referencia para "al día": el plazo de renovación vence el 31 de marzo, así que
// de enero a marzo se sigue tomando como referencia el año anterior.
const REF = Number(MMDD.slice(0, 2)) >= 4 ? ANIO : ANIO - 1;
const estados = ACTIVAS.map((e) => `'${e}'`).join(',');
const ANIOS = Array.from({ length: 11 }, (_, i) => ANIO - 10 + i);
const COHORTES = Array.from({ length: 10 }, (_, i) => REF - 10 + i);
const MESES = [];
for (let a = ANIO - 2; a <= ANIO; a++) for (let m = 1; m <= 12; m++) { const ym = `${a}${String(m).padStart(2, '0')}`; if (ym <= corte.slice(0, 6)) MESES.push(ym); }
const TIPOS = ['Persona natural', 'SAS', 'Otras sociedades', ESAL];
const INICIO = `${REF - 10}0101`;

// Todas las consultas agrupan por cámara, actividad (CIIU) y organización jurídica.
const DIMS = 'camara_comercio,cod_ciiu_act_econ_pri,organizacion_juridica';
const q = (campo, alias, where) => soql({
  $select: `${DIMS}${campo ? `,${campo} as ${alias}` : ''},count(*) as n`,
  $where: `${EN_CAMARAS} AND ${where}`, $group: `${DIMS}${campo ? `,${alias}` : ''}` });
const activaSql = `estado_matricula in (${estados})`;
const alDiaSql = `${activaSql} AND ultimo_ano_renovado >= '${REF}'`;
const [activasQ, alDiaQ, nuevasQ, cancelQ, cohorteQ, nuevasPrevQ, cancelPrevQ] = await Promise.all([
  q('', '', activaSql),
  q('', '', alDiaSql),
  q('substring(fecha_matricula,1,6)', 'ym', `fecha_matricula between '${INICIO}' and '${corte}'`),
  q('substring(fecha_cancelacion,1,6)', 'ym', `fecha_cancelacion between '${INICIO}' and '${corte}'`),
  q('substring(fecha_matricula,1,4)', 'anio', `fecha_matricula between '${INICIO}' and '${REF - 1}1231' AND ${alDiaSql}`),
  q('', '', `fecha_matricula between '${ANIO - 1}0101' and '${ANIO - 1}${MMDD}'`),
  q('', '', `fecha_cancelacion between '${ANIO - 1}0101' and '${ANIO - 1}${MMDD}'`),
]);

const titulo = (c) => c.charAt(0) + c.slice(1).toLowerCase();
const ceros = (k) => new Array(k).fill(0);
const camaras = {};
for (const cam of CAMARAS) {
  const de = (filas) => filas.filter((f) => f.camara_comercio === cam);
  // Cubo sector x tipo: la página suma las celdas según los filtros elegidos.
  const cubo = new Map();
  const celda = (f) => {
    const k = `${sectorDe(f.cod_ciiu_act_econ_pri)}|${tipoDe(f.organizacion_juridica)}`;
    if (!cubo.has(k)) cubo.set(k, { activas: 0, al_dia: 0, nuevas_prev: 0, canceladas_prev: 0,
      nuevas_anio: ceros(ANIOS.length), canceladas_anio: ceros(ANIOS.length),
      nuevas_mes: ceros(MESES.length), canceladas_mes: ceros(MESES.length),
      cohorte: ceros(COHORTES.length), cohorte_al_dia: ceros(COHORTES.length) });
    return cubo.get(k);
  };
  for (const f of de(activasQ)) celda(f).activas += n(f);
  for (const f of de(alDiaQ)) celda(f).al_dia += n(f);
  for (const f of de(nuevasPrevQ)) celda(f).nuevas_prev += n(f);
  for (const f of de(cancelPrevQ)) celda(f).canceladas_prev += n(f);
  const porPeriodo = (filas, anual, mensual) => {
    for (const f of de(filas)) {
      const c = celda(f), a = ANIOS.indexOf(Number(f.ym.slice(0, 4))), m = MESES.indexOf(f.ym);
      if (a >= 0) c[anual][a] += n(f);
      if (m >= 0) c[mensual][m] += n(f);
    }
  };
  porPeriodo(nuevasQ, 'nuevas_anio', 'nuevas_mes');
  porPeriodo(cancelQ, 'canceladas_anio', 'canceladas_mes');
  for (const f of de(nuevasQ)) { const i = COHORTES.indexOf(Number(f.ym.slice(0, 4))); if (i >= 0) celda(f).cohorte[i] += n(f); }
  for (const f of de(cohorteQ)) { const i = COHORTES.indexOf(Number(f.anio)); if (i >= 0) celda(f).cohorte_al_dia[i] += n(f); }
  const celdas = [...cubo].map(([k, v]) => { const [sector, tipo] = k.split('|'); return { sector, tipo, ...v }; });

  const tecnologia = Object.entries(TECNOLOGIA).map(([ciiu, actividad]) => {
    const por_tipo = Object.fromEntries(TIPOS.map((t) => [t, { al_dia: 0, nuevas: 0 }]));
    for (const f of de(alDiaQ)) if (f.cod_ciiu_act_econ_pri === ciiu) por_tipo[tipoDe(f.organizacion_juridica)].al_dia += n(f);
    for (const f of de(nuevasQ)) if (f.cod_ciiu_act_econ_pri === ciiu && f.ym.startsWith(String(ANIO))) por_tipo[tipoDe(f.organizacion_juridica)].nuevas += n(f);
    return { ciiu, actividad, por_tipo };
  });

  // Control de calidad: si algo viene vacío, no se sobrescribe el archivo publicado.
  const emp = celdas.filter((c) => c.tipo !== ESAL);
  const alDiaN = emp.reduce((t, c) => t + c.al_dia, 0), nuevasN = emp.reduce((t, c) => t + c.nuevas_anio.at(-1), 0);
  if (!(alDiaN > 0 && nuevasN > 0 && new Set(emp.map((c) => c.sector)).size > 5)) throw new Error(`Datos sospechosos para ${cam}; no se actualiza.`);
  camaras[cam] = { nombre: titulo(cam), al_dia: alDiaN, nuevas: nuevasN, celdas, tecnologia };
}

const salida = {
  meta: {
    corte: `${corte.slice(0, 4)}-${corte.slice(4, 6)}-${corte.slice(6)}`, anio: ANIO, anio_referencia: REF,
    generado: new Date().toISOString(), anios: ANIOS, meses: MESES, cohortes: COHORTES, tipos: TIPOS, esal: ESAL,
    sectores: SECCIONES.map(([corto, , , oficial]) => ({ corto, oficial })),
    fuente: 'Confecámaras (RUES): Personas Naturales, Personas Jurídicas y Entidades Sin Ánimo de Lucro',
    fuente_url: 'https://www.datos.gov.co/d/c82u-588k', licencia: 'CC BY-SA 4.0',
  },
  camaras,
};
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await writeFile(new URL('../docs/data.json', import.meta.url), JSON.stringify(salida) + '\n');
console.log(`OK: corte ${salida.meta.corte}, referencia ${REF}.`, CAMARAS.map((c) => `${c}: ${camaras[c].al_dia} al día, ${camaras[c].nuevas} nuevas`).join(' | '));
