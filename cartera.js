// cartera.js - Módulo "Cuentas por Cobrar" (Cartera)
// Se sirve como archivo estático desde Express y se ejecuta en el navegador.
// Expone funciones globales:
//   montarEstructuraCartera(contenedorId) -> inyecta el HTML en el contenedor
//   inicializarCartera(datos?)            -> con datos los pinta; sin datos consulta /api/cartera (Siigo)
//   cargarCartera()                       -> consulta /api/cartera y repinta

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
        .cxc-header { background:#fff; padding:14px 20px; border-radius:8px; margin-bottom:14px; box-shadow:0 2px 4px rgba(0,0,0,0.05); }
        .cxc-header h1 { margin:0; font-size:22px; color:#002d5b; letter-spacing:0.5px; }
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
        .cxc-nota { background:#eff6ff; color:#1e40af; padding:7px 12px; border-radius:8px; margin-bottom:10px; font-size:11px; }
        .cxc-btn { padding:8px 14px; background:#002d5b; color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:bold; }
        .cxc-btn:disabled { opacity:0.6; cursor:wait; }
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
        <div class="cxc-header"><h1>CUENTAS POR COBRAR</h1></div>
  
        <div class="filters-container">
          <select id="cxcEmpresa"><option value="">EMPRESA (Todas)</option></select>
          <select id="cxcCliente"><option value="">CLIENTE (Todos)</option></select>
          <button id="cxcActualizar" class="cxc-btn">↻ ACTUALIZAR DESDE SIIGO</button>
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
  
        <div class="cxc-nota" id="cxcNota"></div>
  
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Cliente</th>
                <th>Documento</th>
                <th>Fecha venci...</th>
                <th style="text-align:right;">Total cartera</th>
                <th style="text-align:right;">Días</th>
              </tr>
            </thead>
            <tbody id="cxcTabla"></tbody>
          </table>
        </div>
      `;
  
      ['cxcEmpresa', 'cxcCliente'].forEach(function (id) {
        document.getElementById(id).addEventListener('change', renderizarCartera);
      });
      document.getElementById('cxcActualizar').addEventListener('click', cargarCartera);
    }
  
    // ---------- Utilidades de fecha / monto ----------
    // Días = fecha de vencimiento - hoy. Negativo = vencida; positivo o cero = dentro del plazo.
    function calcularDias(vencimiento) {
      if (!vencimiento || !/^\d{4}-\d{2}-\d{2}/.test(String(vencimiento))) return null;
      const [y, m, d] = String(vencimiento).slice(0, 10).split('-').map(Number);
      const venc = Date.UTC(y, m - 1, d);
      const h = new Date();
      const hoy = Date.UTC(h.getFullYear(), h.getMonth(), h.getDate());
      return Math.round((venc - hoy) / 86400000);
    }
  
    // El backend solo envía facturas con saldo pendiente (balance > 0)
    function montoCartera(f) {
      const saldo = Number(f.saldo);
      return saldo > 0 ? saldo : 0;
    }
  
    // ---------- 2. Lógica de datos ----------
    function poblarSelectCartera(id, valores, titulo) {
      const sel = document.getElementById(id);
      if (!sel) return;
      const previo = sel.value;
      sel.innerHTML = '<option value="">' + titulo + '</option>';
      Array.from(new Set(valores.filter(Boolean)))
        .sort(function (a, b) { return String(a).localeCompare(String(b)); })
        .forEach(function (v) {
          sel.innerHTML += '<option value="' + escC(v) + '">' + escC(v) + '</option>';
        });
      if (previo && Array.from(sel.options).some(function (o) { return o.value === previo; })) sel.value = previo;
    }
  
    async function cargarCartera() {
      if (!document.getElementById('cxcTabla')) montarEstructuraCartera('pgCartera');
      const btn = document.getElementById('cxcActualizar');
      const tabla = document.getElementById('cxcTabla');
      if (btn) { btn.disabled = true; btn.textContent = 'Consultando Siigo...'; }
      tabla.innerHTML = '<tr><td colspan="6" style="text-align:center;">Cargando cartera completa desde Siigo...</td></tr>';
  
      try {
        const r = await fetch('/api/cartera');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const datos = await r.json();
        aplicarDatos(datos);
      } catch (e) {
        console.error('cartera.js:', e);
        tabla.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#dc2626;">No se pudo cargar la cartera: ' + escC(e.message) + '</td></tr>';
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '↻ ACTUALIZAR DESDE SIIGO'; }
      }
    }
  
    function aplicarDatos(datos) {
      datosCartera = (Array.isArray(datos) ? datos : []).filter(function (f) { return !f.tieneNotaCredito; });
      poblarSelectCartera('cxcEmpresa', datosCartera.map(function (f) { return f.empresa; }), 'EMPRESA (Todas)');
      poblarSelectCartera('cxcCliente', datosCartera.map(function (f) { return f.cliente; }), 'CLIENTE (Todos)');
      renderizarCartera();
    }
  
    function inicializarCartera(datos) {
      if (!document.getElementById('cxcTabla')) montarEstructuraCartera('pgCartera');
      // Sin datos => consulta directamente a Siigo
      if (!Array.isArray(datos)) { cargarCartera(); return; }
      aplicarDatos(datos);
    }
  
    // ---------- 3. Render + cálculos en tiempo real ----------
    function renderizarCartera() {
      const fEmp = document.getElementById('cxcEmpresa').value;
      const fCli = document.getElementById('cxcCliente').value;
  
      const filas = datosCartera
        .filter(function (f) {
          return (!fEmp || f.empresa === fEmp) && (!fCli || f.cliente === fCli) && montoCartera(f) > 0;
        })
        .map(function (f) {
          return { f: f, dias: calcularDias(f.vencimiento), monto: montoCartera(f) };
        })
        // Más vencidas primero; las que no tienen fecha de vencimiento al final
        .sort(function (a, b) {
          const da = a.dias === null ? Infinity : a.dias;
          const db = b.dias === null ? Infinity : b.dias;
          return da - db;
        });
  
      let total = 0, vencidos = 0, plazo = 0, nVenc = 0, nPlazo = 0;
      filas.forEach(function (r) {
        total += r.monto;
        // Vencido: días negativos. Plazo: días positivos o cero (sin fecha se cuenta como plazo)
        if (r.dias !== null && r.dias < 0) { vencidos += r.monto; nVenc++; }
        else { plazo += r.monto; nPlazo++; }
      });
  
      document.getElementById('cxcKpiTotal').textContent = fmtCOP(total);
      document.getElementById('cxcKpiVencidos').textContent = fmtCOP(vencidos);
      document.getElementById('cxcKpiPlazo').textContent = fmtCOP(plazo);
      document.getElementById('cxcCntTotal').textContent = filas.length + ' documentos';
      document.getElementById('cxcCntVencidos').textContent = nVenc + ' documentos';
      document.getElementById('cxcCntPlazo').textContent = nPlazo + ' documentos';
  
      const LIMITE = 500;
      let html = '';
      filas.slice(0, LIMITE).forEach(function (r, i) {
        const f = r.f;
        const claseDias = r.dias === null ? '' : (r.dias < 0 ? 'cxc-dias-neg' : 'cxc-dias-pos');
        html += '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td><b>' + escC(f.cliente) + '</b></td>' +
          '<td>' + escC(f.numero) + '</td>' +
          '<td>' + escC(f.vencimiento || '-') + '</td>' +
          '<td class="num">' + fmtCOP(r.monto) + '</td>' +
          '<td class="num ' + claseDias + '">' + (r.dias === null ? '-' : r.dias) + '</td>' +
          '</tr>';
      });
      if (filas.length > LIMITE) {
        html += '<tr><td colspan="6" style="text-align:center;color:#64748b;">Mostrando los primeros ' + LIMITE + ' de ' + filas.length + '. Usa los filtros para acotar.</td></tr>';
      }
      document.getElementById('cxcTabla').innerHTML = html ||
        '<tr><td colspan="6" style="text-align:center;">' +
        (datosCartera.length ? 'Sin datos con los filtros elegidos' : 'Sin cartera pendiente. Presiona ACTUALIZAR DESDE SIIGO.') +
        '</td></tr>';
  
      document.getElementById('cxcNota').textContent =
        'Días = fecha de vencimiento − hoy (negativo = vencida). Datos consultados directamente a Siigo (saldo pendiente de todas las facturas).';
    }
  
    // Exponer al ámbito global
    window.montarEstructuraCartera = montarEstructuraCartera;
    window.inicializarCartera = inicializarCartera;
    window.cargarCartera = cargarCartera;
  })();