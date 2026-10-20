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
// "Cruce de vencimiento" siempre se cuenta como venta Wompi, además de lo que se defina en WOMPI_FORMAS_PAGO.
// Se comparan nombres sin tildes ni mayúsculas, y "contiene" (así también sirve "Cruce de vencimientos").
const normalizarTexto = (t) => String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const WOMPI_FORMAS = ((process.env.WOMPI_FORMAS_PAGO || 'WOMPI') + ';CRUCE DE VENCIMIENTO')
  .split(';').map(normalizarTexto).filter(Boolean);
function esPagoWompi(p) {
  const id = normalizarTexto(p.id);
  const nombre = normalizarTexto(p.name);
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

// ---------- Módulo asignado manualmente a cada factura (FACTURACION o WOMPI) ----------
// Guarda { "empresaId:facturaId": "WOMPI" | "FACTURACION" } y manda sobre la clasificación automática por forma de pago
const ARCHIVO_MODULOS = path.join(process.env.DATA_DIR || __dirname, 'modulos.json');
const CLAVE_MODULOS = 'autentic:modulos';
let modulosAsignados = {};
try { modulosAsignados = JSON.parse(fs.readFileSync(ARCHIVO_MODULOS, 'utf8')); } catch (e) { modulosAsignados = {}; }

async function cargarModulos() {
  if (!ALMACEN_REMOTO) return;
  try {
    const remoto = hashAObjeto(await redis(['HGETALL', CLAVE_MODULOS]));
    for (const [k, v] of Object.entries(modulosAsignados)) {
      if (!remoto[k]) {
        try { await redis(['HSET', CLAVE_MODULOS, k, v]); remoto[k] = v; } catch (e) { /* se reintenta en el próximo arranque */ }
      }
    }
    modulosAsignados = remoto;
    console.log(`Módulos de facturas cargados desde Upstash: ${Object.keys(remoto).length}`);
  } catch (e) {
    console.error('No se pudieron leer los módulos de Upstash:', e.message);
  }
}

async function persistirModulo(clave, valor) {
  if (ALMACEN_REMOTO) {
    await redis(valor ? ['HSET', CLAVE_MODULOS, clave, valor] : ['HDEL', CLAVE_MODULOS, clave]);
  }
  if (valor) modulosAsignados[clave] = valor;
  else delete modulosAsignados[clave];
  try { fs.writeFileSync(ARCHIVO_MODULOS, JSON.stringify(modulosAsignados, null, 2)); } catch (e) { /* hosting de solo lectura */ }
}

// ---------- Comercial asignado manualmente a una factura (manda sobre el comercial del cliente) ----------
// Guarda { "empresaId:facturaId": "NOMBRE DEL COMERCIAL" }; sirve cuando un cliente tiene más de un asesor
const ARCHIVO_COM_FACT = path.join(process.env.DATA_DIR || __dirname, 'comerciales-factura.json');
const CLAVE_COM_FACT = 'autentic:comerciales-factura';
let comercialesFactura = {};
try { comercialesFactura = JSON.parse(fs.readFileSync(ARCHIVO_COM_FACT, 'utf8')); } catch (e) { comercialesFactura = {}; }

async function cargarComercialesFactura() {
  if (!ALMACEN_REMOTO) return;
  try {
    const remoto = hashAObjeto(await redis(['HGETALL', CLAVE_COM_FACT]));
    for (const [k, v] of Object.entries(comercialesFactura)) {
      if (!remoto[k]) {
        try { await redis(['HSET', CLAVE_COM_FACT, k, v]); remoto[k] = v; } catch (e) { /* se reintenta en el próximo arranque */ }
      }
    }
    comercialesFactura = remoto;
    console.log(`Comerciales por factura cargados desde Upstash: ${Object.keys(remoto).length}`);
  } catch (e) {
    console.error('No se pudieron leer los comerciales por factura de Upstash:', e.message);
  }
}

async function persistirComercialFactura(clave, valor) {
  if (ALMACEN_REMOTO) {
    await redis(valor ? ['HSET', CLAVE_COM_FACT, clave, valor] : ['HDEL', CLAVE_COM_FACT, clave]);
  }
  if (valor) comercialesFactura[clave] = valor;
  else delete comercialesFactura[clave];
  try { fs.writeFileSync(ARCHIVO_COM_FACT, JSON.stringify(comercialesFactura, null, 2)); } catch (e) { /* hosting de solo lectura */ }
}

const asignacionesListas = Promise.all([cargarAsignaciones(), cargarMeses(), cargarModulos(), cargarComercialesFactura()]);

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
    const [a, m, mo, cf] = await Promise.all([redis(['HGETALL', CLAVE_ASIGNACIONES]), redis(['HGETALL', CLAVE_MESES]), redis(['HGETALL', CLAVE_MODULOS]), redis(['HGETALL', CLAVE_COM_FACT])]);
    asignaciones = hashAObjeto(a);
    mesesAsignados = hashAObjeto(m);
    modulosAsignados = hashAObjeto(mo);
    comercialesFactura = hashAObjeto(cf);
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

// ---------- Notas crédito ----------
// La factura de Siigo no indica si tiene nota crédito: se leen las notas crédito (GET /v1/credit-notes),
// que traen invoice.id e invoice.name de la factura a la que se aplicaron, y se cruzan con las facturas.
const notasCreditoCache = new Map(); // "empresa|desde" -> { ts, mapa }

async function traerNotasCredito(token, desde, hasta) {
  const todas = [];
  let page = 1;
  let total = Infinity;
  while (todas.length < total) {
    const data = await siigoGet('/v1/credit-notes', { page, page_size: 100, date_start: desde, date_end: hasta }, token);
    const results = data.results || [];
    total = data.pagination && data.pagination.total_results != null ? data.pagination.total_results : results.length;
    todas.push(...results);
    if (results.length === 0) break;
    page++;
  }
  return todas;
}

// Notas crédito emitidas desde 2 meses antes del periodo hasta hoy (una nota puede emitirse meses después de la factura)
async function notasCreditoPorFactura(emp, token, desde, refrescar) {
  const ini = sumarDias(desde, -62);
  const fin = sumarDias(new Date().toISOString().slice(0, 10), 1);
  const clave = `${emp.id}|${ini}`;
  const c = notasCreditoCache.get(clave);
  if (!refrescar && c && Date.now() - c.ts < 5 * 60 * 1000) return c.mapa;

  const lista = await traerNotasCredito(token, ini, fin);
  const porId = new Map();
  const porNombre = new Map();
  const acumular = (mapa, k, n) => {
    if (!k) return;
    const e = mapa.get(k) || { total: 0, nombres: [] };
    e.total += Number(n.total) || 0;
    e.nombres.push(n.name || String(n.id));
    mapa.set(k, e);
  };
  lista.forEach(n => {
    const ref = n.invoice || {};
    acumular(porId, ref.id ? String(ref.id) : '', n);
    acumular(porNombre, ref.name ? String(ref.name) : '', n);
  });
  const mapa = { porId, porNombre };
  notasCreditoCache.set(clave, { ts: Date.now(), mapa });
  return mapa;
}

// Resumen para el diagnóstico: permite comprobar con datos reales cómo referencia Siigo la factura
async function resumenNotasCredito(token, desde) {
  try {
    const lista = await traerNotasCredito(token, sumarDias(desde, -62), sumarDias(new Date().toISOString().slice(0, 10), 1));
    return {
      recibidas: lista.length,
      conFacturaReferenciada: lista.filter(n => n.invoice && (n.invoice.id || n.invoice.name)).length,
      ejemplos: lista.slice(0, 3).map(n => ({ nota: n.name, factura: n.invoice || null, total: n.total, fecha: n.date }))
    };
  } catch (e) {
    return { error: describirError(e) };
  }
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
  let ncMapa = null;
  let notaNC = '';
  try {
    ncMapa = await notasCreditoPorFactura(emp, token, desde, refrescar);
  } catch (e) {
    notaNC = `No se pudieron cargar las notas crédito (${describirError(e)}); pueden verse facturas con nota crédito.`;
  }
  const nota = [await resolverClientes(emp, token, facturas), ajuste.nota, incompleta, notaNC].filter(Boolean).join(' ');

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
    const nc = ncMapa ? (ncMapa.porId.get(String(f.id)) || ncMapa.porNombre.get(String(f.name))) : null;
    // Facturas que Siigo entrega sin forma de pago (es el caso del cruce de vencimiento): se tratan como ventas Wompi
    const sinFormaPago = !(f.payments || []).some(p => p && (p.name || p.id));
    const autoWompi = sinFormaPago || (f.payments || []).some(esPagoWompi);
    // Si el usuario eligió el módulo de esta factura, esa elección manda sobre la clasificación automática
    const mo = modulosAsignados[`${emp.id}:${f.id}`];
    const moValido = mo === 'WOMPI' || mo === 'FACTURACION';
    const nit = c.identification || '';
    const nombre = clientesCache.get(`${emp.id}:${c.id}`) || nombreDeCliente(c) || (nit ? `CLIENTE (${nit})` : 'N/A');
    // Facturas en moneda extranjera (p. ej. USD): Siigo entrega los valores en esa moneda y la tasa de cambio en currency.exchange_rate.
    // Todo se convierte a pesos con esa tasa; las facturas en COP quedan igual.
    const moneda = String((f.currency && f.currency.code) || 'COP').toUpperCase();
    const tasaApi = Number(f.currency && f.currency.exchange_rate);
    const tasa = moneda !== 'COP' && tasaApi > 0 ? tasaApi : 1;
    const aPesos = (n) => Math.round((Number(n) || 0) * tasa * 100) / 100;
    const saldoOriginal = Number(f.balance) || 0;
    const saldo = aPesos(saldoOriginal);
    const seller = f.seller;
    // Siigo a veces entrega solo el número del vendedor (339, 606...): eso no es un nombre, así que se ignora
    let nombreVendedor = '';
    if (seller && typeof seller === 'object') nombreVendedor = String(seller.name || `${seller.first_name || ''} ${seller.last_name || ''}`.trim() || '').trim();
    else if (seller) nombreVendedor = String(seller).trim();
    if (/^\d+$/.test(nombreVendedor)) nombreVendedor = '';
    const comercialCliente = asignaciones[String(nit).trim()] || nombreVendedor || 'N/A';
    const comFactura = comercialesFactura[`${emp.id}:${f.id}`] || '';

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
      responsable: comFactura === 'SIN COMERCIAL' ? 'N/A' : (comFactura || comercialCliente),
      comercialCliente,
      comercialFactura: comFactura,
      formaPago: sinFormaPago ? 'SIN FORMA DE PAGO' : (f.payments || []).map(p => p.name || p.id).filter(Boolean).join(', '),
      sinFormaPago,
      esWompi: moValido ? mo === 'WOMPI' : autoWompi,
      esWompiAuto: autoWompi,
      moduloAsignado: moValido ? mo : '',
      tieneNotaCredito: !!nc,
      notaCredito: nc ? aPesos(nc.total) : 0,
      notasCredito: nc ? nc.nombres.join(', ') : '',
      consumo: extraerConsumo(f.observations),
      observaciones: f.observations || '',
      valor: aPesos(valorBruto(f)),
      total: aPesos(f.total),
      saldo,
      moneda,
      tasaCambio: tasa,
      valorMonedaOriginal: moneda !== 'COP' ? valorBruto(f) : 0,
      sinTasaCambio: moneda !== 'COP' && tasa === 1,
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
    mesesEnMemoria: Object.keys(mesesAsignados).length,
    modulosEnMemoria: Object.keys(modulosAsignados).length,
    comercialesFacturaEnMemoria: Object.keys(comercialesFactura).length
  };
  if (ALMACEN_REMOTO) {
    try {
      await redis(['SET', 'autentic:ping', String(Date.now()), 'EX', '60']);
      info.conexion = 'OK';
      info.asignacionesEnUpstash = await redis(['HLEN', CLAVE_ASIGNACIONES]);
      info.mesesEnUpstash = await redis(['HLEN', CLAVE_MESES]);
      info.modulosEnUpstash = await redis(['HLEN', CLAVE_MODULOS]);
      info.comercialesFacturaEnUpstash = await redis(['HLEN', CLAVE_COM_FACT]);
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
      const sinPago = [];
      raw.forEach(f => {
        porDia[f.date] = (porDia[f.date] || 0) + 1;
        const fp = (f.payments || []).map(p => p.name || p.id).join(', ') || '-';
        porPago[fp] = (porPago[fp] || 0) + 1;
        if (!(f.payments || []).some(p => p && (p.name || p.id)) && sinPago.length < 5) {
          sinPago.push({ factura: f.name, fecha: f.date, total: f.total, saldo: f.balance, payments: f.payments === undefined ? '(la factura no trae el campo payments)' : f.payments });
        }
      });
      const nums = raw.map(f => Number(f.number) || Number((String(f.name || '').match(/(\d+)\s*$/) || [])[1]) || 0).filter(Boolean);
      salida.empresas.push({
        empresa: emp.nombre,
        siigoReportaTotal: raw.esperadas,
        recibidas: raw.length,
        consecutivoMin: nums.length ? Math.min(...nums) : null,
        consecutivoMax: nums.length ? Math.max(...nums) : null,
        facturasPorDia: Object.fromEntries(Object.entries(porDia).sort()),
        facturasPorFormaDePago: porPago,
        ejemplosSinFormaDePago: sinPago,
        notasCredito: await resumenNotasCredito(token, desde)
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

// PUT /api/facturas/:empresaId/:facturaId/modulo   body: { modulo: "WOMPI" | "FACTURACION" }   (vacío = clasificación automática)
app.put('/api/facturas/:empresaId/:facturaId/modulo', async (req, res) => {
  await asignacionesListas;
  await sincronizarRemoto();
  const emp = empresas.find(e => String(e.id) === String(req.params.empresaId));
  const facturaId = String(req.params.facturaId || '').trim();
  const modulo = String((req.body && req.body.modulo) || '').trim().toUpperCase();
  if (!emp || !facturaId) return res.status(400).json({ success: false, error: 'Empresa o factura no válida' });
  if (modulo && modulo !== 'WOMPI' && modulo !== 'FACTURACION') return res.status(400).json({ success: false, error: 'Módulo no válido' });
  try {
    await persistirModulo(`${emp.id}:${facturaId}`, modulo);
    res.json({ success: true });
  } catch (e) {
    console.error('No se pudo guardar el módulo de la factura:', e.message);
    res.status(500).json({ success: false, error: 'No se pudo guardar el módulo' });
  }
});

// PUT /api/facturas/:empresaId/:facturaId/comercial   body: { comercial: "NOMBRE" }   (vacío = vuelve al comercial del cliente)
app.put('/api/facturas/:empresaId/:facturaId/comercial', async (req, res) => {
  await asignacionesListas;
  await sincronizarRemoto();
  const emp = empresas.find(e => String(e.id) === String(req.params.empresaId));
  const facturaId = String(req.params.facturaId || '').trim();
  const comercial = String((req.body && req.body.comercial) || '').trim();
  if (!emp || !facturaId) return res.status(400).json({ success: false, error: 'Empresa o factura no válida' });
  if (comercial && comercial !== 'SIN COMERCIAL' && !COMERCIALES.includes(comercial)) return res.status(400).json({ success: false, error: 'Comercial no válido' });
  try {
    await persistirComercialFactura(`${emp.id}:${facturaId}`, comercial);
    res.json({ success: true });
  } catch (e) {
    console.error('No se pudo guardar el comercial de la factura:', e.message);
    res.status(500).json({ success: false, error: 'No se pudo guardar el comercial' });
  }
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
  const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const COMERCIALES_JSON = JSON.stringify(COMERCIALES).replace(/</g, '\\u003c');
  const OPCIONES_EMPRESA = empresas.map(e => '<option value="' + escHtml(e.nombre) + '">' + escHtml(e.nombre) + '</option>').join('');
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
        .filters-container select { flex: 1; min-width: 175px; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; color: #334155; background: #fff; }
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
        .chk { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #334155; white-space: nowrap; cursor: pointer; }
        .sel-mes { padding: 4px 6px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; background: #fff; color: #334155; }
        .sel-mes.cambiado { border-color: #d97706; background: #fffbeb; font-weight: 600; }
        .aviso.aviso-error { background: #fef2f2; color: #b91c1c; }
        .filters-container input[type=text], .filters-container input[type=number], .filters-container input[type=date] { flex: 1; min-width: 175px; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; color: #334155; background: #fff; }
        .nota-vista { background: #eff6ff; color: #1e40af; padding: 10px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 12px; }
        .filters-container input.buscar { flex: 2; min-width: 220px; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; }
        .btn-small { background: #002d5b; color: white; border: none; padding: 8px 14px; border-radius: 6px; font-weight: bold; font-size: 12px; cursor: pointer; }
        .inp-comercial { width: 290px; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; }
        .inp-comercial.cambiado { border-color: #d97706; background: #fffbeb; font-weight: 600; }

        /* ---------- Estructura global: menú lateral + páginas ---------- */
        .app { display: flex; gap: 20px; align-items: flex-start; }
        .sidebar { width: 240px; flex: 0 0 240px; background: #002d5b; color: #fff; border-radius: 8px; padding: 18px 0; position: sticky; top: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.08); }
        .sidebar .brand { padding: 2px 20px 16px; font-size: 22px; font-weight: 700; border-bottom: 1px solid rgba(255,255,255,0.12); margin-bottom: 8px; }
        .nav-grupo { padding: 16px 20px 6px; font-size: 11px; letter-spacing: 0.8px; color: #8fb0d6; text-transform: uppercase; }
        .nav-item { display: block; padding: 12px 20px; color: #cfe0f5; text-decoration: none; font-weight: 600; font-size: 14px; border-left: 4px solid transparent; }
        .nav-item:hover { background: rgba(255,255,255,0.08); color: #fff; }
        .nav-item.activo { background: rgba(255,255,255,0.14); color: #fff; border-left-color: #38bdf8; }
        .contenido { flex: 1; min-width: 0; }
        .bienvenida { background: #fff; border-radius: 8px; padding: 28px 30px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .bienvenida h1 { margin: 0 0 8px; font-size: 26px; color: #002d5b; }
        .bienvenida p { margin: 0; color: #64748b; font-size: 14px; }
        .tarjetas { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
        .tarjeta { display: block; background: #fff; border-radius: 8px; padding: 22px; text-decoration: none; color: inherit; box-shadow: 0 2px 4px rgba(0,0,0,0.05); border: 1px solid transparent; }
        .tarjeta:hover { border-color: #002d5b; }
        .tarjeta h3 { margin: 0 0 8px; font-size: 18px; color: #002d5b; }
        .tarjeta p { margin: 0; font-size: 13px; color: #64748b; }
        .vacio { background: #fff; border-radius: 8px; padding: 40px 30px; text-align: center; color: #64748b; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        @media (max-width: 800px) {
          .app { flex-direction: column; }
          .sidebar { width: auto; flex: none; position: static; align-self: stretch; }
        }
      </style>
    </head>
    <body>
      <div class="app">
        <!-- Menú lateral: Inicio, y debajo los módulos (Comercial primero, Cartera después) -->
        <aside class="sidebar">
          <div class="brand">📐 AutenTIC</div>
          <nav>
            <a class="nav-item activo" id="navInicio" href="#/inicio">🏠 Inicio</a>
            <div class="nav-grupo">Módulos</div>
            <a class="nav-item" id="navComercial" href="#/comercial/facturacion">💼 Módulo Comercial</a>
            <a class="nav-item" id="navCartera" href="#/cartera">💰 Módulo de Cartera</a>
          </nav>
        </aside>

        <div class="contenido">
          <!-- Página de inicio (punto de aterrizaje) -->
          <section id="pgInicio">
            <div class="bienvenida">
              <h1>Bienvenido a AutenTIC</h1>
              <p>Control de facturación y cartera de clientes. Elige un módulo para comenzar.</p>
            </div>
            <div class="tarjetas">
              <a class="tarjeta" href="#/comercial/facturacion">
                <h3>💼 Módulo Comercial</h3>
                <p>Facturación, ventas Wompi, consolidado, contratos y terceros.</p>
              </a>
              <a class="tarjeta" href="#/cartera">
                <h3>💰 Módulo de Cartera</h3>
                <p>Gestión de cartera.</p>
              </a>
            </div>
          </section>

          <!-- Módulo de Cartera -->
          <section id="pgCartera" style="display:none;">
            <div class="bienvenida">
              <h1>Módulo de Cartera</h1>
            </div>
            <div class="vacio">Este módulo todavía no tiene áreas de trabajo configuradas.</div>
          </section>

          <!-- Módulo Comercial: 5 áreas en pestañas -->
          <section id="pgComercial" style="display:none;">
      <div class="header">
        <div class="logo">💼 Módulo Comercial</div>
        <div class="kpi-box">
          <div class="kpi-title" id="kpiLabel">Valor Total Facturado (Bruto)</div>
          <div class="kpi-value" id="totalKPI">$ 0,00</div>
        </div>
      </div>

      <div class="filters-container" id="barraFiltros">
        <select id="selAno" class="server"></select>
        <select id="selMes" class="server"></select>
        <select id="filterCondicion"><option value="">CONDICIÓN (Todas)</option></select>
        <input type="text" id="filterCliente" class="buscar" placeholder="Buscar cliente por nombre o NIT..." onkeydown="if (event.key === 'Enter') buscarFacturacion()" />
        <select id="filterResponsable"><option value="">RESPONSABLE / COMERCIAL (Todos)</option></select>
        <select id="filterEmpresa"><option value="">EMPRESA (Todas)</option></select>
        <label class="chk"><input type="checkbox" id="chkNC" /> Ver facturas con nota crédito <span id="cntNC"></span></label>
        <button class="btn-small" id="btnBuscarFact" onclick="buscarFacturacion()">🔍 BUSCAR / ACTUALIZAR</button>
      </div>

      <div id="avisoEmpresas" class="aviso"></div>

      <div class="tabs">
        <button class="tab-btn active" id="btnFact" onclick="irA('comercial/facturacion')">FACTURACIÓN</button>
        <button class="tab-btn" id="btnWompi" onclick="irA('comercial/ventas-wompi')">VENTAS WOMPI</button>
        <button class="tab-btn" id="btnCons" onclick="irA('comercial/consolidado')">CONSOLIDADO</button>
        <button class="tab-btn" id="btnCont" onclick="irA('comercial/contratos')">CONTRATOS</button>
        <button class="tab-btn" id="btnTerc" onclick="irA('comercial/terceros')">TERCEROS</button>
      </div>

      <!-- Vista Facturación -->
      <div id="viewFacturacion">
        <div class="nota-vista">Ventas del periodo consultado, sin las de Wompi (esas están en VENTAS WOMPI). Elige los filtros y presiona BUSCAR / ACTUALIZAR.</div>
        <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>CLIENTE</th>
              <th>COMERCIAL</th>
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
              <th>NOTA CRÉDITO</th>
              <th>EMPRESA</th>
              <th>FORMA DE PAGO</th>
              <th>MÓDULO</th>
            </tr>
          </thead>
          <tbody id="tablaFacturas"></tbody>
        </table>
        </div>
      </div>

      <!-- Vista Ventas Wompi -->
      <div id="viewWompi" style="display:none;">
        <div class="filters-container" id="barraWompi">
          <select id="wAno" class="server"></select>
          <select id="wMes" class="server"></select>
          <select id="wDia" class="server"></select>
          <select id="wEmpresa"><option value="">EMPRESA (Todas)</option>${OPCIONES_EMPRESA}</select>
          <button class="btn-small" id="btnBuscarWompi" onclick="cargarWompi()">🔍 BUSCAR / ACTUALIZAR WOMPI</button>
        </div>
        <div class="nota-vista">
          Ventas cuya forma de pago corresponde a Wompi (contrapartida 138095) o a Cruce de vencimiento (facturas sin forma de pago). Si falta alguna o sobra otra, revisa las
          <a href="/api/formas-pago" target="_blank">formas de pago de Siigo</a>.
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
              <th>NOTA CRÉDITO</th>
                <th>EMPRESA</th>
                <th>FORMA DE PAGO</th>
              <th>MÓDULO</th>
              </tr>
            </thead>
            <tbody id="tablaWompi"></tbody>
          </table>
        </div>
      </div>

      <!-- Vista Consolidado -->
      <div id="viewConsolidado" style="display:none;">
        <div class="nota-vista">Valor bruto facturado por cliente y comercial, por mes, con los mismos filtros de Facturación (sin las ventas Wompi).</div>
        <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>CLIENTE</th>
              <th>COMERCIAL</th>
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
        <div class="nota-vista">Clientes de ambas empresas en Siigo. El comercial encargado que asignes queda guardado.</div>
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
        <form class="filters-container" onsubmit="guardarContrato(event)">
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
          <button type="submit" class="btn-small">+ REGISTRAR CONTRATO</button>
        </form>
        <div class="nota-vista">Registro de contratos por cliente.</div>

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

          </section>
        </div>
      </div>

      <script>
        let facturasGlobales = [];
        let tabActual = 'facturacion';
        let tercerosGlobales = [];
        let comerciales = [];
        const COMERCIALES_FIJOS = ${COMERCIALES_JSON};
        let recargarFacturas = false;
        let wompiGlobales = [];
        let periodoFact = null;   // { ano, mes } de la última búsqueda de Facturación
        let periodoWompi = null;  // { ano, mes } de la última búsqueda de Wompi
        const MSG_FACT = '<tr><td colspan="17" style="text-align:center;">Elige los filtros y presiona 🔍 BUSCAR / ACTUALIZAR.</td></tr>';
        const MSG_WOMPI = '<tr><td colspan="16" style="text-align:center;">Elige Año, Mes, Día y Empresa y presiona 🔍 BUSCAR / ACTUALIZAR WOMPI.</td></tr>';

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

        // Al volver a una pestaña no se consulta nada: se muestra lo ya cargado.
        // Si cambió la asignación de comerciales, solo se avisa para que el operador actualice.
        function refrescarFacturasSiHaceFalta() {
          aplicarFiltros();
          if (recargarFacturas && (facturasGlobales.length || wompiGlobales.length)) {
            const cont = document.getElementById('avisoEmpresas');
            cont.className = 'aviso';
            cont.innerHTML = 'Cambió la asignación de comerciales. Presiona <b>🔍 BUSCAR / ACTUALIZAR</b> para reflejarlo.';
          }
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

          // Filtros propios de Wompi: Año, Mes, Día y Empresa
          const wAno = document.getElementById('wAno');
          for (let y = hoy.getFullYear(); y >= 2022; y--) {
            wAno.innerHTML += '<option value="' + y + '">AÑO ' + y + '</option>';
          }
          const wMes = document.getElementById('wMes');
          wMes.innerHTML = '<option value="">MES (Todo el año)</option>';
          NOMBRES_MES.forEach(function (m, i) {
            wMes.innerHTML += '<option value="' + (i + 1) + '">' + m + '</option>';
          });
          wMes.value = String(hoy.getMonth() + 1);
          const wDia = document.getElementById('wDia');
          wDia.innerHTML = '<option value="">DÍA (Todos)</option>';
          for (let d = 1; d <= 31; d++) wDia.innerHTML += '<option value="' + d + '">DÍA ' + d + '</option>';

          poblarFiltros([]);
          document.getElementById('tablaFacturas').innerHTML = MSG_FACT;
          document.getElementById('tablaWompi').innerHTML = MSG_WOMPI;
        }

        // ¿La factura cae dentro del periodo consultado?
        function enPeriodo(f, per) {
          if (!per) return false;
          const ef = f.mesAsignado || String(f.fecha).slice(0, 7);
          return ef.slice(0, 4) === String(per.ano) && (!per.mes || Number(ef.slice(5, 7)) === Number(per.mes));
        }

        // Búsqueda de Facturación / Consolidado: consulta Siigo solo cuando el operador lo confirma
        async function cargarFacturas() {
          const ano = document.getElementById('selAno').value;
          const mes = document.getElementById('selMes').value;
          const btn = document.getElementById('btnBuscarFact');
          btn.disabled = true;
          document.getElementById('tablaFacturas').innerHTML = '<tr><td colspan="16" style="text-align:center;">Consultando Siigo...</td></tr>';
          let resumen = [];
          try {
            const res = await fetch('/api/facturas?ano=' + ano + (mes ? '&mes=' + mes : ''));
            const data = await res.json();
            facturasGlobales = data.facturas || [];
            resumen = data.resumen || [];
            periodoFact = { ano: ano, mes: mes };
            recargarFacturas = false;
          } catch (e) {
            facturasGlobales = [];
            periodoFact = null;
            resumen = [{ empresa: 'Servidor', error: 'No se pudo consultar /api/facturas' }];
          }
          btn.disabled = false;
          mostrarAviso(resumen, 'Facturas');
          poblarFiltros(facturasGlobales);
          aplicarFiltros();
        }

        // Botón BUSCAR / ACTUALIZAR: si cambió el año o el mes se consulta Siigo; si no, solo se aplican los filtros
        function buscarFacturacion() {
          const ano = document.getElementById('selAno').value;
          const mes = document.getElementById('selMes').value;
          const igual = periodoFact && periodoFact.ano === ano && periodoFact.mes === mes;
          if (igual && !recargarFacturas && facturasGlobales.length) { aplicarFiltros(); } else { cargarFacturas(); }
        }

        // Búsqueda exclusiva de Wompi: Año, Mes, Día y Empresa. Vuelve a leer Siigo sin caché.
        async function cargarWompi() {
          const ano = document.getElementById('wAno').value;
          const mes = document.getElementById('wMes').value;
          const btn = document.getElementById('btnBuscarWompi');
          btn.disabled = true;
          document.getElementById('tablaWompi').innerHTML = '<tr><td colspan="16" style="text-align:center;">Consultando Siigo...</td></tr>';
          let resumen = [];
          try {
            const res = await fetch('/api/facturas?ano=' + ano + (mes ? '&mes=' + mes : '') + '&refrescar=1&solo=wompi');
            const data = await res.json();
            wompiGlobales = data.facturas || [];
            resumen = data.resumen || [];
            periodoWompi = { ano: ano, mes: mes };
            recargarFacturas = false;
          } catch (e) {
            wompiGlobales = [];
            periodoWompi = null;
            resumen = [{ empresa: 'Servidor', error: 'No se pudo consultar /api/facturas' }];
          }
          btn.disabled = false;
          mostrarAviso(resumen, 'Ventas Wompi');
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
          document.getElementById('barraFiltros').style.display = (tab === 'facturacion' || tab === 'consolidado') ? 'flex' : 'none';

          if (tab === 'facturacion') {
            document.getElementById('kpiLabel').innerText = 'Valor Total Facturado (Bruto)';
            refrescarFacturasSiHaceFalta();
          } else if (tab === 'consolidado') {
            document.getElementById('kpiLabel').innerText = 'Total Consolidado (Bruto)';
            refrescarFacturasSiHaceFalta();
          } else if (tab === 'contratos') {
            document.getElementById('kpiLabel').innerText = 'Total Contratos Registrados';
            mostrarAviso([], '');
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
          const selR = document.getElementById('filterResponsable');
          const previoR = selR.value;
          poblarSelect('filterResponsable', COMERCIALES_FIJOS.concat(data.map(function (d) { return d.responsable; })), 'RESPONSABLE / COMERCIAL (Todos)');
          const o = document.createElement('option'); o.value = 'N/A'; o.textContent = 'SIN COMERCIAL';
          selR.appendChild(o);
          if (previoR === 'N/A') selR.value = 'N/A';
          poblarSelect('filterEmpresa', data.map(function (d) { return d.empresa; }), 'EMPRESA (Todas)');
        }

        function aplicarFiltros() {
          const fCond = document.getElementById('filterCondicion').value;
          const fCli = document.getElementById('filterCliente').value.trim().toUpperCase();
          const fResp = document.getElementById('filterResponsable').value;
          const fEmp = document.getElementById('filterEmpresa').value;
          // Las facturas con nota crédito se ocultan, salvo que se marque "Ver facturas con nota crédito"
          const verNC = document.getElementById('chkNC').checked;
          const nNC = facturasGlobales.filter(function (f) { return f.tieneNotaCredito; }).length;
          document.getElementById('cntNC').innerText = nNC ? '(' + nNC + (verNC ? ' visibles' : ' ocultas') + ')' : '';

          const filtradas = facturasGlobales.filter(function (f) {
            return (!fCond || f.condicion === fCond) &&
                   (!fCli || String(f.cliente).toUpperCase().indexOf(fCli) >= 0 || String(f.nit || '').indexOf(fCli) >= 0) &&
                   (!fResp || f.responsable === fResp) &&
                   (!fEmp || f.empresa === fEmp) &&
                   (verNC || !f.tieneNotaCredito);
          });

          // Facturación y Consolidado muestran todo menos las ventas Wompi; esas van en su pestaña
          const normales = filtradas.filter(function (f) { return !f.esWompi; }).sort(ordenarFacturas);

          if (tabActual === 'facturacion') {
            if (!periodoFact) { document.getElementById('tablaFacturas').innerHTML = MSG_FACT; document.getElementById('totalKPI').innerText = fmt(0); }
            else renderFacturas(normales, 'tablaFacturas');
          } else if (tabActual === 'wompi') {
            // Wompi usa solo Año y Mes (en la consulta), Día y Empresa; las notas crédito siempre se ocultan
            const wDia = document.getElementById('wDia').value;
            const wEmp = document.getElementById('wEmpresa').value;
            const wompi = wompiGlobales.filter(function (f) {
              return f.esWompi && !f.tieneNotaCredito &&
                     (!wEmp || f.empresa === wEmp) &&
                     (!wDia || Number(String(f.fecha).slice(8, 10)) === Number(wDia));
            }).sort(ordenarFacturas);
            if (!periodoWompi) { document.getElementById('tablaWompi').innerHTML = MSG_WOMPI; document.getElementById('totalKPI').innerText = fmt(0); }
            else renderFacturas(wompi, 'tablaWompi');
          } else if (tabActual === 'consolidado') {
            if (!periodoFact) { document.getElementById('tablaConsolidado').innerHTML = MSG_FACT; document.getElementById('totalKPI').innerText = fmt(0); }
            else renderConsolidado(normales);
          }
        }

        // Busca una factura en cualquiera de las dos listas cargadas
        function buscarFactura(empId, id) {
          const mismo = function (x) { return String(x.empresaId) === empId && String(x.id) === id; };
          return facturasGlobales.find(mismo) || wompiGlobales.find(mismo);
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

        // Celda MÓDULO: selector para decidir si la factura va en Facturación o en Ventas Wompi
        function celdaModulo(f) {
          if (!f.id || f.empresaId === undefined) return '-';
          const actual = f.esWompi ? 'WOMPI' : 'FACTURACION';
          const cambiado = !!f.moduloAsignado;
          return '<select class="sel-mes' + (cambiado ? ' cambiado' : '') + '" data-emp="' + esc(f.empresaId) + '" data-id="' + esc(f.id) + '" ' +
            'title="' + (cambiado ? 'Módulo elegido manualmente' : 'Clasificación automática según la forma de pago') + '" onchange="cambiarModulo(this)">' +
            '<option value="FACTURACION"' + (actual === 'FACTURACION' ? ' selected' : '') + '>FACTURACIÓN</option>' +
            '<option value="WOMPI"' + (actual === 'WOMPI' ? ' selected' : '') + '>WOMPI</option></select>';
        }

        async function cambiarModulo(sel) {
          const empId = sel.getAttribute('data-emp');
          const id = sel.getAttribute('data-id');
          const f = buscarFactura(empId, id);
          if (!f) return;
          const nuevo = sel.value;
          const previo = f.esWompi ? 'WOMPI' : 'FACTURACION';
          // Si lo elegido coincide con la clasificación automática, se quita la elección manual
          const valor = nuevo === (f.esWompiAuto ? 'WOMPI' : 'FACTURACION') ? '' : nuevo;
          sel.disabled = true;
          try {
            const res = await fetch('/api/facturas/' + encodeURIComponent(empId) + '/' + encodeURIComponent(id) + '/modulo', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ modulo: valor })
            });
            if (!res.ok) throw new Error('fallo');
            f.moduloAsignado = valor;
            f.esWompi = nuevo === 'WOMPI';
            // La factura pasa a la lista del módulo elegido si ese periodo ya está consultado
            if (f.esWompi && wompiGlobales.indexOf(f) < 0 && enPeriodo(f, periodoWompi)) wompiGlobales.push(f);
            if (!f.esWompi && facturasGlobales.indexOf(f) < 0 && enPeriodo(f, periodoFact)) facturasGlobales.push(f);
            aplicarFiltros();
            const cont = document.getElementById('avisoEmpresas');
            cont.className = 'aviso';
            cont.innerHTML = 'Factura <b>' + esc(f.numero) + '</b> movida a <b>' + (f.esWompi ? 'Ventas Wompi' : 'Facturación') + '</b>.';
          } catch (e) {
            sel.value = previo;
            alert('No se pudo guardar el módulo de la factura');
          }
          sel.disabled = false;
        }

        async function cambiarMes(sel) {
          const empId = sel.getAttribute('data-emp');
          const id = sel.getAttribute('data-id');
          const f = buscarFactura(empId, id);
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
            const enWompi = wompiGlobales.indexOf(f) >= 0;
            const dentro = enPeriodo(f, enWompi ? periodoWompi : periodoFact);
            if (!dentro) {
              facturasGlobales = facturasGlobales.filter(function (x) { return x !== f; });
              wompiGlobales = wompiGlobales.filter(function (x) { return x !== f; });
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

        // Comercial en texto (Consolidado)
        function celdaComercial(f) {
          return (!f.responsable || f.responsable === 'N/A') ? '<span style="color:#94a3b8;">SIN COMERCIAL</span>' : esc(f.responsable);
        }

        // Comercial de la factura: por defecto el del cliente (Terceros); se puede cambiar solo en esta factura
        function celdaComercialFactura(f) {
          if (!f.id || f.empresaId === undefined) return celdaComercial(f);
          const porCliente = (!f.comercialCliente || f.comercialCliente === 'N/A') ? 'SIN COMERCIAL' : f.comercialCliente;
          const cambiado = !!f.comercialFactura;
          const lista = COMERCIALES_FIJOS.slice();
          if (cambiado && f.comercialFactura !== 'SIN COMERCIAL' && lista.indexOf(f.comercialFactura) < 0) lista.push(f.comercialFactura);
          return '<select class="inp-comercial' + (cambiado ? ' cambiado' : '') + '" data-emp="' + esc(f.empresaId) + '" data-id="' + esc(f.id) + '" ' +
            'title="' + (cambiado ? 'Comercial elegido solo para esta factura' : 'Comercial del cliente (Terceros). Puedes cambiarlo solo para esta factura.') + '" onchange="cambiarComercial(this)">' +
            '<option value=""' + (cambiado ? '' : ' selected') + '>' + (porCliente === 'SIN COMERCIAL' ? '— SIN COMERCIAL —' : esc(porCliente) + ' (cliente)') + '</option>' +
            lista.map(function (n) { return '<option value="' + esc(n) + '"' + (cambiado && n === f.comercialFactura ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') +
            (porCliente === 'SIN COMERCIAL' ? '' : '<option value="SIN COMERCIAL"' + (f.comercialFactura === 'SIN COMERCIAL' ? ' selected' : '') + '>— SIN COMERCIAL —</option>') +
            '</select>';
        }

        async function cambiarComercial(sel) {
          const empId = sel.getAttribute('data-emp');
          const id = sel.getAttribute('data-id');
          const f = buscarFactura(empId, id);
          if (!f) return;
          const valor = sel.value;
          sel.disabled = true;
          try {
            const res = await fetch('/api/facturas/' + encodeURIComponent(empId) + '/' + encodeURIComponent(id) + '/comercial', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ comercial: valor })
            });
            if (!res.ok) throw new Error('fallo');
            f.comercialFactura = valor;
            f.responsable = valor === 'SIN COMERCIAL' ? 'N/A' : (valor || f.comercialCliente);
            aplicarFiltros();
            const cont = document.getElementById('avisoEmpresas');
            cont.className = 'aviso';
            cont.innerHTML = 'Factura <b>' + esc(f.numero) + '</b>: comercial <b>' + esc(valor || ((f.comercialCliente === 'N/A' ? 'SIN COMERCIAL' : f.comercialCliente) + ' (del cliente)')) + '</b>.';
          } catch (e) {
            sel.value = f.comercialFactura || '';
            alert('No se pudo guardar el comercial de la factura');
          }
          sel.disabled = false;
        }

        // Valor bruto en pesos; si la factura es en moneda extranjera se indica con la tasa usada
        function celdaValor(f) {
          const base = '<b>' + fmt(f.valor) + '</b>';
          if (!f.moneda || f.moneda === 'COP') return base;
          if (f.sinTasaCambio) return base + ' <span title="Factura en ' + esc(f.moneda) + ' sin tasa de cambio en Siigo: el valor puede estar en ' + esc(f.moneda) + '" style="color:#dc2626;font-size:11px;">⚠ ' + esc(f.moneda) + '</span>';
          return base + ' <span title="' + esc(f.moneda) + ' ' + Number(f.valorMonedaOriginal || 0).toLocaleString('es-CO') + ' x tasa ' + Number(f.tasaCambio).toLocaleString('es-CO') + '" style="color:#0369a1;font-size:11px;">' + esc(f.moneda) + '→COP</span>';
        }

        function renderFacturas(data, destino) {
          let html = '';
          let total = 0;
          data.forEach(function (f) {
            total += f.valor;
            const badgeClass = f.condicion === 'PENDIENTE' ? 'badge-pendiente' : 'badge-pagado';
            html += '<tr>' +
              '<td><b>' + f.cliente + '</b></td>' +
              (destino === 'tablaFacturas' ? '<td>' + celdaComercialFactura(f) + '</td>' : '') +
              '<td>' + (f.nit || '-') + '</td>' +
              '<td>' + celdaMes(f) + '</td>' +
              '<td title="' + esc(f.observaciones || '') + '">' + esc(f.consumo || '-') + '</td>' +
              '<td>' + f.numero + '</td>' +
              '<td>' + f.fecha + '</td>' +
              '<td>' + f.vencimiento + '</td>' +
              '<td><span class="' + badgeClass + '">' + f.condicion + '</span></td>' +
              '<td>' + f.fechaPago + '</td>' +
              '<td>' + celdaValor(f) + '</td>' +
              '<td>' + fmt(f.total) + '</td>' +
              '<td>' + fmt(f.saldo) + '</td>' +
              '<td title="' + esc(f.notasCredito || '') + '">' + (f.tieneNotaCredito ? fmt(f.notaCredito) : '-') + '</td>' +
              '<td>' + f.empresa + '</td>' +
              '<td>' + esc(f.formaPago || '-') + '</td>' +
              '<td>' + celdaModulo(f) + '</td>' +
              '</tr>';
          });
          document.getElementById(destino || 'tablaFacturas').innerHTML = html || '<tr><td colspan="16" style="text-align:center;">Sin datos</td></tr>';
          document.getElementById('totalKPI').innerText = fmt(total);
        }

        function renderConsolidado(data) {
          const mapa = {};
          const comerciales_c = {};
          let totalGeneral = 0;

          data.forEach(function (f) {
            const clave = f.cliente + '||' + (f.responsable || 'N/A');
            if (!mapa[clave]) { mapa[clave] = Array(12).fill(0); comerciales_c[clave] = { cliente: f.cliente, responsable: f.responsable }; }
            // Si el mes asignado cae en otro año, se deja en el mes real de la factura para no perder el valor
            const anoSel = periodoFact ? String(periodoFact.ano) : document.getElementById('selAno').value;
            const idx =(f.anoMes === undefined || String(f.anoMes) === anoSel) ? f.numMes : f.numMesFactura;
            mapa[clave][idx] += f.valor;
            totalGeneral += f.valor;
          });

          let html = '';
          Object.keys(mapa).forEach(function (clave) {
            const meses = mapa[clave];
            const totalCliente = meses.reduce(function (a, b) { return a + b; }, 0);
            html += '<tr><td><b>' + comerciales_c[clave].cliente + '</b></td>' +
              '<td>' + celdaComercial({ responsable: comerciales_c[clave].responsable }) + '</td>' +
              meses.map(function (m) { return '<td>' + (m > 0 ? fmt(m) : '-') + '</td>'; }).join('') +
              '<td><b>' + fmt(totalCliente) + '</b></td></tr>';
          });

          document.getElementById('tablaConsolidado').innerHTML = html || '<tr><td colspan="15" style="text-align:center;">Sin datos</td></tr>';
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

        // ---------- Rutas: #/inicio, #/comercial/<área>, #/cartera ----------
        const AREAS_COMERCIAL = { 'facturacion': 'facturacion', 'ventas-wompi': 'wompi', 'consolidado': 'consolidado', 'contratos': 'contratos', 'terceros': 'terceros' };

        function irA(ruta) { location.hash = '#/' + ruta; }

        function mostrarRuta() {
          let ruta = location.hash || '';
          if (ruta.charAt(0) === '#') ruta = ruta.slice(1);
          if (ruta.charAt(0) === '/') ruta = ruta.slice(1);
          const partes = ruta.split('/');
          let pagina = partes[0] || 'inicio';
          if (pagina !== 'comercial' && pagina !== 'cartera') pagina = 'inicio';

          document.getElementById('pgInicio').style.display = pagina === 'inicio' ? 'block' : 'none';
          document.getElementById('pgComercial').style.display = pagina === 'comercial' ? 'block' : 'none';
          document.getElementById('pgCartera').style.display = pagina === 'cartera' ? 'block' : 'none';
          document.getElementById('navInicio').classList.toggle('activo', pagina === 'inicio');
          document.getElementById('navComercial').classList.toggle('activo', pagina === 'comercial');
          document.getElementById('navCartera').classList.toggle('activo', pagina === 'cartera');

          if (pagina === 'comercial') {
            const tab = AREAS_COMERCIAL[partes[1]] || 'facturacion';
            // Siigo no se consulta al entrar: solo cuando el operador presiona BUSCAR / ACTUALIZAR
            switchTab(tab);
          }
        }

        window.addEventListener('hashchange', mostrarRuta);
        mostrarRuta();
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor AutenTIC corriendo en el puerto ${PORT}`);
});