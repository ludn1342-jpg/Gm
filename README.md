# 🏦 API de Consulta de Facturas - GM Financial

Sistema completo para consultar facturas de GM Financial en tiempo real usando los datos de zonapagos.com.

## ✨ Características

- ✅ **Consulta en tiempo real** de facturas de GM Financial
- ✅ **API REST JSON** fácil de integrar
- ✅ **Frontend responsive** incluido
- ✅ **Datos reales** extraídos directamente de zonapagos.com
- ✅ **Listo para producción** en Render, Netlify o tu servidor

---

## 📁 Estructura del Proyecto

```
GMfinancial/
├── server.js                    # Backend principal (Node.js/Express)
├── package.json                 # Dependencias del proyecto
├── .env.example                 # Variables de entorno
├── public/
│   └── consulta.html           # Frontend bonito
├── index.html, index2.html      # Páginas originales (limpias)
└── README.md                    # Este archivo
```

---

## 🚀 Instalación Local

### Requisitos
- **Node.js** v14+ ([Descargar](https://nodejs.org/))
- **npm** (viene con Node.js)

### Pasos

1. **Navega a la carpeta del proyecto**
```bash
cd GMfinancial
```

2. **Instala las dependencias**
```bash
npm install
```

3. **Inicia el servidor**
```bash
npm start
```

4. **Accede a la aplicación**
   - Frontend: http://localhost:3000/consulta.html
   - API Health: http://localhost:3000/api/health
   - Consulta API: POST http://localhost:3000/api/consultar

---

## 📡 Uso de la API

### Endpoint
```
POST /api/consultar
```

### Request Body
```json
{
  "documento": "1129501629",
  "placa": "JQQ720"
}
```

### Response (Exitoso)
```json
{
  "estado": "exitoso",
  "documento": "1129501629",
  "placa": "JQQ720",
  "facturas": [
    {
      "numeroCredito": "89469988",
      "nombre": "HAIDER ALFONSO JIMENEZ VARGAS",
      "identificacion": "1129501629",
      "placa": "JQQ720",
      "fechaVencimiento": "18/08/2026",
      "valorSugerido": "5502491.00",
      "valorSugeridoFormato": "5,502,491",
      "saldo": "5,502,491",
      "email": "cliente@email.com",
      "telefono": "+57 XXXXXXXXX"
    }
  ],
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

### Response (Error)
```json
{
  "error": "No se encontraron facturas para este documento y placa",
  "estado": "no_encontrado",
  "documento": "1129501629",
  "placa": "JQQ720"
}
```

---

## 🌐 Despliegue en Render

### Pasos:

1. **Sube tu código a GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git push origin main
   ```

2. **Ve a [Render.com](https://render.com)**
   - Haz login con GitHub
   - Click en "New +"
   - Selecciona "Web Service"
   - Conecta tu repositorio de GitHub

3. **Configura el servicio:**
   - **Name**: gmfinancial-api
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free

4. **Deploy**
   - Click en "Deploy"
   - Espera a que compile (2-3 minutos)
   - Tu URL será: `https://gmfinancial-api.onrender.com`

5. **Prueba la API:**
   ```bash
   curl -X POST https://gmfinancial-api.onrender.com/api/consultar \
     -H "Content-Type: application/json" \
     -d '{"documento":"1129501629","placa":"JQQ720"}'
   ```

---

## 🌐 Despliegue en Netlify (Solo Frontend)

Si quieres alojar el frontend en Netlify y la API en Render:

1. **Deploy la API en Render** (ver pasos arriba)

2. **Modifica consulta.html** para apuntar a tu API de Render:
   ```javascript
   const API_URL = 'https://gmfinancial-api.onrender.com/api/consultar';
   ```

3. **Deploy en Netlify:**
   ```bash
   npm install -g netlify-cli
   netlify deploy --prod --dir public
   ```

---

## 🔧 Variables de Entorno

Crea un archivo `.env` basado en `.env.example`:

```env
PORT=3000
NODE_ENV=production
```

---

## 🛡️ Notas Importantes

- ✅ Los datos provienen **directamente de zonapagos.com**
- ✅ Es un proxy seguro que extrae información en tiempo real
- ✅ No almacena datos personales - todo es procesado en tiempo real
- ✅ HTTPS obligatorio en producción
- ⚠️ Requiere consentimiento del cliente para usar el servicio

---

## 📊 Monitoreo

### Logs en Render
- Ve a tu servicio en Render
- Tab "Logs"
- Verás todas las consultas realizadas

### Healthcheck
```bash
curl https://gmfinancial-api.onrender.com/api/health
```

---

## 🐛 Troubleshooting

### "No se encontraron facturas"
- Verifica que el documento y placa sean correctos
- El formato debe ser exacto a como aparece en zonapagos.com

### "Error de conexión"
- Verifica tu conexión a internet
- Comprueba que zonapagos.com esté disponible

### "Error 500"
- Revisa los logs en Render
- Verifica que todas las dependencias estén instaladas

---

## 📞 Soporte

Para problemas o preguntas contacta al equipo de desarrollo.

---

## 📄 Licencia

Uso exclusivo para prestadores de servicios de pago autorizados.

**Creado con ❤️ para GM Financial**
