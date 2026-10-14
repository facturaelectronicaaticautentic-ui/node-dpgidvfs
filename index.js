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
let asignaciones = {};
try { asignaciones = JSON.parse(fs.readFileSync(ARCHIVO_ASIGNACIONES, 'utf8')); } catch (e) { asignaciones = {}; }
function guardarAsignaciones() {
  try { fs.writeFileSync(ARCHIVO_ASIGNACIONES, JSON.stringify(asignaciones, null, 2)); }
  catch (e) { console.error('No se pudo guardar asignaciones.json:', e.message); }
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
  const res = await siigoClient.post('/auth', {
    username: empresa.user,
    access_key: empresa.key
  });
  tokens.set(empresa.id, { token: res.data.access_token, exp: Date.now() + 23 * 60 * 60 * 1000 });
  return res.data.access_token;
}

// GET con reintentos ante límite de velocidad (429) o errores 5xx
async function siigoGet(url, params, token, intentos = 3) {
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await siigoClient.get(url, { params, headers: { Authorization: token } });
      return r.data;
    } catch (e) {
      const status = e.response && e.response.status;
      if ((status === 429 || status >= 500) && i < intentos - 1) {
        await sleep(1500 * (i + 1));
        continue;
      }
      throw e;
    }
  }
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

async function resolverClientes(emp, token, facturas) {
  const ids = [...new Set(facturas.map(f => f.customer && f.customer.id).filter(Boolean))];
  const pendientes = ids.filter(id => !clientesCache.has(`${emp.id}:${id}`));
  for (let i = 0; i < pendientes.length; i += 5) {
    await Promise.all(pendientes.slice(i, i + 5).map(async (id) => {
      try {
        const c = await siigoGet(`/v1/customers/${id}`, {}, token);
        const nombre = nombreDeCliente(c);
        if (nombre) clientesCache.set(`${emp.id}:${id}`, nombre);
      } catch (e) {
        console.error(`[${emp.nombre}] No se pudo leer el cliente ${id}:`, e.response ? e.response.status : e.message);
      }
    }));
  }
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

async function facturasDeEmpresa(emp, desde, hasta) {
  const token = await getToken(emp);
  if (!token) return [];
  const facturas = await traerFacturas(token, desde, hasta);
  await resolverClientes(emp, token, facturas);

  return facturas.map(f => {
    const c = f.customer || {};
    // Se lee año/mes directo del texto "YYYY-MM-DD" para evitar el desfase de zona horaria
    const [y, m] = String(f.date).split('-');
    const numMes = Number(m) - 1;
    const nit = c.identification || '';
    const nombre = clientesCache.get(`${emp.id}:${c.id}`) || nombreDeCliente(c) || (nit ? `CLIENTE (${nit})` : 'N/A');
    const saldo = Number(f.balance) || 0;
    const seller = f.seller;

    return {
      id: f.id,
      cliente: nombre.toUpperCase(),
      nit,
      mes: MESES[numMes] || '',
      numMes,
      ano: y,
      numero: f.name || f.id,
      fecha: f.date,
      vencimiento: f.payments && f.payments[0] ? f.payments[0].due_date || '-' : '-',
      condicion: saldo > 0 ? 'PENDIENTE' : 'PAGADO',
      fechaPago: saldo === 0 ? f.date : '-',
      responsable: asignaciones[String(nit).trim()] || (seller ? (seller.name || `${seller.first_name || ''} ${seller.last_name || ''}`.trim() || String(seller)) : 'N/A'),
      valor: valorBruto(f),
      total: Number(f.total) || 0,
      saldo,
      empresa: emp.nombre
    };
  });
}

// GET /api/facturas?ano=2026&mes=10   (mes opcional: 1-12; sin mes trae todo el año)
app.get('/api/facturas', async (req, res) => {
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
      const facturas = await facturasDeEmpresa(emp, desde, hasta);
      return { empresa: emp.nombre, facturas, error: null };
    } catch (e) {
      const error = describirError(e);
      console.error(`[${emp.nombre}] Error consultando Siigo:`, error);
      return { empresa: emp.nombre, facturas: [], error };
    }
  }));

  const facturas = resultados.flatMap(r => r.facturas).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  res.json({
    facturas,
    resumen: resultados.map(r => ({ empresa: r.empresa, cantidad: r.facturas.length, error: r.error }))
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

async function traerTerceros(emp) {
  const token = await getToken(emp);
  if (!token) return [];
  const todos = [];
  let page = 1;
  let total = Infinity;
  while (todos.length < total) {
    const data = await siigoGet('/v1/customers', { page, page_size: 100 }, token);
    const results = data.results || [];
    total = data.pagination && data.pagination.total_results != null ? data.pagination.total_results : results.length;
    todos.push(...results);
    if (results.length === 0) break;
    page++;
  }
  return todos.map(c => mapearTercero(emp, c));
}

function aplicarAsignaciones(base) {
  return base.map(t => ({ ...t, comercial: asignaciones[t.nit] || '' }));
}

// GET /api/terceros            (usa caché de 10 min)
// GET /api/terceros?refrescar=1 (vuelve a leer Siigo)
app.get('/api/terceros', async (req, res) => {
  const vigente = Date.now() - tercerosCache.ts < 10 * 60 * 1000;
  if (!req.query.refrescar && vigente) {
    return res.json({ terceros: aplicarAsignaciones(tercerosCache.base), resumen: tercerosCache.resumen });
  }

  const resultados = await Promise.all(empresas.map(async (emp) => {
    if (!emp.user || !emp.key) {
      return { empresa: emp.nombre, terceros: [], error: `Faltan credenciales (EMPRESA${emp.id}_USER / EMPRESA${emp.id}_KEY) en el .env` };
    }
    try {
      return { empresa: emp.nombre, terceros: await traerTerceros(emp), error: null };
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
  res.json({ terceros: aplicarAsignaciones(base), resumen });
});

// PUT /api/terceros/:nit/comercial   body: { comercial: "NOMBRE" }  (vacío = quitar asignación)
app.put('/api/terceros/:nit/comercial', (req, res) => {
  const nit = String(req.params.nit || '').trim();
  const comercial = String((req.body && req.body.comercial) || '').trim().toUpperCase();
  if (!nit) return res.status(400).json({ success: false, error: 'NIT requerido' });
  if (comercial) asignaciones[nit] = comercial;
  else delete asignaciones[nit];
  guardarAsignaciones();
  res.json({ success: true });
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
        .aviso.aviso-error { background: #fef2f2; color: #b91c1c; }
        .filters-container input.buscar { flex: 2; min-width: 220px; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; }
        .btn-small { background: #002d5b; color: white; border: none; padding: 8px 14px; border-radius: 6px; font-weight: bold; font-size: 12px; cursor: pointer; }
        .inp-comercial { width: 200px; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; }
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
              <th>No FRA</th>
              <th>FECHA</th>
              <th>VENCIMIENTO</th>
              <th>CONDICIÓN</th>
              <th>FECHA DE PAGO</th>
              <th>VALOR BRUTO</th>
              <th>TOTAL</th>
              <th>SALDO</th>
              <th>EMPRESA</th>
            </tr>
          </thead>
          <tbody id="tablaFacturas"></tbody>
        </table>
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
        <datalist id="listaComerciales"></datalist>
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
        let recargarFacturas = false;

        function esc(s) {
          return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function mostrarAviso(resumen, etiqueta) {
          const cont = document.getElementById('avisoEmpresas');
          if (!resumen || !resumen.length) { cont.className = 'aviso'; cont.innerHTML = ''; return; }
          const hayError = resumen.some(function (r) { return r.error; });
          cont.className = 'aviso' + (hayError ? ' aviso-error' : '');
          cont.innerHTML = '<b>' + esc(etiqueta) + ' →</b> ' + resumen.map(function (r) {
            return '<b>' + esc(r.empresa) + ':</b> ' + (r.error ? '⚠ ' + esc(r.error) : r.cantidad + ' registros');
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

        async function cargarFacturas() {
          const ano = document.getElementById('selAno').value;
          const mes = document.getElementById('selMes').value;
          document.getElementById('tablaFacturas').innerHTML = '<tr><td colspan="12" style="text-align:center;">Consultando Siigo...</td></tr>';
          let resumen = [];
          try {
            const res = await fetch('/api/facturas?ano=' + ano + (mes ? '&mes=' + mes : ''));
            const data = await res.json();
            facturasGlobales = data.facturas || [];
            resumen = data.resumen || [];
          } catch (e) {
            facturasGlobales = [];
            resumen = [{ empresa: 'Servidor', error: 'No se pudo consultar /api/facturas' }];
          }
          mostrarAviso(resumen, 'Facturas');
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

          if (tabActual === 'facturacion') {
            renderFacturas(filtradas);
          } else if (tabActual === 'consolidado') {
            renderConsolidado(filtradas);
          }
        }

        function fmt(n) { return '$ ' + Number(n || 0).toLocaleString('es-CO'); }

        function renderFacturas(data) {
          let html = '';
          let total = 0;
          data.forEach(function (f) {
            total += f.valor;
            const badgeClass = f.condicion === 'PENDIENTE' ? 'badge-pendiente' : 'badge-pagado';
            html += '<tr>' +
              '<td><b>' + f.cliente + '</b></td>' +
              '<td>' + (f.nit || '-') + '</td>' +
              '<td>' + f.mes + '</td>' +
              '<td>' + f.numero + '</td>' +
              '<td>' + f.fecha + '</td>' +
              '<td>' + f.vencimiento + '</td>' +
              '<td><span class="' + badgeClass + '">' + f.condicion + '</span></td>' +
              '<td>' + f.fechaPago + '</td>' +
              '<td><b>' + fmt(f.valor) + '</b></td>' +
              '<td>' + fmt(f.total) + '</td>' +
              '<td>' + fmt(f.saldo) + '</td>' +
              '<td>' + f.empresa + '</td>' +
              '</tr>';
          });
          document.getElementById('tablaFacturas').innerHTML = html || '<tr><td colspan="12" style="text-align:center;">Sin datos</td></tr>';
          document.getElementById('totalKPI').innerText = fmt(total);
        }

        function renderConsolidado(data) {
          const mapa = {};
          let totalGeneral = 0;

          data.forEach(function (f) {
            if (!mapa[f.cliente]) mapa[f.cliente] = Array(12).fill(0);
            mapa[f.cliente][f.numMes] += f.valor;
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
            const res = await fetch('/api/terceros' + (refrescar ? '?refrescar=1' : ''));
            const data = await res.json();
            tercerosGlobales = data.terceros || [];
            mostrarAviso(data.resumen || [], 'Terceros');
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

        function poblarComerciales() {
          const nombres = {};
          tercerosGlobales.forEach(function (t) { if (t.comercial) nombres[t.comercial] = true; });
          facturasGlobales.forEach(function (f) { if (f.responsable && f.responsable !== 'N/A') nombres[f.responsable.toUpperCase()] = true; });
          document.getElementById('listaComerciales').innerHTML = Object.keys(nombres).sort().map(function (n) {
            return '<option value="' + esc(n) + '"></option>';
          }).join('');
        }

        function filtrarTerceros() {
          const q = document.getElementById('tBuscar').value.trim().toUpperCase();
          const fEmp = document.getElementById('tEmpresa').value;
          const fAsig = document.getElementById('tAsignacion').value;
          const lista = tercerosGlobales.filter(function (t) {
            return (!q || t.nombre.toUpperCase().indexOf(q) >= 0 || t.nit.indexOf(q) >= 0) &&
                   (!fEmp || t.empresas.indexOf(fEmp) >= 0) &&
                   (!fAsig || (fAsig === 'SIN' ? !t.comercial : !!t.comercial));
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
              '<td><input type="text" class="inp-comercial" list="listaComerciales" data-nit="' + esc(t.nit) + '" value="' + esc(t.comercial || '') + '" placeholder="Asignar comercial..." onchange="asignarComercial(this)" /></td>' +
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