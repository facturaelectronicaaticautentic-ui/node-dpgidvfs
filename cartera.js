// cartera.js - Módulo "Cuentas por Cobrar" (Cartera)
// Se sirve como archivo estático desde Express y se ejecuta en el navegador.

(function () {
    'use strict';
  
    let datosCartera = [];
    let contenedorActual = null;
  
    const fmtCOP = (n) => '$ ' + Number(n || 0).toLocaleString('es-CO');
    const escC = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  
    // ---------- Estilos propios (se inyectan una sola vez) ----------
    function inyectarEstilos() {
      if (document.getElementById('estilosCartera')) return;
      const st = document.createElement('style');
      st.id = 'estilosCartera';
      st.textContent = `
        .cxc-header { background:#fff; padding:14px 20px; border-radius:8px; margin-bottom:14px; box-shadow:0 2px 4px rgba(0,0,0,0.05); display:flex; justify-content:space-between; align-items:center; }
        .cxc-header h1 { margin:0; font-size:22px; color:#002d5b; letter-spacing:0.5px; }
        .cxc-btn-actualizar { background:#002d5b; color:#fff; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:bold; transition: background 0.3s; }
        .cxc-btn-actualizar:hover { background:#004080; }
        .cxc-btn-actualizar:disabled { background:#94a3b8; cursor:not-allowed; }
        .cxc-kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-bottom:14px; }
        .cxc-kpi { background:#fff; border-radius:8px; padding:14px 18px; box-shadow:0 2px 4px rgba(0,0,0,0.05); border-left:5px solid #002d5b; }
        .cxc-kpi.vencido { border-left-color:#dc2626; }
        .cxc-kpi.plazo { border-left-color:#16a34a; }
        .cxc-kpi .t { font-size:11px; color:#666; text-transform:uppercase; letter-spacing:0.5px; }
        .cxc-kpi .v { font-size:22px; font-weight:bold; color:#002d5b; margin-top:4px; }
        .cxc-kpi.vencido .v { color:#dc2626; }
        .cxc-kpi.plazo .v { color:#15803d; }
        .cxc-kpi .c { font-size:11px; color:#64748b; margin-top:2px; }
        .cxc-dias-neg { color:#dc2626; font-weight:bold; }
        .cxc-dias-pos { color:#15803d; font-weight:bold; }
        .cxc-nota { background:#eff6ff; color:#1e40af; padding:7px 12px; border-radius:8px; margin-bottom:10px; font-size:11px; transition: all 0.3s ease; }
      `;
      document.head.appendChild(st);
    }
  
    // ---------- 1. Estructura HTML ----------
    function montarEstructuraCartera(contenedorId) {
      const cont = document.getElementById(contenedorId || 'pgCartera');
      if (!cont) { console.error('cartera.js: no existe el contenedor #' + contenedorId); return; }
      inyectarEstilos();
      contenedorActual = cont;
  
      cont.innerHTML = `
        <div class="cxc-header">
          <h1>CUENTAS POR COBRAR</h1>
          <button id="btnActualizarCartera" class="cxc-btn-actualizar">Cargar Cartera desde Siigo</button>
        </div>
  
        <div class="filters-container">
          <select id="cxcEmpresa"><option value="">EMPRESA (Todas)</option></select>
          <select id="cxcCliente"><option value="">CLIENTE (Todos)</option></select>
          <select id="cxcEstado">
            <option value="PENDIENTE">ESTADO: PENDIENTE</option>
            <option value="PAGADO">ESTADO: PAGADO</option>
            <option value="">ESTADO (Todos)</option>
          </select>
        </div>
  
        <div class="cxc-kpis">
          <div class="cxc-kpi">
            <div class="t">Total cartera</div>
            <div class="v" id="cxcKpiTotal">$ 0</div>
            <div class="c" id="cxcCntTotal">0 documentos</div>
          </div>
          <div class="cxc-kpi vencido">
            <div class="t">Total vencidos</div>
            <div class="v" id="cxcKpiVencidos">$ 0</div>
            <div class="c" id="cxcCntVencidos">0 documentos</div>
          </div>
          <div class="cxc-kpi plazo">
            <div class="t">Total plazo</div>
            <div class="v" id="cxcKpiPlazo">$ 0</div>
            <div class="c" id="cxcCntPlazo">0 documentos</div>
          </div>
        </div>
  
        <div class="cxc-nota" id="cxcNota">Presiona "Cargar Cartera desde Siigo" para traer la información actualizada.</div>
  
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Cliente</th>
                <th>Documento</th>
                <th>Fecha venci...</th>
                <th style="text-align:right;">Saldo Pendiente</th>
                <th style="text-align:right;">Días</th>
              </tr>
            </thead>
            <tbody id="cxcTabla"></tbody>
          </table>
        </div>
      `;
  
      ['cxcEmpresa', 'cxcCliente', 'cxcEstado'].forEach(function (id) {
        document.getElementById(id).addEventListener('change', renderizarCartera);
      });

      // Evento para consultar directamente a Siigo vía el backend
      document.getElementById('btnActualizarCartera').addEventListener('click', cargarCarteraDesdeSiigo);
    }
  
    // ---------- 2. Integración con el Backend (Siigo) ----------
    async function cargarCarteraDesdeSiigo() {
      const btn = document.getElementById('btnActualizarCartera');
      const nota = document.getElementById('cxcNota');
      
      try {
        btn.textContent = 'Consultando Siigo...';
        btn.disabled = true;
        nota.style.backgroundColor = '#fef08a'; // Amarillo de carga
        nota.style.color = '#854d0e';
        nota.textContent = 'Obteniendo reporte completo de cartera de Siigo. Esto puede tardar unos segundos...';

        // IMPORTANTE: Asegúrate de que esta ruta coincida con el endpoint de tu servidor Express
        const respuesta = await fetch('/api/siigo/cartera-pendiente');
        
        if (!respuesta.ok) throw new Error('Error de comunicación con el servidor: ' + respuesta.statusText);
        
        const data = await respuesta.json();
        const facturas = Array.isArray(data) ? data : (data.facturas || []);

        inicializarCartera(facturas);

        nota.style.backgroundColor = '#dcfce7'; // Verde de éxito
        nota.style.color = '#166534';
        nota.textContent =