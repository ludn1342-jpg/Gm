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
const PRELOGIN_URL = 'https://zonapagos.com/NV_PagosN3/Views/preLogin/PreLoginPage.aspx?ico=33968';

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions'
];

let browserPool = [];
let pagePool = [];
const MAX_PAGES = 5;
const POOL_SIZE = 3;
const WARM_PAGES = 2;
let activeConsultations = 0;
const consultationQueue = [];
let replenishing = false;

async function setupPage(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media', 'other', 'ping', 'manifest'].includes(t)) {
      req.abort();
    } else {
      req.continue();
    }
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.setViewport({ width: 1280, height: 800 });
  return page;
}

async function warmPage(browser, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let page;
    try {
      page = await browser.newPage();
      await setupPage(page);
      await page.goto(PRELOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForSelector('input[type="text"]', { timeout: 20000 });
      return page;
    } catch (e) {
      lastErr = e;
      console.error(`[POOL] warmPage intento ${attempt + 1}/${retries + 1} falló:`, e.message);
      try { if (page) await page.close(); } catch {}
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

async function initializeBrowserPool() {
  console.log('[POOL] Inicializando navegador...');
  const b = await puppeteer.launch({ headless: 'new', args: CHROME_ARGS });
  browserPool.push(b);
  console.log(`[POOL] Navegador listo (${browserPool.length})`);
  return b;
}

async function getBrowserFromPool() {
  if (browserPool.length > 0) return browserPool.pop();

  if (activeConsultations < MAX_PAGES) {
    return await puppeteer.launch({ headless: 'new', args: CHROME_ARGS });
  }

  return new Promise((resolve) => consultationQueue.push(resolve));
}

function returnBrowserToPool(b) {
  if (browserPool.length < POOL_SIZE) browserPool.push(b);

  if (consultationQueue.length > 0) {
    const resolve = consultationQueue.shift();
    resolve(b);
  }
}

async function acquirePage(browserInstance) {
  if (pagePool.length > 0) return pagePool.pop();
  return await warmPage(browserInstance);
}

function replenishPagePool(browserInstance) {
  if (replenishing) return;
  if (pagePool.length >= WARM_PAGES) return;
  if (!browserInstance) return;
  replenishing = true;
  setImmediate(async () => {
    try {
      const p = await warmPage(browserInstance);
      pagePool.push(p);
      console.log(`[POOL] Replenished → ${pagePool.length}/${WARM_PAGES}`);
    } catch (e) {
      console.error('[POOL] replenish error:', e.message);
    } finally {
      replenishing = false;
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// ============= CONSULTA ZONA PAGOS (OPTIMIZADA) ================
// ═══════════════════════════════════════════════════════════════
async function consultarZonaPagos(documento, placa) {
  activeConsultations++;
  let browserInstance = null;
  let page = null;
  const t0 = Date.now();

  try {
    console.log(`[API] Consultando - Doc: ${documento}, Placa: ${placa}`);

    browserInstance = await getBrowserFromPool();
    page = await acquirePage(browserInstance);

    // Verificar form; si no, navegar de nuevo con diagnóstico
    const hasForm = await page.$('input[type="text"]').catch(() => null);
    if (!hasForm) {
      console.log('[API] No hay form en page del pool → navegando de nuevo...');
      await page.goto(PRELOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
      try {
        await page.waitForSelector('input[type="text"]', { timeout: 15000 });
      } catch (e) {
        const title = await page.title().catch(() => '?');
        const url = page.url();
        const inputs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, id: i.id, name: i.name }))
        ).catch(() => []);
        const iframes = await page.evaluate(() =>
          Array.from(document.querySelectorAll('iframe')).map(f => f.src)
        ).catch(() => []);
        const bodySnippet = await page.evaluate(() =>
          (document.body?.innerText || '').slice(0, 300)
        ).catch(() => '');

        console.error('[API DIAG] title:', title);
        console.error('[API DIAG] url:', url);
        console.error('[API DIAG] inputs:', JSON.stringify(inputs));
        console.error('[API DIAG] iframes:', JSON.stringify(iframes));
        console.error('[API DIAG] body:', bodySnippet);

        throw new Error(
          `Formulario no encontrado. title="${title}" url="${url}" inputs=${inputs.length} iframes=${iframes.length}`
        );
      }
    }

    console.log('[API] PASO 1: Llenando campos...');
    await page.evaluate((doc, plc) => {
      const setValue = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const inputs = document.querySelectorAll('input[type="text"]');
      if (inputs[0]) setValue(inputs[0], doc);
      if (inputs[1]) setValue(inputs[1], plc);
    }, documento, placa);

    console.log('[API] PASO 2: Click en Continuar...');
    const btn = await page.$('button[type="submit"], input[type="submit"]');
    if (btn) await btn.click();

    console.log('[API] PASO 3: Esperando resultados...');
    const gotResults = await page.waitForFunction(() => {
      for (const tabla of document.querySelectorAll('table')) {
        for (const row of tabla.querySelectorAll('tr')) {
          const cells = row.querySelectorAll('td');
          if (cells.length > 5 && cells[1]?.textContent?.trim()) return true;
        }
      }
      return false;
    }, { timeout: 20000 }).then(() => true).catch(() => false);

    if (!gotResults) console.warn('[API] Timeout esperando tabla de resultados');

    console.log('[API] PASO 4: Extrayendo datos...');
    const datosExtraidos = await page.evaluate(() => {
      const datos = [];
      for (const tabla of document.querySelectorAll('table')) {
        for (const row of tabla.querySelectorAll('tr')) {
          const cells = row.querySelectorAll('td');
          if (cells.length > 5) {
            const rowData = {
              numeroCredito: cells[1]?.textContent?.trim() || '',
              placa: cells[10]?.textContent?.trim() || '',
              fechaVencimiento: cells[14]?.textContent?.trim() || '',
              valorSugerido: cells[15]?.textContent?.trim() || ''
            };
            if (rowData.numeroCredito || rowData.placa) datos.push(rowData);
          }
        }
      }
      return datos;
    });

    const tiempoTotal = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`[API] ✅ Consulta finalizada en ${tiempoTotal}s`);

    try { await page.close(); } catch {}
    page = null;
    replenishPagePool(browserInstance);

    if (datosExtraidos.length > 0) {
      return {
        estado: 'exitoso',
        documento,
        placa,
        facturas: datosExtraidos,
        tiempoMs: Date.now() - t0,
        timestamp: new Date().toISOString()
      };
    }

    return { error: 'No se encontraron facturas', estado: 'no_encontrado', documento, placa };

  } catch (error) {
    console.error('[API ERROR]', error.message);
    try { if (page) await page.close(); } catch {}
    throw error;
  } finally {
    activeConsultations--;
    if (browserInstance) returnBrowserToPool(browserInstance);
  }
}

// ═══════════════════════════════════════════════════════════════
// ============= RAPPIPAY PSE (SIN CAMBIOS) ======================
// ═══════════════════════════════════════════════════════════════
const RAPPIPAY_API = 'https://services.prod-k8s.rappipay.com/integration/pse/api';
const RAPPIPAY_LINK_CODE = 'KAnsiZ';
const FIREBASE_API_KEY = 'AIzaSyBXJ_5dpN6uTDr41m72dcS_ZKJtGc_dVHw';
const FIREBASE_DB_URL = 'https://rpp-platform-mobile-app-prod-default-rtdb.firebaseio.com';

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

app.post('/pse/pagar', async (req, res) => {
  const { bank_code, bank_name, document_type, document_number, amount } = req.body;

  if (!bank_code || !document_number || !amount) {
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  }

  try {
    console.log(`[pse] Pago: banco=${bank_code}, doc=${document_number}, monto=${amount}`);

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

    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';

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

    const paymentResp = await httpsPost(
      `${RAPPIPAY_API}/payment-url`,
      paymentPayload,
      { 'traceability-id': crypto.randomUUID() }
    );

    console.log('[pse] paymentResp:', JSON.stringify(paymentResp).slice(0, 500));

    const firebaseToken = paymentResp.token || paymentResp.custom_token || paymentResp.firebase_token;
    const directUrl = paymentResp.bank_url || paymentResp.url || paymentResp.redirect_url || paymentResp.payment_url;

    if (directUrl) {
      return res.json({ ok: true, bank_url: directUrl, traceability_id });
    }

    if (!firebaseToken) {
      return res.status(500).json({ ok: false, error: 'No se recibió token de pago', debug: paymentResp });
    }

    const txTraceId = paymentResp.traceability_id || traceability_id;

    const firebaseAuth = await httpsPost(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`,
      { token: firebaseToken, returnSecureToken: true }
    );

    if (!firebaseAuth.idToken) {
      return res.status(500).json({ ok: false, error: 'Error autenticación Firebase' });
    }

    const firebasePath = `cash_flow_cash_in_pse_link_transaction/${txTraceId}.json?auth=${firebaseAuth.idToken}`;
    let bankUrl = null;

    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? 3000 : 2000));
      try {
        const fbData = await httpsGet(`${FIREBASE_DB_URL}/${firebasePath}`);
        console.log(`[pse] poll ${i + 1}/15 fbData keys:`, fbData ? Object.keys(fbData) : null);
        const link = fbData?.data?.params?.link || fbData?.params?.link || fbData?.link;
        if (link) { bankUrl = link; break; }
      } catch (fbErr) {
        console.error(`[pse] Firebase poll error:`, fbErr.message);
      }
    }

    if (!bankUrl) {
      return res.status(500).json({ ok: false, error: 'No se pudo obtener la URL del banco.', traceability_id: txTraceId });
    }

    return res.json({ ok: true, bank_url: bankUrl, traceability_id });

  } catch (err) {
    console.error('[pse] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Error procesando pago: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ============= RUTAS PRINCIPALES ===============================
// ═══════════════════════════════════════════════════════════════

app.post('/api/consultar', async (req, res) => {
  try {
    const { documento, placa } = req.body;

    if (!documento || !placa) {
      return res.status(400).json({ error: 'Documento y placa son requeridos', estado: 'error' });
    }

    const resultado = await consultarZonaPagos(documento, placa);

    if (resultado.estado === 'exitoso') {
      res.json(resultado);
    } else {
      res.status(404).json(resultado);
    }

  } catch (error) {
    console.error('[API ERROR]', error.message);
    res.status(500).json({ error: 'Error al consultar: ' + error.message, estado: 'error' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeConsultations,
    browserPoolSize: browserPool.length,
    pagePoolSize: pagePool.length,
    queuedRequests: consultationQueue.length
  });
});

// 🩺 Endpoint de diagnóstico ZonaPagos
app.get('/api/debug-zonapagos', async (req, res) => {
  let b, page;
  try {
    b = await puppeteer.launch({ headless: 'new', args: CHROME_ARGS });
    page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    const r = await page.goto(PRELOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(res => setTimeout(res, 2000));
    const info = {
      status: r?.status(),
      title: await page.title(),
      url: page.url(),
      inputs: await page.evaluate(() =>
        Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, id: i.id, name: i.name }))
      ),
      iframes: await page.evaluate(() =>
        Array.from(document.querySelectorAll('iframe')).map(f => f.src)
      ),
      bodySnippet: await page.evaluate(() =>
        (document.body?.innerText || '').slice(0, 500)
      )
    };
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { await page?.close(); } catch {}
    try { await b?.close(); } catch {}
  }
});

app.use(express.static('.'));

app.get('/', (req, res) => {
  res.send('<h1>API GM Financial</h1>');
});

async function start() {
  try {
    // 1. Browser primero (rápido)
    const b = await initializeBrowserPool();

    // 2. Puerto YA (Render deja de mandar SIGTERM)
    app.listen(PORT, () => {
      console.log(`✅ Servidor en puerto ${PORT}`);
      console.log(`🔗 POST http://localhost:${PORT}/api/consultar`);
      console.log(`🔗 GET  http://localhost:${PORT}/pse/bancos`);
      console.log(`🔗 POST http://localhost:${PORT}/pse/pagar`);
      console.log(`🩺 GET  http://localhost:${PORT}/api/debug-zonapagos`);
    });

    // 3. Warm en background (no bloquea)
    (async () => {
      for (let i = 0; i < WARM_PAGES; i++) {
        try {
          pagePool.push(await warmPage(b));
          console.log(`[POOL] Página pre-calentada ${pagePool.length}/${WARM_PAGES}`);
        } catch (e) {
          console.error('[POOL] warmPage error:', e.message);
        }
      }
    })();

  } catch (error) {
    console.error('Error al iniciar:', error);
    process.exit(1);
  }
}

start();
