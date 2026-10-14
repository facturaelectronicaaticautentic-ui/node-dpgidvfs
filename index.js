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
      responsable: seller ? (seller.name || `${seller.first_name || ''} ${seller.last_name || ''}`.trim() || String(seller)) : 'N/A',
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
    return res.json([
      { cliente: 'YOBANY ALBERTO LOPEZ QUINTERO', nit: '', mes: 'ENERO', numMes: 0, ano: '2026', numero: '14201', fecha: '2026-01-15', vencimiento: '-', condicion: 'PAGADO', fechaPago: '2026-01-20', responsable: 'JUAN PEREZ', valor: 10921780, total: 10921780, saldo: 0, empresa: 'Empresa 1' },
      { cliente: 'INTELCOST SAS', nit: '', mes: 'OCTUBRE', numMes: 9, ano: '2026', numero: '14531', fecha: '2026-10-01', vencimiento: '-', condicion: 'PENDIENTE', fechaPago: '-', responsable: 'MARIA GOMEZ', valor: 3450000, total: 3450000, saldo: 3450000, empresa: 'Empresa 1' }
    ]);
  }

  const resultados = await Promise.all(conCredenciales.map(async (emp) => {
    try {
      return await facturasDeEmpresa(emp, desde, hasta);
    } catch (e) {
      console.error(`[${emp.nombre}] Error consultando Siigo:`, e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message);
      return [];
    }
  }));

  const todas = resultados.flat().sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  res.json(todas);
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

      <div class="tabs">
        <button class="tab-btn active" id="btnFact" onclick="switchTab('facturacion')">FACTURACIÓN</button>
        <button class="tab-btn" id="btnCons" onclick="switchTab('consolidado')">CONSOLIDADO</button>
        <button class="tab-btn" id="btnCont" onclick="switchTab('contratos')">CONTRATOS</button>
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
          try {
            const res = await fetch('/api/facturas?ano=' + ano + (mes ? '&mes=' + mes : ''));
            facturasGlobales = await res.json();
          } catch (e) {
            facturasGlobales = [];
          }
          poblarFiltros(facturasGlobales);
          if (tabActual === 'contratos') return;
          aplicarFiltros();
        }

        function switchTab(tab) {
          tabActual = tab;
          document.getElementById('btnFact').classList.toggle('active', tab === 'facturacion');
          document.getElementById('btnCons').classList.toggle('active', tab === 'consolidado');
          document.getElementById('btnCont').classList.toggle('active', tab === 'contratos');

          document.getElementById('viewFacturacion').style.display = tab === 'facturacion' ? 'block' : 'none';
          document.getElementById('viewConsolidado').style.display = tab === 'consolidado' ? 'block' : 'none';
          document.getElementById('viewContratos').style.display = tab === 'contratos' ? 'block' : 'none';
          document.getElementById('barraFiltros').style.display = tab === 'contratos' ? 'none' : 'flex';

          if (tab === 'facturacion') {
            document.getElementById('kpiLabel').innerText = 'Valor Total Facturado (Bruto)';
            aplicarFiltros();
          } else if (tab === 'consolidado') {
            document.getElementById('kpiLabel').innerText = 'Total Consolidado (Bruto)';
            aplicarFiltros();
          } else if (tab === 'contratos') {
            document.getElementById('kpiLabel').innerText = 'Total Contratos Registrados';
            cargarContratos();
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