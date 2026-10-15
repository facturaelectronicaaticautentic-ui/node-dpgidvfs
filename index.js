require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const empresas = [
  { id: 1, nombre: process.env.EMPRESA1_NOMBRE || "Empresa 1", user: process.env.EMPRESA1_USER, key: process.env.EMPRESA1_KEY },
  { id: 2, nombre: process.env.EMPRESA2_NOMBRE || "Empresa 2", user: process.env.EMPRESA2_USER, key: process.env.EMPRESA2_KEY }
];

const MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

const siigoClient = axios.create({
  baseURL: 'https://api.siigo.com',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json', 'Partner-Id': 'PortalAutenTIC' }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');

// ---------- Comercial asignado por tercero (se guarda en asignaciones.json) ----------
const fs = require('fs');
const path = require('path');
const ARCHIVO_ASIGNACIONES = path.join(process.env.DATA_DIR || __dirname, 'asignaciones.json');
// Comerciales disponibles para asignar a los terceros (se puede cambiar con la variable COMERCIALES del .env, separados por ;)
const COMERCIALES = (process.env.COMERCIALES
  ? process.env.COMERCIALES.split(';')
  : ['NUBIA XIMENA FONSECA PEÑA', 'PABLO ALBERTO JIMÉNEZ RAMÍREZ']
).map(n => n.trim().toUpperCase()).filter(Boolean);

// Formas de pago de Siigo que se consideran "ventas Wompi" (las que contabilizan en la cuenta 138095).
// Siigo no entrega la contrapartida contable en la API, así que se clasifica por la forma de pago de la factura.
// Cada elemento puede ser el NOMBRE (basta con que lo contenga) o el ID de la forma de pago.
// Se cambia con WOMPI_FORMAS_PAGO en el .env, separado por ;  (por defecto: cualquier forma de pago que contenga "WOMPI")
const WOMPI_FORMAS = (process.env.WOMPI_FORMAS_PAGO || 'WOMPI').split(';').map(s => s.trim().toUpperCase()).filter(Boolean);
function esPagoWompi(p) {
  const id = String(p.id == null ? '' : p.id).toUpperCase();
  const nombre = String(p.name || '').toUpperCase();
  return WOMPI_FORMAS.some(w => w === id || (nombre !== '' && nombre.includes(w)));
}

let asignaciones = {};
try { asignaciones = JSON.parse(fs.readFileSync(ARCHIVO_ASIGNACIONES, 'utf8')); } catch (e) { asignaciones = {}; }
function guardarAsignaciones() {
  try { fs.writeFileSync(ARCHIVO_ASIGNACIONES, JSON.stringify(asignaciones, null, 2)); }
  catch (e) { console.error('No se pudo guardar asignaciones.json:', e.message); }
}

// ---------- Almacenamiento permanente (Upstash Redis, gratis) ----------
// Si defines UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN en el .env, las asignaciones
// se guardan allí y sobreviven a reinicios y despliegues. Sin eso se usa solo el archivo local.
// También se aceptan los nombres que crea la integración de Upstash/KV de Vercel (KV_REST_API_URL / KV_REST_API_TOKEN)
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const ALMACEN_REMOTO = !!(UPSTASH_URL && UPSTASH_TOKEN);
const CLAVE_ASIGNACIONES = 'autentic:asignaciones';

async function redis(comando) {
  const r = await axios.post(UPSTASH_URL, comando, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    timeout: 10000
  });
  if (r.data && r.data.error) throw new Error(r.data.error);
  return r.data.result;
}

async function cargarAsignaciones() {
  if (!ALMACEN_REMOTO) return;
  try {
    const r = await redis(['HGETALL', CLAVE_ASIGNACIONES]);
    const remoto = {};
    if (Array.isArray(r)) {
      for (let i = 0; i < r.length; i += 2) remoto[r[i]] = r[i + 1];
    } else if (r && typeof r === 'object') {
      Object.assign(remoto, r);
    }
    // Lo que ya estaba en el archivo local y aún no está en la nube se sube una sola vez
    for (const [nit, com] of Object.entries(asignaciones)) {
      if (!remoto[nit]) {
        try { await redis(['HSET', CLAVE_ASIGNACIONES, nit, com]); remoto[nit] = com; } catch (e) { /* se reintenta en el próximo arranque */ }
      }
    }
    asignaciones = remoto;
    console.log(`Asignaciones cargadas desde Upstash: ${Object.keys(remoto).length}`);
  } catch (e) {
    console.error('No se pudieron leer las asignaciones de Upstash:', e.message);
  }
}
// ---------- Mes asignado manualmente a cada factura ----------
// Guarda { "empresaId:facturaId": "YYYY-MM" } en Upstash (y en meses.json como respaldo local)
const ARCHIVO_MESES = path.join(process.env.DATA_DIR || __dirname, 'meses.json');
const CLAVE_MESES = 'autentic:meses';
let mesesAsignados = {};
try { mesesAsignados = JSON.parse(fs.readFileSync(ARCHIVO_MESES, 'utf8')); } catch (e) { mesesAsignados = {}; }

async function cargarMeses() {
  if (!ALMACEN_REMOTO) return;
  try {
    const r = await redis(['HGETALL', CLAVE_MESES]);
    const remoto = {};
    if (Array.isArray(r)) {
      for (let i = 0; i < r.length; i += 2) remoto[r[i]] = r[i + 1];
    } else if (r && typeof r === 'object') {
      Object.assign(remoto, r);
    }
    for (const [k, v] of Object.entries(mesesAsignados)) {
      if (!remoto[k]) {
        try { await redis(['HSET', CLAVE_MESES, k, v]); remoto[k] = v; } catch (e) { /* se reintenta en el próximo arranque */ }
      }
    }
    mesesAsignados = remoto;
    console.log(`Meses de facturas cargados desde Upstash: ${Object.keys(remoto).length}`);
  } catch (e) {
    console.error('No se pudieron leer los meses de Upstash:', e.message);
  }
}

async function persistirMes(clave, valor) {
  if (ALMACEN_REMOTO) {
    await redis(valor ? ['HSET', CLAVE_MESES, clave, valor] : ['HDEL', CLAVE_MESES, clave]);
  }
  if (valor) mesesAsignados[clave] = valor;
  else delete mesesAsignados[clave];
  try { fs.writeFileSync(ARCHIVO_MESES, JSON.stringify(mesesAsignados, null, 2)); } catch (e) { /* hosting de solo lectura */ }
}

const asignacionesListas = Promise.all([cargarAsignaciones(), cargarMeses()]);

function hashAObjeto(r) {
  const o = {};
  if (Array.isArray(r)) { for (let i = 0; i < r.length; i += 2) o[r[i]] = r[i + 1]; }
  else if (r && typeof r === 'object') Object.assign(o, r);
  return o;
}

// En hostings tipo Vercel pueden existir varias copias del servidor, cada una con su propia memoria.
// Para que todas vean lo mismo, antes de usar las asignaciones se vuelven a leer de Upstash (máximo cada 3 segundos).
let ultimoSync = Date.now();
async function sincronizarRemoto(forzar) {
  if (!ALMACEN_REMOTO) return;
  if (!forzar && Date.now() - ultimoSync < 3000) return;
  try {
    const [a, m] = await Promise.all([redis(['HGETALL', CLAVE_ASIGNACIONES]), redis(['HGETALL', CLAVE_MESES])]);
    asignaciones = hashAObjeto(a);
    mesesAsignados = hashAObjeto(m);
    ultimoSync = Date.now();
  } catch (e) {
    console.error('No se pudo sincronizar con Upstash (se usa lo que hay en memoria):', e.message);
  }
}

async function persistirAsignacion(nit, comercial) {
  // Primero se guarda en Upstash: si falla, no se cambia nada en memoria y el usuario ve el error
  if (ALMACEN_REMOTO) {
    await redis(comercial ? ['HSET', CLAVE_ASIGNACIONES, nit, comercial] : ['HDEL', CLAVE_ASIGNACIONES, nit]);
  }
  if (comercial) asignaciones[nit] = comercial;
  else delete asignaciones[nit];
  guardarAsignaciones();
}

