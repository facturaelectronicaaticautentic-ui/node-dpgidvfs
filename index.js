require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const empresas = [
  {
    id: 1,
    nombre: process.env.EMPRESA1_NOMBRE || 'Empresa 1',
    user: process.env.EMPRESA1_USER,
    key: process.env.EMPRESA1_KEY,
  },
  {
    id: 2,
    nombre: process.env.EMPRESA2_NOMBRE || 'Empresa 2',
    user: process.env.EMPRESA2_USER,
    key: process.env.EMPRESA2_KEY,
  },
];

const siigoClient = axios.create({
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'Partner-Id': 'PortalAutenTIC',
  },
});

// Base de datos temporal en memoria para Contratos
let contratosBD = [
  {
    id: 1,
    cliente: 'INTELCOST SAS',
    valor: 15000000,
    fechaInicio: '2026-01-01',
    fechaFin: '2026-12-31',
    estado: 'ACTIVO',
    responsable: 'MARIA GOMEZ',
  },
  {
    id: 2,
    cliente: 'VISION Y MARKETING SAS',
    valor: 8500000,
    fechaInicio: '2026-03-01',
    fechaFin: '2026-09-30',
    estado: 'FINALIZADO',
    responsable: 'CARLOS RUIZ',
  },
];

async function getToken(empresa) {
  if (!empresa.user || !empresa.key) return null;
  try {
    const res = await siigoClient.post('https://api.siigo.com/auth', {
      username: empresa.user,
      access_key: empresa.key,
    });
    return res.data.access_token;
  } catch (err) {
    return null;
  }
}

