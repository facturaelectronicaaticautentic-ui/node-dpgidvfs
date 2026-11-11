// cartera.js - Módulo "Cuentas por Cobrar" (Cartera)
// Se sirve como archivo estático desde Express y se ejecuta en el navegador.
// Expone funciones globales:
//   montarEstructuraCartera(contenedorId) -> inyecta el HTML en el contenedor
//   inicializarCartera(datos?)            -> con datos los pinta; sin datos consulta /api/cartera (Siigo)
//   cargarCartera(forzar)                 -> consulta /api/cartera y repinta

(function () {
  'use strict';

  let datosCartera = [];
  let contenedorActual = null;
  let notaResumen = '';      // texto por empresa devuelto por el servidor
  let notaConError = false;

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
      .cxc-nota.error { background:#fef2f2; color:#b91c1c; }
      .cxc-btn { padding:8px 14px; background:#002d5b; color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:bold; }
      .cxc-btn:disabled { opacity:0.6; cursor:wait; }
      .cxc-accion { padding:3px 9px; border:1px solid transparent; border-radius:6px; font-size:11px; font-weight:bold; cursor:pointer; }
      .cxc-accion.quitar { background:#fef2f2; color:#b91c1c; border-color:#fecaca; }
      .cxc-accion.restaurar { background:#dcfce7; color:#15803d; border-color:#bbf7d0; }
      .cxc-accion:disabled { opacity:0.5; cursor:wait; }
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
        <label class="chk"><input type="checkbox" id="cxcVerOcultas" /> Ver solo ocultas <span id="cxcCntOcultas"></span></label>
        <button id="cxcActualizar" class="cxc-btn">↻ ACTUALIZAR DESDE SIIGO</button>
      </div>

      <div class="cxc-kpis">
        <div class="cxc-kpi">
          <div class="t" id="cxcTituloTotal">Total cartera</div>
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
              <th style="text-align:center;">Acción</th>
            </tr>
          </thead>
          <tbody id="cxcTabla"></tbody>
        </table>
      </div>
    `;

    ['cxcEmpresa', 'cxcCliente', 'cxcVerOcultas'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', renderizarCartera);
    });
    document.getElementById('cxcActualizar').addEventListener('click', function () { cargarCartera(true); });
    document.getElementById('cxcTabla').addEventListener('click', accionFila);
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

  async function cargarCartera(forzar) {
    if (!document.getElementById('cxcTabla')) montarEstructuraCartera('pgCartera');
    const btn = document.getElementById('cxcActualizar');
    const tabla = document.getElementById('cxcTabla');
    if (btn) { btn.disabled = true; btn.textContent = 'Consultando Siigo...'; }
    tabla.innerHTML = '<tr><td colspan="7" style="text-align:center;">Cargando cartera completa desde Siigo...</td></tr>';

    try {
      const r = await fetch('/api/cartera' + (forzar === true ? '?refrescar=1' : ''));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();

      // Aviso por empresa (errores de Siigo o cargas incompletas)
      const resumen = Array.isArray(j.resumen) ? j.resumen : [];
      const detalle = resumen.map(function (x) {
        return x.empresa + ': ' + (x.error ? '⚠ ' + x.error : x.cantidad + ' pendientes' + (x.nota ? ' (⚠ ' + x.nota + ')' : ''));
      }).join(' | ');
      notaResumen = detalle ? ' Desde ' + (j.desde || '') + ' → ' + detalle : '';
      notaConError = resumen.some(function (x) { return x.error; });

      aplicarDatos(Array.isArray(j) ? j : (j.cartera || []));
    } catch (e) {
      console.error('cartera.js:', e);
      tabla.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#dc2626;">No se pudo cargar la cartera: ' + escC(e.message) + '</td></tr>';
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
    if (Array.isArray(datos) && datos.length) { aplicarDatos(datos); return; }
    // Ya cargada antes: solo se repinta (para refrescar se usa el botón)
    if (datosCartera.length) { aplicarDatos(datosCartera); return; }
    // Sin datos => consulta directamente a Siigo
    cargarCartera();
  }

  // ---------- Quitar / restaurar una factura de la cartera (queda guardado en el servidor) ----------
  async function accionFila(ev) {
    const b = ev.target.closest ? ev.target.closest('button[data-acc]') : null;
    if (!b) return;
    const f = datosCartera.find(function (x) {
      return String(x.empresaId) === b.getAttribute('data-emp') && String(x.id) === b.getAttribute('data-id');
    });
    if (!f) return;
    const ocultar = b.getAttribute('data-acc') === 'quitar';
    if (ocultar && !window.confirm('¿Quitar la factura ' + f.numero + ' de ' + f.cliente + ' de la cartera?\n\nNo volverá a aparecer. Podrás restaurarla con "Ver solo ocultas".')) return;

    b.disabled = true;
    try {
      const res = await fetch('/api/cartera/' + encodeURIComponent(f.empresaId) + '/' + encodeURIComponent(f.id) + '/ocultar', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oculta: ocultar })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      f.oculta = ocultar;
      renderizarCartera();
    } catch (e) {
      b.disabled = false;
      window.alert('No se pudo guardar el cambio: ' + e.message);
    }
  }

  // ---------- 3. Render + cálculos en tiempo real ----------
  function renderizarCartera() {
    const fEmp = document.getElementById('cxcEmpresa').value;
    const fCli = document.getElementById('cxcCliente').value;
    const soloOcultas = document.getElementById('cxcVerOcultas').checked;

    const nOcultas = datosCartera.filter(function (f) { return f.oculta; }).length;
    document.getElementById('cxcCntOcultas').textContent = nOcultas ? '(' + nOcultas + ')' : '';
    document.getElementById('cxcTituloTotal').textContent = soloOcultas ? 'Total ocultas (no cuentan en cartera)' : 'Total cartera';

    const filas = datosCartera
      .filter(function (f) {
        return (!fEmp || f.empresa === fEmp) && (!fCli || f.cliente === fCli) &&
               montoCartera(f) > 0 && !!f.oculta === soloOcultas;
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
      const boton = '<button type="button" class="cxc-accion ' + (soloOcultas ? 'restaurar' : 'quitar') + '" ' +
        'data-acc="' + (soloOcultas ? 'restaurar' : 'quitar') + '" data-emp="' + escC(f.empresaId) + '" data-id="' + escC(f.id) + '" ' +
        'title="' + (soloOcultas ? 'Volver a mostrar esta factura en la cartera' : 'Quitar esta factura de la cartera (queda guardado)') + '">' +
        (soloOcultas ? '↩ Restaurar' : '🗑 Quitar') + '</button>';
      html += '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td><b>' + escC(f.cliente) + '</b></td>' +
        '<td>' + escC(f.numero) + '</td>' +
        '<td>' + escC(f.vencimiento || '-') + '</td>' +
        '<td class="num">' + fmtCOP(r.monto) + '</td>' +
        '<td class="num ' + claseDias + '">' + (r.dias === null ? '-' : r.dias) + '</td>' +
        '<td style="text-align:center;">' + boton + '</td>' +
        '</tr>';
    });
    if (filas.length > LIMITE) {
      html += '<tr><td colspan="7" style="text-align:center;color:#64748b;">Mostrando los primeros ' + LIMITE + ' de ' + filas.length + '. Usa los filtros para acotar.</td></tr>';
    }
    document.getElementById('cxcTabla').innerHTML = html ||
      '<tr><td colspan="7" style="text-align:center;">' +
      (soloOcultas ? 'No hay facturas ocultas con los filtros elegidos' :
        (datosCartera.length ? 'Sin datos con los filtros elegidos' : 'Sin cartera pendiente. Presiona ACTUALIZAR DESDE SIIGO.')) +
      '</td></tr>';

    const nota = document.getElementById('cxcNota');
    nota.textContent = 'Días = fecha de vencimiento − hoy (negativo = vencida). Datos consultados directamente a Siigo (saldo pendiente de todas las facturas). Las facturas que quites no se cuentan y no vuelven a aparecer.' + notaResumen;
    nota.classList.toggle('error', notaConError);
  }

  // Exponer al ámbito global
  window.montarEstructuraCartera = montarEstructuraCartera;
  window.inicializarCartera = inicializarCartera;
  window.cargarCartera = cargarCartera;
})();