function describirError(e) {
  if (e.response) {
    const d = e.response.data;
    const msg = d && d.Errors && d.Errors[0] ? d.Errors[0].Message
      : (d && d.errors && d.errors[0] ? d.errors[0].message : '');
    return `HTTP ${e.response.status}${msg ? ' - ' + msg : ''}`;
  }
  return e.message;
}

// Base de datos temporal en memoria para Contratos
let contratosBD = [
  { id: 1, cliente: 'INTELCOST SAS', valor: 15000000, fechaInicio: '2026-01-01', fechaFin: '2026-12-31', estado: 'ACTIVO', responsable: 'MARIA GOMEZ' },
  { id: 2, cliente: 'VISION Y MARKETING SAS', valor: 8500000, fechaInicio: '2026-03-01', fechaFin: '2026-09-30', estado: 'FINALIZADO', responsable: 'CARLOS RUIZ' }
];

// ---------- Autenticación (token cacheado, Siigo lo mantiene vigente ~24h) ----------
const tokens = new Map();

async function getToken(empresa) {
  if (!empresa.user || !empresa.key) return null;
  const c = tokens.get(empresa.id);
  if (c && c.exp > Date.now()) return c.token;
  const res = await conReintento('auth:' + empresa.id, () => siigoClient.post('/auth', {
    username: empresa.user,
    access_key: empresa.key
  }));
  tokens.set(empresa.id, { token: res.data.access_token, exp: Date.now() + 23 * 60 * 60 * 1000 });
  return res.data.access_token;
}

// Siigo limita las llamadas por minuto: se espacian por cuenta y, si responde 429,
// se espera el tiempo que Siigo indica ("Try again in N seconds") antes de reintentar.
const siguienteTurno = new Map();
async function esperarTurno(clave) {
  const turno = Math.max(Date.now(), siguienteTurno.get(clave) || 0);
  siguienteTurno.set(clave, turno + 700);
  const espera = turno - Date.now();
  if (espera > 0) await sleep(espera);
}

function segundosDeEspera(e) {
  const h = e.response && e.response.headers && e.response.headers['retry-after'];
  if (h && !isNaN(Number(h))) return Number(h);
  const d = e.response && e.response.data;
  const txt = typeof d === 'string' ? d : JSON.stringify(d || '');
  const m = txt.match(/in (\d+) seconds/i);
  return m ? Number(m[1]) : 20;
}

async function conReintento(clave, fn, intentos = 4) {
  for (let i = 0; i < intentos; i++) {
    await esperarTurno(clave);
    try {
      return await fn();
    } catch (e) {
      const status = e.response && e.response.status;
      if (i < intentos - 1 && (status === 429 || status >= 500)) {
        const seg = status === 429 ? Math.min(segundosDeEspera(e) + 2, 70) : 2 * (i + 1);
        console.warn(`[Siigo] HTTP ${status}, reintentando en ${seg}s`);
        siguienteTurno.set(clave, Date.now() + seg * 1000);
        await sleep(seg * 1000);
        continue;
      }
      throw e;
    }
  }
}

async function siigoGet(url, params, token) {
  return conReintento(token, async () => {
    const r = await siigoClient.get(url, { params, headers: { Authorization: token } });
    return r.data;
  });
}

// ---------- Facturas: trae TODAS las páginas del rango pedido ----------
async function traerFacturas(token, desde, hasta) {
  const todas = [];
  let page = 1;
  let total = Infinity;
  while (todas.length < total) {
    const data = await siigoGet('/v1/invoices', { page, page_size: 100, date_start: desde, date_end: hasta }, token);
    const results = data.results || [];
    total = data.pagination && data.pagination.total_results != null ? data.pagination.total_results : results.length;
    todas.push(...results);
    if (results.length === 0) break;
    page++;
  }
  todas.esperadas = Number.isFinite(total) ? total : todas.length; // total que reporta Siigo, para detectar cargas incompletas
  return todas;
}

// ---------- Nombre del cliente ----------
// El listado de facturas de Siigo solo trae id + identificación (NIT) del cliente,
// así que se consulta /v1/customers/{id} y se guarda en caché.
const clientesCache = new Map();

function nombreDeCliente(c) {
  if (!c) return '';
  if (Array.isArray(c.name)) {
    const n = c.name.filter(Boolean).join(' ').trim();
    if (n) return n;
  } else if (typeof c.name === 'string' && c.name.trim()) {
    return c.name.trim();
  }
  if (c.commercial_name && c.commercial_name.trim()) return c.commercial_name.trim();
  if (c.person && (c.person.first_name || c.person.last_name)) {
    return `${c.person.first_name || ''} ${c.person.last_name || ''}`.trim();
  }
  if (c.company && c.company.name) return c.company.name.trim();
  return '';
}

// Lista completa de clientes por empresa (pocas llamadas, de 100 en 100), cacheada 30 min.
// Sirve tanto para los nombres en facturas como para la pestaña Terceros.
const clientesRaw = new Map();      // emp.id -> { ts, lista }
const clientesEnCurso = new Map();  // emp.id -> Promise (evita cargas duplicadas)
const facturasCache = new Map();    // "empresa|desde|hasta" -> { ts, data }

async function obtenerClientesRaw(emp, token, forzar = false) {
  const c = clientesRaw.get(emp.id);
  if (!forzar && c && Date.now() - c.ts < 30 * 60 * 1000) return c.lista;
  if (clientesEnCurso.has(emp.id)) return clientesEnCurso.get(emp.id);
  const p = (async () => {
    const lista = [];
    let page = 1;
    let total = Infinity;
    while (lista.length < total) {
      const data = await siigoGet('/v1/customers', { page, page_size: 100 }, token);
      const results = data.results || [];
      total = data.pagination && data.pagination.total_results != null ? data.pagination.total_results : results.length;
      lista.push(...results);
      if (results.length === 0) break;
      page++;
    }
    lista.forEach(c => {
      const n = nombreDeCliente(c);
      if (n && c.id) clientesCache.set(`${emp.id}:${c.id}`, n);
    });
    clientesRaw.set(emp.id, { ts: Date.now(), lista });
    return lista;
  })();
  clientesEnCurso.set(emp.id, p);
  try { return await p; } finally { clientesEnCurso.delete(emp.id); }
}

// Devuelve un texto de aviso si no se pudieron cargar los nombres (no rompe las facturas)
async function resolverClientes(emp, token, facturas) {
  const faltan = facturas.some(f => f.customer && f.customer.id && !clientesCache.has(`${emp.id}:${f.customer.id}`));
  if (!faltan) return '';
  try {
    await obtenerClientesRaw(emp, token);
    return '';
  } catch (e) {
    const msg = describirError(e);
    console.error(`[${emp.nombre}] No se pudieron cargar los clientes:`, msg);
    return `No se pudieron cargar los nombres de clientes (${msg}); se muestra el NIT. Recarga en un minuto.`;
  }
}

// Toma de las observaciones el periodo de consumo.
// Ej: "Consumo mes de abril y mayo 2026. Contrato 12" -> "ABRIL Y MAYO 2026"
function extraerConsumo(obs) {
  if (!obs) return '-';
  const texto = String(obs).replace(/\s+/g, ' ').trim();
  const m = texto.match(/consumos?\b\s*(?:del?\s+)?(?:los\s+)?(?:mes(?:es)?\b\s*)?(?:de(?:l)?\s+)?([^.;|]*)/i);
  if (!m) return '-';
  const periodo = m[1].trim().replace(/[,\s]+$/, '');
  return periodo ? periodo.slice(0, 80).toUpperCase() : '-';
}

function valorBruto(f) {
  if (Array.isArray(f.items) && f.items.length > 0) {
    return f.items.reduce((acc, it) => acc + (Number(it.price) || 0) * (Number(it.quantity) || 0) - (Number(it.discount) || 0), 0);
  }
  return Number(f.subtotal || f.total || 0);
}

function rangoFechas(ano, mes) {
  if (mes) {
    const ultimo = new Date(ano, mes, 0).getDate();
    return { desde: `${ano}-${pad(mes)}-01`, hasta: `${ano}-${pad(mes)}-${pad(ultimo)}` };
  }
  return { desde: `${ano}-01-01`, hasta: `${ano}-12-31` };
}