// Endpoint de Facturas
app.get('/api/facturas', async (req, res) => {
  let todasLasFacturas = [];

  for (const emp of empresas) {
    const token = await getToken(emp);
    if (token) {
      try {
        const respuesta = await siigoClient.get(
          'https://api.siigo.com/v1/invoices?page=1&page_size=100',
          {
            headers: { Authorization: token },
          }
        );
        const facturas = (respuesta.data.results || []).map((f) => {
          const fechaObj = new Date(f.date);
          return {
            cliente: f.customer
              ? f.customer.full_name || f.customer.name || 'N/A'
              : 'N/A',
            mes: fechaObj
              .toLocaleString('es-ES', { month: 'long' })
              .toUpperCase(),
            numMes: fechaObj.getMonth(),
            ano: fechaObj.getFullYear().toString(),
            numero: f.name || f.id,
            fecha: f.date,
            condicion: f.balance > 0 ? 'PENDIENTE' : 'PAGADO',
            fechaPago: f.balance === 0 ? f.date : '-',
            responsable: f.seller ? f.seller.name : 'N/A',
            valor: f.total || 0,
            empresa: emp.nombre,
          };
        });
        todasLasFacturas = todasLasFacturas.concat(facturas);
      } catch (e) {}
    }
  }

  // Datos demo
  if (todasLasFacturas.length === 0) {
    todasLasFacturas = [
      {
        cliente: 'YOBANY ALBERTO LOPEZ QUINTERO',
        mes: 'ENERO',
        numMes: 0,
        ano: '2026',
        numero: '14201',
        fecha: '2026-01-15',
        condicion: 'PAGADO',
        fechaPago: '2026-01-20',
        responsable: 'JUAN PEREZ',
        valor: 10921780,
        empresa: 'Empresa 1',
      },
      {
        cliente: 'CENTRAL DE ARRENDAMIENTOS INVESTIGACIONES Y COBRANZAS',
        mes: 'SEPTIEMBRE',
        numMes: 8,
        ano: '2026',
        numero: '14548',
        fecha: '2026-10-01',
        condicion: 'PENDIENTE',
        fechaPago: '-',
        responsable: 'JUAN PEREZ',
        valor: 6713500,
        empresa: 'Empresa 1',
      },
      {
        cliente: 'INTELCOST SAS',
        mes: 'OCTUBRE',
        numMes: 9,
        ano: '2026',
        numero: '14531',
        fecha: '2026-10-01',
        condicion: 'PENDIENTE',
        fechaPago: '-',
        responsable: 'MARIA GOMEZ',
        valor: 3450000,
        empresa: 'Empresa 1',
      },
      {
        cliente: 'ADMINISTRADORA CLINICA LA COLINA SAS',
        mes: 'AGOSTO',
        numMes: 7,
        ano: '2026',
        numero: '14530',
        fecha: '2026-10-01',
        condicion: 'PENDIENTE',
        fechaPago: '-',
        responsable: 'JUAN PEREZ',
        valor: 1703286,
        empresa: 'Empresa 2',
      },
      {
        cliente: 'VISION Y MARKETING SAS',
        mes: 'SEPTIEMBRE',
        numMes: 8,
        ano: '2026',
        numero: '14452',
        fecha: '2026-09-24',
        condicion: 'PAGADO',
        fechaPago: '2026-09-28',
        responsable: 'CARLOS RUIZ',
        valor: 3500000,
        empresa: 'Empresa 2',
      },
    ];
  }

  res.json(todasLasFacturas);
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
          <div class="kpi-title" id="kpiLabel">Valor Total Facturado</div>
          <div class="kpi-value" id="totalKPI">$ 0,00</div>
        </div>
      </div>

      <div class="filters-container" id="barraFiltros">
        <select id="filterCondicion" onchange="aplicarFiltros()"><option value="">CONDICIÓN (Todas)</option></select>
        <select id="filterCliente" onchange="aplicarFiltros()"><option value="">CLIENTE (Todos)</option></select>
        <select id="filterMes" onchange="aplicarFiltros()"><option value="">MES (Todos)</option></select>
        <select id="filterAno" onchange="aplicarFiltros()"><option value="">AÑO (Todos)</option></select>
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
              <th>MES</th>
              <th>No FRA</th>
              <th>FECHA</th>
              <th>CONDICIÓN</th>
              <th>FECHA DE PAGO</th>
              <th>VALOR</th>
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
              <th>TOTAL</th>
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

        async function cargarFacturas() {
          const res = await fetch('/api/facturas');
          facturasGlobales = await res.json();
          poblarFiltros(facturasGlobales);
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
            document.getElementById('kpiLabel').innerText = 'Valor Total Facturado';
            aplicarFiltros();
          } else if (tab === 'consolidado') {
            document.getElementById('kpiLabel').innerText = 'Total Consolidado';
            renderConsolidado(facturasGlobales);
          } else if (tab === 'contratos') {
            document.getElementById('kpiLabel').innerText = 'Total Contratos Registrados';
            cargarContratos();
          }
        }

        function poblarSelect(idSelect, valores, titulo) {
          const sel = document.getElementById(idSelect);
          sel.innerHTML = \`<option value="">\${titulo}</option>\`;
          [...new Set(valores)].sort().forEach(v => {
            if(v && v !== 'N/A') sel.innerHTML += \`<option value="\${v}">\${v}</option>\`;
          });
        }

        function poblarFiltros(data) {
          poblarSelect('filterCondicion', data.map(d => d.condicion), 'CONDICIÓN (Todas)');
          poblarSelect('filterCliente', data.map(d => d.cliente), 'CLIENTE (Todos)');
          poblarSelect('filterMes', data.map(d => d.mes), 'MES (Todos)');
          poblarSelect('filterAno', data.map(d => d.ano), 'AÑO (Todos)');
          poblarSelect('filterResponsable', data.map(d => d.responsable), 'RESPONSABLE (Todos)');
          poblarSelect('filterEmpresa', data.map(d => d.empresa), 'EMPRESA (Todas)');
        }

        function aplicarFiltros() {
          const fCond = document.getElementById('filterCondicion').value;
          const fCli = document.getElementById('filterCliente').value;
          const fMes = document.getElementById('filterMes').value;
          const fAno = document.getElementById('filterAno').value;
          const fResp = document.getElementById('filterResponsable').value;
          const fEmp = document.getElementById('filterEmpresa').value;

          const filtradas = facturasGlobales.filter(f => {
            return (!fCond || f.condicion === fCond) &&
                   (!fCli || f.cliente === fCli) &&
                   (!fMes || f.mes === fMes) &&
                   (!fAno || f.ano === fAno) &&
                   (!fResp || f.responsable === fResp) &&
                   (!fEmp || f.empresa === fEmp);
          });

          if (tabActual === 'facturacion') {
            renderFacturas(filtradas);
          } else if (tabActual === 'consolidado') {
            renderConsolidado(filtradas);
          }
        }

        function renderFacturas(data) {
          let html = '';
          let total = 0;
          data.forEach(f => {
            total += f.valor;
            const badgeClass = f.condicion === 'PENDIENTE' ? 'badge-pendiente' : 'badge-pagado';
            html += \`
              <tr>
                <td><b>\${f.cliente}</b></td>
                <td>\${f.mes}</td>
                <td>\${f.numero}</td>
                <td>\${f.fecha}</td>
                <td><span class="\${badgeClass}">\${f.condicion}</span></td>
                <td>\${f.fechaPago}</td>
                <td><b>$ \${f.valor.toLocaleString('es-CO')}</b></td>
              </tr>
            \`;
          });
          document.getElementById('tablaFacturas').innerHTML = html || '<tr><td colspan="7" style="text-align:center;">Sin datos</td></tr>';
          document.getElementById('totalKPI').innerText = '$ ' + total.toLocaleString('es-CO');
        }

        function renderConsolidado(data) {
          const mapa = {};
          let totalGeneral = 0;

          data.forEach(f => {
            if (!mapa[f.cliente]) {
              mapa[f.cliente] = Array(12).fill(0);
            }
            mapa[f.cliente][f.numMes] += f.valor;
            totalGeneral += f.valor;
          });

          let html = '';
          Object.keys(mapa).forEach(cliente => {
            const meses = mapa[cliente];
            const totalCliente = meses.reduce((a, b) => a + b, 0);
            html += \`<tr>
              <td><b>\${cliente}</b></td>
              \${meses.map(m => \`<td>\${m > 0 ? '$ ' + m.toLocaleString('es-CO') : '-'}</td>\`).join('')}
              <td><b>$ \${totalCliente.toLocaleString('es-CO')}</b></td>
            </tr>\`;
          });

          document.getElementById('tablaConsolidado').innerHTML = html || '<tr><td colspan="14" style="text-align:center;">Sin datos</td></tr>';
          document.getElementById('totalKPI').innerText = '$ ' + totalGeneral.toLocaleString('es-CO');
        }

        async function cargarContratos() {
          const res = await fetch('/api/contratos');
          const contratos = await res.json();
          let html = '';
          let total = 0;

          contratos.forEach(c => {
            total += Number(c.valor);
            html += \`
              <tr>
                <td><b>\${c.cliente}</b></td>
                <td>$ \${Number(c.valor).toLocaleString('es-CO')}</td>
                <td>\${c.fechaInicio}</td>
                <td>\${c.fechaFin}</td>
                <td><span class="badge-activo">\${c.estado}</span></td>
                <td>\${c.responsable}</td>
              </tr>
            \`;
          });

          document.getElementById('tablaContratos').innerHTML = html;
          document.getElementById('totalKPI').innerText = '$ ' + total.toLocaleString('es-CO');
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
