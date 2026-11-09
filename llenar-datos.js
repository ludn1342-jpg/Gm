(function(){
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', inicializar);
  } else {
    inicializar();
  }

  function inicializar(){
    try{
      const datosJSON = sessionStorage.getItem('consultaFactura');
      if(!datosJSON) return;

      const datos = JSON.parse(datosJSON);
      if(datos.estado !== 'exitoso' || !datos.facturas || datos.facturas.length === 0) return;

      const factura = datos.facturas[0];

      // Buscar y llenar campos de tabla
      const todasLasTablas = document.querySelectorAll('table');
      for(let tabla of todasLasTablas){
        const rows = tabla.querySelectorAll('tr');
        for(let row of rows){
          const cells = row.querySelectorAll('td');
          if(cells.length > 10){
            // Llenar cada columna con datos correspondientes
            if(cells[1]) cells[1].textContent = factura.numeroCredito || '';
            if(cells[3]) cells[3].textContent = factura.tipoIdentificacion || '';
            if(cells[4]) cells[4].textContent = factura.identificacion || '';
            if(cells[5]) cells[5].textContent = factura.nombre || '';
            if(cells[6]) cells[6].textContent = factura.apellido || '';
            if(cells[7]) cells[7].textContent = factura.email || '';
            if(cells[8]) cells[8].textContent = factura.telefono || '';
            if(cells[10]) cells[10].textContent = factura.placa || '';
            if(cells[12]) cells[12].textContent = factura.totalIva || '';
            if(cells[13]) cells[13].textContent = factura.saldo || '';
            if(cells[14]) cells[14].textContent = factura.fechaVencimiento || '';
            if(cells[15]) cells[15].textContent = factura.valorSugerido || '';
          }
        }
      }

      // Buscar y actualizar totales en spans
      const todosLosSpans = document.querySelectorAll('span');
      for(let span of todosLosSpans){
        const texto = span.textContent.trim();
        // Si encuentra un total de $0, reemplazarlo
        if(texto.includes('0') && texto.includes('$')){
          span.textContent = factura.valorSugerido || '0';
        }
      }

      console.log('✅ Datos del cliente cargados desde sessionStorage');
    } catch(err){
      console.error('Error al cargar datos:', err);
    }
  }
})();