// El mes asignado manualmente manda sobre la fecha de la factura:
//  - se quitan del periodo las facturas que el usuario movió a otro mes
//  - se agregan las que el usuario movió a este periodo aunque estén facturadas en otro mes
// Suma (o resta) días a una fecha "YYYY-MM-DD"
function sumarDias(fechaISO, n) {
  const d = new Date(fechaISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const facturaPorIdCache = new Map(); // "empresa:facturaId" -> { ts, data }
const MAX_FACTURAS_MOVIDAS = 40;

async function ajustarPorMesAsignado(emp, token, facturas, desde, hasta, refrescar) {
  const desdeYM = desde.slice(0, 7);
  const hastaYM = hasta.slice(0, 7);
  const enRango = (ym) => ym >= desdeYM && ym <= hastaYM;
  const prefijo = `${emp.id}:`;

  const resultado = facturas.filter(f => {
    const ov = mesesAsignados[prefijo + f.id];
    return enRango(typeof ov === 'string' && ov ? ov : String(f.date).slice(0, 7));
  });

  const presentes = new Set(facturas.map(f => String(f.id)));
  const pendientes = Object.entries(mesesAsignados)
    .filter(([clave, ym]) => clave.startsWith(prefijo) && enRango(ym) && !presentes.has(clave.slice(prefijo.length)))
    .map(([clave]) => clave.slice(prefijo.length));

  const notas = [];
  if (pendientes.length > MAX_FACTURAS_MOVIDAS) {
    notas.push(`Hay ${pendientes.length} facturas movidas a este mes; solo se cargaron ${MAX_FACTURAS_MOVIDAS}.`);
  }
  let fallidas = 0;
  for (const id of pendientes.slice(0, MAX_FACTURAS_MOVIDAS)) {
    const ck = prefijo + id;
    let c = facturaPorIdCache.get(ck);
    if (refrescar || !c || Date.now() - c.ts > 10 * 60 * 1000) {
      try {
        c = { ts: Date.now(), data: await siigoGet(`/v1/invoices/${encodeURIComponent(id)}`, {}, token) };
        facturaPorIdCache.set(ck, c);
      } catch (e) {
        fallidas++;
        continue;
      }
    }
    if (c.data && c.data.id) resultado.push(c.data);
  }
  if (fallidas) notas.push(`No se pudieron cargar ${fallidas} facturas movidas a este mes desde otro mes.`);
  return { facturas: resultado, nota: notas.join(' ') };
}

async function facturasDeEmpresa(emp, desde, hasta, refrescar) {
  const token = await getToken(emp);
  if (!token) return [];
  const claveCache = `${emp.id}|${desde}|${hasta}`;
  let facturas;
  const previo = facturasCache.get(claveCache);
  if (!refrescar && previo && Date.now() - previo.ts < 2 * 60 * 1000) {
    facturas = previo.data;
  } else {
    // Se pide un día antes y un día después: el filtro de fechas de Siigo puede dejar por fuera el último día
    // (o el primero). Luego ajustarPorMesAsignado descarta lo que no pertenece al periodo pedido.
    facturas = await traerFacturas(token, sumarDias(desde, -1), sumarDias(hasta, 1));
    facturasCache.set(claveCache, { ts: Date.now(), data: facturas });
  }
  const incompleta = (facturas.esperadas != null && facturas.length < facturas.esperadas)
    ? `Siigo reportó ${facturas.esperadas} facturas pero solo se recibieron ${facturas.length}; vuelve a consultar.`
    : '';
  const ajuste = await ajustarPorMesAsignado(emp, token, facturas, desde, hasta, refrescar);
  facturas = ajuste.facturas;
  const nota = [await resolverClientes(emp, token, facturas), ajuste.nota, incompleta].filter(Boolean).join(' ');

  const lista = facturas.map(f => {
    const c = f.customer || {};
    // Se lee año/mes directo del texto "YYYY-MM-DD" para evitar el desfase de zona horaria
    const [y, m] = String(f.date).split('-');
    const numMes = Number(m) - 1;
    // Si el usuario cambió el mes de esta factura, se usa ese mes (formato "YYYY-MM")
    const ov = mesesAsignados[`${emp.id}:${f.id}`];
    const ovValido = typeof ov === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(ov);
    const anoEf = ovValido ? ov.slice(0, 4) : y;
    const mesIdx = ovValido ? Number(ov.slice(5, 7)) - 1 : numMes;
    const nit = c.identification || '';
    const nombre = clientesCache.get(`${emp.id}:${c.id}`) || nombreDeCliente(c) || (nit ? `CLIENTE (${nit})` : 'N/A');
    const saldo = Number(f.balance) || 0;
    const seller = f.seller;

    return {
      id: f.id,
      cliente: nombre.toUpperCase(),
      nit,
      empresaId: emp.id,
      mes: MESES[mesIdx] || '',
      numMes: mesIdx,
      numMesFactura: numMes,
      mesAsignado: ovValido ? ov : '',
      anoMes: anoEf,
      ano: y,
      numero: f.name || f.id,
      consecutivo: Number(f.number) || Number((String(f.name || '').match(/(\d+)\s*$/) || [])[1]) || 0,
      fecha: f.date,
      vencimiento: f.payments && f.payments[0] ? f.payments[0].due_date || '-' : '-',
      condicion: saldo > 0 ? 'PENDIENTE' : 'PAGADO',
      fechaPago: saldo === 0 ? f.date : '-',
      responsable: asignaciones[String(nit).trim()] || (seller ? (seller.name || `${seller.first_name || ''} ${seller.last_name || ''}`.trim() || String(seller)) : 'N/A'),
      formaPago: (f.payments || []).map(p => p.name || p.id).join(', ') || '-',
      esWompi: (f.payments || []).some(esPagoWompi),
      consumo: extraerConsumo(f.observations),
      observaciones: f.observations || '',
      valor: valorBruto(f),
      total: Number(f.total) || 0,
      saldo,
      empresa: emp.nombre
    };
  });
  lista.nota = nota;
  return lista;
}

// GET /api/facturas?ano=2026&mes=10   (mes opcional: 1-12; sin mes trae todo el año)
// GET /api/facturas?ano=2026&mes=10             -> todas las ventas del periodo
// GET /api/facturas?...&refrescar=1&solo=wompi  -> vuelve a leer Siigo (sin caché) y devuelve solo las ventas Wompi
app.get('/api/facturas', async (req, res) => {
  await asignacionesListas;
  await sincronizarRemoto();
  const refrescar = !!req.query.refrescar;
  const soloWompi = req.query.solo === 'wompi';
  const ano = parseInt(req.query.ano, 10) || new Date().getFullYear();
  const mes = parseInt(req.query.mes, 10) || null;
  const { desde, hasta } = rangoFechas(ano, mes);

  const conCredenciales = empresas.filter(e => e.user && e.key);

  // Solo se usan datos demo si no hay credenciales configuradas
  if (conCredenciales.length === 0) {
    return res.json({ resumen: [], facturas: [
      { cliente: 'YOBANY ALBERTO LOPEZ QUINTERO', nit: '', mes: 'ENERO', numMes: 0, ano: '2026', numero: '14201', fecha: '2026-01-15', vencimiento: '-', condicion: 'PAGADO', fechaPago: '2026-01-20', responsable: 'JUAN PEREZ', valor: 10921780, total: 10921780, saldo: 0, empresa: 'Empresa 1' },
      { cliente: 'INTELCOST SAS', nit: '', mes: 'OCTUBRE', numMes: 9, ano: '2026', numero: '14531', fecha: '2026-10-01', vencimiento: '-', condicion: 'PENDIENTE', fechaPago: '-', responsable: 'MARIA GOMEZ', valor: 3450000, total: 3450000, saldo: 3450000, empresa: 'Empresa 1' }
    ] });
  }

  const resultados = await Promise.all(empresas.map(async (emp) => {
    if (!emp.user || !emp.key) {
      return { empresa: emp.nombre, facturas: [], error: `Faltan credenciales (EMPRESA${emp.id}_USER / EMPRESA${emp.id}_KEY) en el .env` };
    }
    try {
      const facturas = await facturasDeEmpresa(emp, desde, hasta, refrescar);
      return { empresa: emp.nombre, facturas, error: null, nota: facturas.nota || '' };
    } catch (e) {
      const error = describirError(e);
      console.error(`[${emp.nombre}] Error consultando Siigo:`, error);
      return { empresa: emp.nombre, facturas: [], error };
    }
  }));

  // Orden: consecutivo de factura de mayor a menor
  const facturas = resultados.flatMap(r => r.facturas)
    .filter(f => !soloWompi || f.esWompi)
    .sort((a, b) => (b.consecutivo - a.consecutivo) || String(b.fecha).localeCompare(String(a.fecha)));
  res.json({
    facturas,
    resumen: resultados.map(r => {
      const lista = r.facturas.filter(f => !soloWompi || f.esWompi);
      const nums = lista.map(f => f.consecutivo).filter(Boolean);
      return {
        empresa: r.empresa,
        cantidad: lista.length,
        rango: nums.length ? `${Math.min(...nums)}–${Math.max(...nums)}` : '',
        error: r.error,
        nota: r.nota || ''
      };
    })
  });
});

// ---------- Terceros (clientes) de ambas empresas + comercial asignado ----------
let tercerosCache = { ts: 0, base: [], resumen: [] };

function mapearTercero(emp, c) {
  const nit = String(c.identification || '').trim();
  const contacto = (c.contacts && c.contacts[0]) || {};
  const telefono = (c.phones && c.phones[0] && c.phones[0].number) || (contacto.phone && contacto.phone.number) || '';
  const ciudad = c.address && c.address.city ? (c.address.city.city_name || '') : '';
  const tipo = c.person_type === 'Company' ? 'EMPRESA' : c.person_type === 'Person' ? 'PERSONA' : (c.person_type || '');
  return {
    nit,
    nombre: (nombreDeCliente(c) || (nit ? `TERCERO (${nit})` : 'N/A')).toUpperCase(),
    tipo,
    ciudad,
    email: contacto.email || '',
    telefono: String(telefono),
    empresa: emp.nombre
  };
}

async function traerTerceros(emp, forzar) {
  const token = await getToken(emp);
  if (!token) return [];
  const lista = await obtenerClientesRaw(emp, token, forzar);
  return lista.map(c => mapearTercero(emp, c));
}

function aplicarAsignaciones(base) {
  return base.map(t => ({ ...t, comercial: asignaciones[t.nit] || '' }));
}

// GET /api/terceros            (usa caché de 10 min)
// GET /api/terceros?refrescar=1 (vuelve a leer Siigo)
app.get('/api/terceros', async (req, res) => {
  await asignacionesListas;
  await sincronizarRemoto();
  const almacenamiento = ALMACEN_REMOTO ? 'remoto' : 'archivo';
  const vigente = Date.now() - tercerosCache.ts < 10 * 60 * 1000;
  if (!req.query.refrescar && vigente) {
    return res.json({ terceros: aplicarAsignaciones(tercerosCache.base), resumen: tercerosCache.resumen, almacenamiento });
  }

  const resultados = await Promise.all(empresas.map(async (emp) => {
    if (!emp.user || !emp.key) {
      return { empresa: emp.nombre, terceros: [], error: `Faltan credenciales (EMPRESA${emp.id}_USER / EMPRESA${emp.id}_KEY) en el .env` };
    }
    try {
      return { empresa: emp.nombre, terceros: await traerTerceros(emp, !!req.query.refrescar), error: null };
    } catch (e) {
      const error = describirError(e);
      console.error(`[${emp.nombre}] Error leyendo terceros:`, error);
      return { empresa: emp.nombre, terceros: [], error };
    }
  }));

  // Un mismo NIT puede existir en las dos empresas: se une en una sola fila
  const mapa = new Map();
  resultados.forEach(r => r.terceros.forEach(t => {
    if (!t.nit) return;
    const previo = mapa.get(t.nit);
    if (previo) {
      if (!previo.empresas.includes(t.empresa)) previo.empresas.push(t.empresa);
      ['email', 'telefono', 'ciudad', 'tipo'].forEach(k => { if (!previo[k]) previo[k] = t[k]; });
    } else {
      const { empresa, ...resto } = t;
      mapa.set(t.nit, { ...resto, empresas: [empresa] });
    }
  }));

  const base = [...mapa.values()].sort((a, b) => a.nombre.localeCompare(b.nombre));
  const resumen = resultados.map(r => ({ empresa: r.empresa, cantidad: r.terceros.length, error: r.error }));

  // Solo se cachea si ambas empresas respondieron bien
  tercerosCache = { ts: resumen.some(r => r.error) ? 0 : Date.now(), base, resumen };
  res.json({ terceros: aplicarAsignaciones(base), resumen, almacenamiento });
});

app.get('/api/comerciales', (req, res) => res.json(COMERCIALES));

// GET /api/estado -> diagnóstico del almacenamiento de asignaciones (no muestra claves ni datos)
app.get('/api/estado', async (req, res) => {
  await asignacionesListas;
  await sincronizarRemoto(true);
  const info = {
    almacenamientoPermanente: ALMACEN_REMOTO,
    variablesUsadas: ALMACEN_REMOTO
      ? (process.env.UPSTASH_REDIS_REST_URL ? 'UPSTASH_REDIS_REST_URL / _TOKEN' : 'KV_REST_API_URL / _TOKEN')
      : 'ninguna: se usa memoria/archivo local y se pierde al reiniciar o redesplegar',
    asignacionesEnMemoria: Object.keys(asignaciones).length,
    mesesEnMemoria: Object.keys(mesesAsignados).length
  };
  if (ALMACEN_REMOTO) {
    try {
      await redis(['SET', 'autentic:ping', String(Date.now()), 'EX', '60']);
      info.conexion = 'OK';
      info.asignacionesEnUpstash = await redis(['HLEN', CLAVE_ASIGNACIONES]);
      info.mesesEnUpstash = await redis(['HLEN', CLAVE_MESES]);
    } catch (e) {
      info.conexion = 'ERROR: ' + e.message;
    }
  }
  res.type('json').send(JSON.stringify(info, null, 2));
});

// PUT /api/terceros/:nit/comercial   body: { comercial: "NOMBRE" }  (vacío = quitar asignación)
app.put('/api/terceros/:nit/comercial', async (req, res) => {
  await asignacionesListas;
  await sincronizarRemoto();
  const nit = String(req.params.nit || '').trim();
  const comercial = String((req.body && req.body.comercial) || '').trim().toUpperCase();
  if (!nit) return res.status(400).json({ success: false, error: 'NIT requerido' });
  if (comercial && !COMERCIALES.includes(comercial)) {
    return res.status(400).json({ success: false, error: 'Comercial no válido' });
  }
  try {
    await persistirAsignacion(nit, comercial);
    res.json({ success: true });
  } catch (e) {
    console.error('No se pudo guardar la asignación:', e.message);
    res.status(500).json({ success: false, error: 'No se pudo guardar la asignación' });
  }
});

// GET /api/diagnostico-facturas?ano=2026&mes=9 -> qué entrega Siigo exactamente para ese periodo (sin caché).
// Sirve para ver cuántas facturas hay por día, el consecutivo mínimo y máximo, y por forma de pago.
app.get('/api/diagnostico-facturas', async (req, res) => {
  const ano = parseInt(req.query.ano, 10) || new Date().getFullYear();
  const mes = parseInt(req.query.mes, 10) || null;
  const { desde, hasta } = rangoFechas(ano, mes);
  const salida = { periodo: { desde, hasta }, consultaASiigo: { desde: sumarDias(desde, -1), hasta: sumarDias(hasta, 1) }, empresas: [] };
  await Promise.all(empresas.map(async (emp) => {
    if (!emp.user || !emp.key) { salida.empresas.push({ empresa: emp.nombre, error: 'Faltan credenciales' }); return; }
    try {
      const token = await getToken(emp);
      const raw = await traerFacturas(token, salida.consultaASiigo.desde, salida.consultaASiigo.hasta);
      const porDia = {};
      const porPago = {};
      raw.forEach(f => {
        porDia[f.date] = (porDia[f.date] || 0) + 1;
        const fp = (f.payments || []).map(p => p.name || p.id).join(', ') || '-';
        porPago[fp] = (porPago[fp] || 0) + 1;
      });
      const nums = raw.map(f => Number(f.number) || Number((String(f.name || '').match(/(\d+)\s*$/) || [])[1]) || 0).filter(Boolean);
      salida.empresas.push({
        empresa: emp.nombre,
        siigoReportaTotal: raw.esperadas,
        recibidas: raw.length,
        consecutivoMin: nums.length ? Math.min(...nums) : null,
        consecutivoMax: nums.length ? Math.max(...nums) : null,
        facturasPorDia: Object.fromEntries(Object.entries(porDia).sort()),
        facturasPorFormaDePago: porPago
      });
    } catch (e) {
      salida.empresas.push({ empresa: emp.nombre, error: describirError(e) });
    }
  }));
  res.type('json').send(JSON.stringify(salida, null, 2));
});

// Muestra las formas de pago de venta de cada empresa en Siigo y cuáles se están tomando como Wompi
app.get('/api/formas-pago', async (req, res) => {
  const salida = [];
  await Promise.all(empresas.map(async (emp) => {
    if (!emp.user || !emp.key) { salida.push({ empresa: emp.nombre, error: 'Faltan credenciales' }); return; }
    try {
      const token = await getToken(emp);
      const data = await siigoGet('/v1/payment-types', { document_type: 'FV' }, token);
      const lista = Array.isArray(data) ? data : (data.results || []);
      lista.forEach(p => salida.push({ empresa: emp.nombre, id: p.id, nombre: p.name, activa: p.active, tomadaComoWompi: esPagoWompi(p) }));
    } catch (e) {
      salida.push({ empresa: emp.nombre, error: describirError(e) });
    }
  }));
  res.type('json').send(JSON.stringify(salida, null, 2));
});

// PUT /api/facturas/:empresaId/:facturaId/mes   body: { mes: "2026-09" }   (vacío = volver al mes de la factura)
app.put('/api/facturas/:empresaId/:facturaId/mes', async (req, res) => {
  await asignacionesListas;
  await sincronizarRemoto();
  const emp = empresas.find(e => String(e.id) === String(req.params.empresaId));
  const facturaId = String(req.params.facturaId || '').trim();
  const mes = String((req.body && req.body.mes) || '').trim();
  if (!emp || !facturaId) return res.status(400).json({ success: false, error: 'Empresa o factura no válida' });
  if (mes && !/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return res.status(400).json({ success: false, error: 'Mes no válido' });
  try {
    await persistirMes(`${emp.id}:${facturaId}`, mes);
    res.json({ success: true });
  } catch (e) {
    console.error('No se pudo guardar el mes de la factura:', e.message);
    res.status(500).json({ success: false, error: 'No se pudo guardar el mes' });
  }
});

// Endpoints para Contratos
app.get('/api/contratos', (req, res) => res.json(contratosBD));
app.post('/api/contratos', (req, res) => {
  const nuevo = { id: Date.now(), ...req.body };
  contratosBD.push(nuevo);
  res.json({ success: true, contrato: nuevo });
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>AutenTIC - Control Facturación Clientes</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f6f9; margin: 0; padding: 20px; color: #333; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; background: white; padding: 15px 25px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .logo { font-size: 26px; font-weight: bold; color: #002d5b; display: flex; align-items: center; gap: 8px; }
        .kpi-box { text-align: right; }
        .kpi-title { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
        .kpi-value { font-size: 22px; font-weight: bold; color: #002d5b; }

        .filters-container { display: flex; gap: 10px; background: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); flex-wrap: wrap; }
        .filters-container select { flex: 1; min-width: 130px; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; color: #334155; background: #fff; }
        .filters-container select.server { border-color: #002d5b; font-weight: 600; }

        .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
        .tab-btn { padding: 10px 24px; border: none; background: #e2e8f0; cursor: pointer; border-radius: 6px; font-weight: bold; color: #475569; transition: all 0.2s; }
        .tab-btn.active { background: #002d5b; color: white; }

        .table-container { background: #fff; border-radius: 8px; overflow-x: auto; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        table { width: 100%; border-collapse: collapse; text-align: left; }
        th { background: #1f2937; color: white; padding: 12px 16px; font-size: 12px; font-weight: 600; text-transform: uppercase; white-space: nowrap; }
        td { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; font-size: 13px; white-space: nowrap; }
        tr:hover { background-color: #f8fafc; }

        .badge-pendiente { background: #fef3c7; color: #d97706; padding: 4px 10px; border-radius: 4px; font-weight: bold; font-size: 11px; }
        .badge-pagado { background: #dcfce7; color: #15803d; padding: 4px 10px; border-radius: 4px; font-weight: bold; font-size: 11px; }
        .badge-activo { background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 4px; font-weight: bold; font-size: 11px; }

        .form-container { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .form-container input, .form-container select { padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; }
        .btn-submit { background: #002d5b; color: white; border: none; padding: 10px; border-radius: 6px; font-weight: bold; cursor: pointer; grid-column: 1 / -1; }
              .aviso { background: #ecfdf5; color: #065f46; padding: 10px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 12px; }
        .aviso:empty { display: none; }
        .sel-mes { padding: 4px 6px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; background: #fff; color: #334155; }
        .sel-mes.cambiado { border-color: #d97706; background: #fffbeb; font-weight: 600; }
        .aviso.aviso-error { background: #fef2f2; color: #b91c1c; }
        .filters-container input.buscar { flex: 2; min-width: 220px; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; }
        .btn-small { background: #002d5b; color: white; border: none; padding: 8px 14px; border-radius: 6px; font-weight: bold; font-size: 12px; cursor: pointer; }
        .inp-comercial { width: 290px; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="logo">📐 AutenTIC</div>
        <div class="kpi-box">
          <div class="kpi-title" id="kpiLabel">Valor Total Facturado (Bruto)</div>
          <div class="kpi-value" id="totalKPI">$ 0,00</div>
        </div>
      </div>

      <div class="filters-container" id="barraFiltros">
        <select id="selAno" class="server" onchange="cargarFacturas()"></select>
        <select id="selMes" class="server" onchange="cargarFacturas()"></select>
        <select id="filterCondicion" onchange="aplicarFiltros()"><option value="">CONDICIÓN (Todas)</option></select>
        <select id="filterCliente" onchange="aplicarFiltros()"><option value="">CLIENTE (Todos)</option></select>
        <select id="filterResponsable" onchange="aplicarFiltros()"><option value="">RESPONSABLE (Todos)</option></select>
        <select id="filterEmpresa" onchange="aplicarFiltros()"><option value="">EMPRESA (Todas)</option></select>
      </div>

      <div id="avisoEmpresas" class="aviso"></div>

      <div class="tabs">
        <button class="tab-btn active" id="btnFact" onclick="switchTab('facturacion')">FACTURACIÓN</button>
        <button class="tab-btn" id="btnWompi" onclick="switchTab('wompi')">VENTAS WOMPI</button>
        <button class="tab-btn" id="btnCons" onclick="switchTab('consolidado')">CONSOLIDADO</button>
        <button class="tab-btn" id="btnCont" onclick="switchTab('contratos')">CONTRATOS</button>
        <button class="tab-btn" id="btnTerc" onclick="switchTab('terceros')">TERCEROS</button>
      </div>

      <!-- Vista Facturación -->
      <div id="viewFacturacion" class="table-container">
        <table>
          <thead>
            <tr>
              <th>CLIENTE</th>
              <th>NIT</th>
              <th>MES</th>
              <th>CONSUMO MES</th>
              <th>No FRA</th>
              <th>FECHA</th>
              <th>VENCIMIENTO</th>
              <th>CONDICIÓN</th>
              <th>FECHA DE PAGO</th>
              <th>VALOR BRUTO</th>
              <th>TOTAL</th>
              <th>SALDO</th>
              <th>EMPRESA</th>
              <th>FORMA DE PAGO</th>
            </tr>
          </thead>
          <tbody id="tablaFacturas"></tbody>
        </table>
      </div>

      <!-- Vista Ventas Wompi -->
      <div id="viewWompi" style="display:none;">
        <div class="aviso" style="background:#eff6ff;color:#1e40af;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
          <span>
            Ventas cuya forma de pago corresponde a Wompi (contrapartida 138095). Si falta alguna o sobra otra, revisa las
            <a href="/api/formas-pago" target="_blank">formas de pago de Siigo</a>.
          </span>
          <button class="btn-small" onclick="cargarFacturas(true)">🔍 BUSCAR / ACTUALIZAR WOMPI</button>
        </div>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>CLIENTE</th>
                <th>NIT</th>
                <th>MES</th>
                <th>CONSUMO MES</th>
                <th>No FRA</th>
                <th>FECHA</th>
                <th>VENCIMIENTO</th>
                <th>CONDICIÓN</th>
                <th>FECHA DE PAGO</th>
                <th>VALOR BRUTO</th>
                <th>TOTAL</th>
                <th>SALDO</th>
                <th>EMPRESA</th>
                <th>FORMA DE PAGO</th>
              </tr>
            </thead>
            <tbody id="tablaWompi"></tbody>
          </table>
        </div>
      </div>

      <!-- Vista Consolidado -->
      <div id="viewConsolidado" class="table-container" style="display:none;">
        <table>
          <thead>
            <tr>
              <th>CLIENTE</th>
              <th>ENERO</th>
              <th>FEBRERO</th>
              <th>MARZO</th>
              <th>ABRIL</th>
              <th>MAYO</th>
              <th>JUNIO</th>
              <th>JULIO</th>
              <th>AGOSTO</th>
              <th>SEPTIEMBRE</th>
              <th>OCTUBRE</th>
              <th>NOVIEMBRE</th>
              <th>DICIEMBRE</th>
              <th>TOTAL BRUTO</th>
            </tr>
          </thead>
          <tbody id="tablaConsolidado"></tbody>
        </table>
      </div>

      <!-- Vista Terceros -->
      <div id="viewTerceros" style="display:none;">
        <div class="filters-container">
          <input type="text" id="tBuscar" class="buscar" placeholder="Buscar por nombre o NIT..." oninput="filtrarTerceros()" />
          <select id="tEmpresa" onchange="filtrarTerceros()"><option value="">EMPRESA (Todas)</option></select>
          <select id="tAsignacion" onchange="filtrarTerceros()">
            <option value="">COMERCIAL (Todos)</option>
            <option value="SIN">SIN COMERCIAL</option>
            <option value="CON">CON COMERCIAL</option>
          </select>
          <button class="btn-small" onclick="cargarTerceros(true)">↻ ACTUALIZAR DESDE SIIGO</button>
        </div>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>NOMBRE / RAZÓN SOCIAL</th>
                <th>NIT</th>
                <th>TIPO</th>
                <th>CIUDAD</th>
                <th>EMAIL</th>
                <th>TELÉFONO</th>
                <th>EMPRESA</th>
                <th>COMERCIAL ENCARGADO</th>
              </tr>
            </thead>
            <tbody id="tablaTerceros"></tbody>
          </table>
        </div>
      </div>

      <!-- Vista Contratos -->
      <div id="viewContratos" style="display:none;">
        <form class="form-container" onsubmit="guardarContrato(event)">
          <input type="text" id="cCliente" placeholder="Nombre del Cliente" required />
          <input type="number" id="cValor" placeholder="Valor Contrato" required />
          <input type="date" id="cFechaInicio" required />
          <input type="date" id="cFechaFin" required />
          <select id="cEstado">
            <option value="ACTIVO">ACTIVO</option>
            <option value="PENDIENTE">PENDIENTE</option>
            <option value="FINALIZADO">FINALIZADO</option>
          </select>
          <input type="text" id="cResponsable" placeholder="Responsable Comercial" required />
          <button type="submit" class="btn-submit">+ REGISTRAR CONTRATO</button>
        </form>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>CLIENTE</th>
                <th>VALOR CONTRATO</th>
                <th>FECHA INICIO</th>
                <th>FECHA FIN</th>
                <th>ESTADO</th>
                <th>RESPONSABLE</th>
              </tr>
            </thead>
            <tbody id="tablaContratos"></tbody>
          </table>
        </div>
      </div>

      <script>
        let facturasGlobales = [];
        let tabActual = 'facturacion';
        let tercerosGlobales = [];
        let comerciales = [];
        let recargarFacturas = false;

        function esc(s) {
          return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function mostrarAviso(resumen, etiqueta) {
          const cont = document.getElementById('avisoEmpresas');
          if (!resumen || !resumen.length) { cont.className = 'aviso'; cont.innerHTML = ''; return; }
          const hayError = resumen.some(function (r) { return r.error || r.nota; });
          cont.className = 'aviso' + (hayError ? ' aviso-error' : '');
          cont.innerHTML = '<b>' + esc(etiqueta) + ' →</b> ' + resumen.map(function (r) {
            return '<b>' + esc(r.empresa) + ':</b> ' + (r.error ? '⚠ ' + esc(r.error) : r.cantidad + ' registros' + (r.rango ? ' · facturas ' + esc(r.rango) : '') + (r.nota ? ' (⚠ ' + esc(r.nota) + ')' : ''));
          }).join(' &nbsp;|&nbsp; ');
        }

        function refrescarFacturasSiHaceFalta() {
          if (recargarFacturas) { recargarFacturas = false; cargarFacturas(); } else { aplicarFiltros(); }
        }
        const NOMBRES_MES = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];

        function iniciarSelectoresFecha() {
          const hoy = new Date();
          const selAno = document.getElementById('selAno');
          for (let y = hoy.getFullYear(); y >= 2022; y--) {
            selAno.innerHTML += '<option value="' + y + '">AÑO ' + y + '</option>';
          }
          const selMes = document.getElementById('selMes');
          selMes.innerHTML = '<option value="">MES (Todo el año)</option>';
          NOMBRES_MES.forEach(function (m, i) {
            selMes.innerHTML += '<option value="' + (i + 1) + '">' + m + '</option>';
          });
          selMes.value = String(hoy.getMonth() + 1);
        }

        // soloWompi = true: vuelve a leer Siigo (sin caché) y reemplaza únicamente las ventas Wompi
        async function cargarFacturas(soloWompi) {
          const ano = document.getElementById('selAno').value;
          const mes = document.getElementById('selMes').value;
          const cargando = '<tr><td colspan="14" style="text-align:center;">Consultando Siigo...</td></tr>';
          if (!soloWompi) document.getElementById('tablaFacturas').innerHTML = cargando;
          document.getElementById('tablaWompi').innerHTML = cargando;
          let resumen = [];
          try {
            const url = '/api/facturas?ano=' + ano + (mes ? '&mes=' + mes : '') + (soloWompi ? '&refrescar=1&solo=wompi' : '');
            const res = await fetch(url);
            const data = await res.json();
            const nuevas = data.facturas || [];
            resumen = data.resumen || [];
            if (soloWompi) {
              // Se reemplazan solo las ventas Wompi; si una empresa falló, se conservan las que ya había de esa empresa
              const conError = resumen.filter(function (r) { return r.error; }).map(function (r) { return r.empresa; });
              facturasGlobales = facturasGlobales.filter(function (f) {
                return !f.esWompi || conError.indexOf(f.empresa) >= 0;
              }).concat(nuevas);
            } else {
              facturasGlobales = nuevas;
            }
          } catch (e) {
            if (!soloWompi) facturasGlobales = [];
            resumen = [{ empresa: 'Servidor', error: 'No se pudo consultar /api/facturas' }];
          }
          mostrarAviso(resumen, soloWompi ? 'Ventas Wompi' : 'Facturas');
          poblarFiltros(facturasGlobales);
          if (tabActual === 'contratos' || tabActual === 'terceros') return;
          aplicarFiltros();
        }

        function switchTab(tab) {
          tabActual = tab;
          document.getElementById('btnFact').classList.toggle('active', tab === 'facturacion');
          document.getElementById('btnCons').classList.toggle('active', tab === 'consolidado');
          document.getElementById('btnCont').classList.toggle('active', tab === 'contratos');
          document.getElementById('btnTerc').classList.toggle('active', tab === 'terceros');
          document.getElementById('btnWompi').classList.toggle('active', tab === 'wompi');
          document.getElementById('viewWompi').style.display = tab === 'wompi' ? 'block' : 'none';

          document.getElementById('viewFacturacion').style.display = tab === 'facturacion' ? 'block' : 'none';
          document.getElementById('viewConsolidado').style.display = tab === 'consolidado' ? 'block' : 'none';
          document.getElementById('viewContratos').style.display = tab === 'contratos' ? 'block' : 'none';
          document.getElementById('viewTerceros').style.display = tab === 'terceros' ? 'block' : 'none';
          document.getElementById('barraFiltros').style.display = (tab === 'contratos' || tab === 'terceros') ? 'none' : 'flex';

          if (tab === 'facturacion') {
            document.getElementById('kpiLabel').innerText = 'Valor Total Facturado (Bruto)';
            refrescarFacturasSiHaceFalta();
          } else if (tab === 'consolidado') {
            document.getElementById('kpiLabel').innerText = 'Total Consolidado (Bruto)';
            refrescarFacturasSiHaceFalta();
          } else if (tab === 'contratos') {
            document.getElementById('kpiLabel').innerText = 'Total Contratos Registrados';
            cargarContratos();
          } else if (tab === 'terceros') {
            document.getElementById('kpiLabel').innerText = 'Terceros listados';
            cargarTerceros(false);
          } else if (tab === 'wompi') {
            document.getElementById('kpiLabel').innerText = 'Total Ventas Wompi (Bruto)';
            refrescarFacturasSiHaceFalta();
          }
        }

        function poblarSelect(idSelect, valores, titulo) {
          const sel = document.getElementById(idSelect);
          const previo = sel.value;
          sel.innerHTML = '<option value="">' + titulo + '</option>';
          Array.from(new Set(valores)).sort().forEach(function (v) {
            if (v && v !== 'N/A') sel.innerHTML += '<option value="' + v + '">' + v + '</option>';
          });
          if (previo && Array.from(sel.options).some(function (o) { return o.value === previo; })) sel.value = previo;
        }

        function poblarFiltros(data) {
          poblarSelect('filterCondicion', data.map(function (d) { return d.condicion; }), 'CONDICIÓN (Todas)');
          poblarSelect('filterCliente', data.map(function (d) { return d.cliente; }), 'CLIENTE (Todos)');
          poblarSelect('filterResponsable', data.map(function (d) { return d.responsable; }), 'RESPONSABLE (Todos)');
          poblarSelect('filterEmpresa', data.map(function (d) { return d.empresa; }), 'EMPRESA (Todas)');
        }

        function aplicarFiltros() {
          const fCond = document.getElementById('filterCondicion').value;
          const fCli = document.getElementById('filterCliente').value;
          const fResp = document.getElementById('filterResponsable').value;
          const fEmp = document.getElementById('filterEmpresa').value;

          const filtradas = facturasGlobales.filter(function (f) {
            return (!fCond || f.condicion === fCond) &&
                   (!fCli || f.cliente === fCli) &&
                   (!fResp || f.responsable === fResp) &&
                   (!fEmp || f.empresa === fEmp);
          });

          // Facturación y Consolidado muestran todo menos las ventas Wompi; esas van en su pestaña
          const normales = filtradas.filter(function (f) { return !f.esWompi; }).sort(ordenarFacturas);
          const wompi = filtradas.filter(function (f) { return f.esWompi; }).sort(ordenarFacturas);

          if (tabActual === 'facturacion') {
            renderFacturas(normales, 'tablaFacturas');
          } else if (tabActual === 'wompi') {
            renderFacturas(wompi, 'tablaWompi');
          } else if (tabActual === 'consolidado') {
            renderConsolidado(normales);
          }
        }

        function fmt(n) { return '$ ' + Number(n || 0).toLocaleString('es-CO'); }

        function pad2(n) { return (n < 10 ? '0' : '') + n; }

        // Opciones del selector: los 11 meses anteriores al de la factura, el propio y el siguiente
        function opcionesMes(f) {
          const y = Number(String(f.fecha).slice(0, 4));
          const m = Number(String(f.fecha).slice(5, 7));
          const lista = [];
          for (let k = -11; k <= 1; k++) {
            const idx = m - 1 + k;
            const yy = y + Math.floor(idx / 12);
            const mm = ((idx % 12) + 12) % 12;
            lista.push({ valor: yy + '-' + pad2(mm + 1), etiqueta: NOMBRES_MES[mm] + (yy !== y ? ' ' + yy : '') });
          }
          return lista;
        }

        // Celda MES: selector editable que guarda el mes elegido para esa factura
        function celdaMes(f) {
          if (!f.id || !f.fecha || f.empresaId === undefined) return esc(f.mes);
          const propio = String(f.fecha).slice(0, 7);
          const actual = f.mesAsignado || propio;
          const cambiado = !!f.mesAsignado && f.mesAsignado !== propio;
          return '<select class="sel-mes' + (cambiado ? ' cambiado' : '') + '" data-emp="' + esc(f.empresaId) + '" data-id="' + esc(f.id) + '" ' +
            'title="' + (cambiado ? 'Mes cambiado manualmente. Fecha de la factura: ' + esc(f.fecha) : 'Mes de la factura. Puedes cambiarlo.') + '" onchange="cambiarMes(this)">' +
            opcionesMes(f).map(function (o) {
              return '<option value="' + o.valor + '"' + (o.valor === actual ? ' selected' : '') + '>' + o.etiqueta + '</option>';
            }).join('') + '</select>';
        }

        async function cambiarMes(sel) {
          const empId = sel.getAttribute('data-emp');
          const id = sel.getAttribute('data-id');
          const f = facturasGlobales.find(function (x) { return String(x.empresaId) === empId && String(x.id) === id; });
          if (!f) return;
          const propio = String(f.fecha).slice(0, 7);
          const valor = sel.value === propio ? '' : sel.value;
          const previo = f.mesAsignado || '';
          sel.disabled = true;
          try {
            const res = await fetch('/api/facturas/' + encodeURIComponent(empId) + '/' + encodeURIComponent(id) + '/mes', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mes: valor })
            });
            if (!res.ok) throw new Error('fallo');
            f.mesAsignado = valor;
            const ef = valor || propio;
            f.anoMes = ef.slice(0, 4);
            f.numMes = Number(ef.slice(5, 7)) - 1;
            f.mes = NOMBRES_MES[f.numMes];
            sel.classList.toggle('cambiado', !!valor);
            // Si el mes elegido queda fuera del periodo que se está consultando, la factura sale de esta lista
            const anoSel = document.getElementById('selAno').value;
            const mesSel = document.getElementById('selMes').value;
            const dentro = String(f.anoMes) === anoSel && (!mesSel || Number(ef.slice(5, 7)) === Number(mesSel));
            if (!dentro) {
              facturasGlobales = facturasGlobales.filter(function (x) { return x !== f; });
              aplicarFiltros();
              const cont = document.getElementById('avisoEmpresas');
              cont.className = 'aviso';
              cont.innerHTML = 'Factura <b>' + esc(f.numero) + '</b> movida a <b>' + NOMBRES_MES[f.numMes] + ' ' + esc(f.anoMes) + '</b>. Aparecerá al consultar ese mes.';
            }
          } catch (e) {
            sel.value = previo || propio;
            alert('No se pudo guardar el mes de la factura');
          }
          sel.disabled = false;
        }

        // Facturas de mayor a menor consecutivo
        function ordenarFacturas(a, b) {
          return (b.consecutivo || 0) - (a.consecutivo || 0) ||
                 String(b.fecha).localeCompare(String(a.fecha)) ||
                 String(a.empresa).localeCompare(String(b.empresa));
        }

        function renderFacturas(data, destino) {
          let html = '';
          let total = 0;
          data.forEach(function (f) {
            total += f.valor;
            const badgeClass = f.condicion === 'PENDIENTE' ? 'badge-pendiente' : 'badge-pagado';
            html += '<tr>' +
              '<td><b>' + f.cliente + '</b></td>' +
              '<td>' + (f.nit || '-') + '</td>' +
              '<td>' + celdaMes(f) + '</td>' +
              '<td title="' + esc(f.observaciones || '') + '">' + esc(f.consumo || '-') + '</td>' +
              '<td>' + f.numero + '</td>' +
              '<td>' + f.fecha + '</td>' +
              '<td>' + f.vencimiento + '</td>' +
              '<td><span class="' + badgeClass + '">' + f.condicion + '</span></td>' +
              '<td>' + f.fechaPago + '</td>' +
              '<td><b>' + fmt(f.valor) + '</b></td>' +
              '<td>' + fmt(f.total) + '</td>' +
              '<td>' + fmt(f.saldo) + '</td>' +
              '<td>' + f.empresa + '</td>' +
              '<td>' + esc(f.formaPago || '-') + '</td>' +
              '</tr>';
          });
          document.getElementById(destino || 'tablaFacturas').innerHTML = html || '<tr><td colspan="14" style="text-align:center;">Sin datos</td></tr>';
          document.getElementById('totalKPI').innerText = fmt(total);
        }

        function renderConsolidado(data) {
          const mapa = {};
          let totalGeneral = 0;

          data.forEach(function (f) {
            if (!mapa[f.cliente]) mapa[f.cliente] = Array(12).fill(0);
            // Si el mes asignado cae en otro año, se deja en el mes real de la factura para no perder el valor
            const anoSel = document.getElementById('selAno').value;
            const idx = (f.anoMes === undefined || String(f.anoMes) === anoSel) ? f.numMes : f.numMesFactura;
            mapa[f.cliente][idx] += f.valor;
            totalGeneral += f.valor;
          });

          let html = '';
          Object.keys(mapa).forEach(function (cliente) {
            const meses = mapa[cliente];
            const totalCliente = meses.reduce(function (a, b) { return a + b; }, 0);
            html += '<tr><td><b>' + cliente + '</b></td>' +
              meses.map(function (m) { return '<td>' + (m > 0 ? fmt(m) : '-') + '</td>'; }).join('') +
              '<td><b>' + fmt(totalCliente) + '</b></td></tr>';
          });

          document.getElementById('tablaConsolidado').innerHTML = html || '<tr><td colspan="14" style="text-align:center;">Sin datos</td></tr>';
          document.getElementById('totalKPI').innerText = fmt(totalGeneral);
        }

        async function cargarContratos() {
          const res = await fetch('/api/contratos');
          const contratos = await res.json();
          let html = '';
          let total = 0;

          contratos.forEach(function (c) {
            total += Number(c.valor);
            html += '<tr>' +
              '<td><b>' + c.cliente + '</b></td>' +
              '<td>' + fmt(c.valor) + '</td>' +
              '<td>' + c.fechaInicio + '</td>' +
              '<td>' + c.fechaFin + '</td>' +
              '<td><span class="badge-activo">' + c.estado + '</span></td>' +
              '<td>' + c.responsable + '</td>' +
              '</tr>';
          });

          document.getElementById('tablaContratos').innerHTML = html;
          document.getElementById('totalKPI').innerText = fmt(total);
        }

        async function guardarContrato(e) {
          e.preventDefault();
          const body = {
            cliente: document.getElementById('cCliente').value,
            valor: document.getElementById('cValor').value,
            fechaInicio: document.getElementById('cFechaInicio').value,
            fechaFin: document.getElementById('cFechaFin').value,
            estado: document.getElementById('cEstado').value,
            responsable: document.getElementById('cResponsable').value
          };

          await fetch('/api/contratos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });

          e.target.reset();
          cargarContratos();
        }

        // ---------- Terceros ----------
        async function cargarTerceros(refrescar) {
          document.getElementById('tablaTerceros').innerHTML = '<tr><td colspan="8" style="text-align:center;">Cargando terceros desde Siigo (la primera vez puede tardar)...</td></tr>';
          try {
            const rc = await fetch('/api/comerciales');
            comerciales = await rc.json();
          } catch (e) { comerciales = []; }
          try {
            const res = await fetch('/api/terceros' + (refrescar ? '?refrescar=1' : ''));
            const data = await res.json();
            tercerosGlobales = data.terceros || [];
            mostrarAviso(data.resumen || [], 'Terceros');
            if (data.almacenamiento === 'archivo') {
              const cont = document.getElementById('avisoEmpresas');
              cont.className = 'aviso aviso-error';
              cont.innerHTML += '<br>⚠ Las asignaciones se guardan en un archivo local y se pierden si el hosting reinicia o se vuelve a desplegar. Configura UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN (o conecta Upstash desde Vercel > Storage) para que sean permanentes. Diagnóstico: /api/estado';
            }
          } catch (e) {
            tercerosGlobales = [];
            mostrarAviso([{ empresa: 'Servidor', error: 'No se pudo consultar /api/terceros' }], 'Terceros');
          }
          const empresasT = [];
          tercerosGlobales.forEach(function (t) { t.empresas.forEach(function (e) { empresasT.push(e); }); });
          poblarSelect('tEmpresa', empresasT, 'EMPRESA (Todas)');
          poblarComerciales();
          filtrarTerceros();
        }

        // Filtro de la pestaña: Todos / Sin comercial / Con comercial / cada comercial
        function poblarComerciales() {
          const sel = document.getElementById('tAsignacion');
          const previo = sel.value;
          sel.innerHTML = '<option value="">COMERCIAL (Todos)</option><option value="SIN">SIN COMERCIAL</option><option value="CON">CON COMERCIAL</option>' +
            comerciales.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
          sel.value = previo;
        }

        // Lista desplegable por fila con los comerciales disponibles
        function selectComercial(t) {
          const opciones = comerciales.slice();
          if (t.comercial && opciones.indexOf(t.comercial) < 0) opciones.push(t.comercial);
          return '<select class="inp-comercial" data-nit="' + esc(t.nit) + '" onchange="asignarComercial(this)">' +
            '<option value="">— SIN ASIGNAR —</option>' +
            opciones.map(function (n) {
              return '<option value="' + esc(n) + '"' + (n === t.comercial ? ' selected' : '') + '>' + esc(n) + '</option>';
            }).join('') + '</select>';
        }

        function filtrarTerceros() {
          const q = document.getElementById('tBuscar').value.trim().toUpperCase();
          const fEmp = document.getElementById('tEmpresa').value;
          const fAsig = document.getElementById('tAsignacion').value;
          const lista = tercerosGlobales.filter(function (t) {
            return (!q || t.nombre.toUpperCase().indexOf(q) >= 0 || t.nit.indexOf(q) >= 0) &&
                   (!fEmp || t.empresas.indexOf(fEmp) >= 0) &&
                   (!fAsig || (fAsig === 'SIN' ? !t.comercial : fAsig === 'CON' ? !!t.comercial : t.comercial === fAsig));
          });

          const LIMITE = 300;
          let html = '';
          lista.slice(0, LIMITE).forEach(function (t) {
            html += '<tr>' +
              '<td><b>' + esc(t.nombre) + '</b></td>' +
              '<td>' + esc(t.nit) + '</td>' +
              '<td>' + esc(t.tipo) + '</td>' +
              '<td>' + esc(t.ciudad) + '</td>' +
              '<td>' + esc(t.email) + '</td>' +
              '<td>' + esc(t.telefono) + '</td>' +
              '<td>' + esc(t.empresas.join(', ')) + '</td>' +
              '<td>' + selectComercial(t) + '</td>' +
              '</tr>';
          });
          if (lista.length > LIMITE) {
            html += '<tr><td colspan="8" style="text-align:center;color:#64748b;">Mostrando los primeros ' + LIMITE + ' de ' + lista.length + '. Usa el buscador para acotar.</td></tr>';
          }
          document.getElementById('tablaTerceros').innerHTML = html || '<tr><td colspan="8" style="text-align:center;">Sin datos</td></tr>';
          if (tabActual === 'terceros') document.getElementById('totalKPI').innerText = String(lista.length);
        }

        async function asignarComercial(input) {
          const nit = input.getAttribute('data-nit');
          const comercial = input.value.trim().toUpperCase();
          input.value = comercial;
          try {
            const res = await fetch('/api/terceros/' + encodeURIComponent(nit) + '/comercial', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ comercial: comercial })
            });
            if (!res.ok) throw new Error('fallo');
            const t = tercerosGlobales.find(function (x) { return x.nit === nit; });
            if (t) t.comercial = comercial;
            input.style.borderColor = '#16a34a';
            recargarFacturas = true;
            poblarComerciales();
          } catch (e) {
            input.style.borderColor = '#dc2626';
            alert('No se pudo guardar la asignación');
          }
        }

        iniciarSelectoresFecha();
        cargarFacturas();
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor AutenTIC corriendo en el puerto ${PORT}`);
});