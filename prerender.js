/**
 * Prerender script — generates static HTML for SEO bots.
 * Starts a local server, renders each page with Playwright,
 * injects a <noscript> fallback, and writes rendered HTML to dist/.
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SRC_DIR = __dirname;
const DIST_DIR = path.join(__dirname, 'dist');
const PORT = 4321;

// Recursively copy directory with Node fs (no shell)
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '.git') continue;
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

const PAGES = [
  { file: 'index.html',               url: `http://localhost:${PORT}/index.html`,               out: 'index.html' },
  { file: 'catalog.html',             url: `http://localhost:${PORT}/catalog.html`,             out: 'catalog.html' },
  { file: 'dizainerski-remont.html',  url: `http://localhost:${PORT}/dizainerski-remont.html`,  out: 'dizainerski-remont.html' },
];

// Minimal static file server
function startServer() {
  const mime = { html:'text/html', css:'text/css', js:'application/javascript',
    jpeg:'image/jpeg', jpg:'image/jpeg', png:'image/png', svg:'image/svg+xml',
    json:'application/json', xml:'application/xml', txt:'text/plain', ico:'image/x-icon' };

  const server = http.createServer((req, res) => {
    let filePath = path.join(SRC_DIR, req.url.split('?')[0]);
    if (filePath.endsWith('/')) filePath += 'index.html';
    const ext = path.extname(filePath).slice(1).toLowerCase();
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  });
  return new Promise(resolve => server.listen(PORT, () => resolve(server)));
}

async function prerender() {
  // Prepare dist dir — copy everything from src using Node fs (no shell)
  if (fs.existsSync(DIST_DIR)) fs.rmSync(DIST_DIR, { recursive: true });
  copyDir(SRC_DIR, DIST_DIR);
  // Remove dist from dist (in case of re-runs)
  const distInDist = path.join(DIST_DIR, 'dist');
  if (fs.existsSync(distInDist)) fs.rmSync(distInDist, { recursive: true });

  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext();

  for (const page of PAGES) {
    console.log(`Rendering ${page.file}...`);
    const tab = await context.newPage();

    // Wait for network idle so all JS has run
    await tab.goto(page.url, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for #app to have children (JS rendered)
    await tab.waitForSelector('#app > *', { timeout: 15000 }).catch(() => {});

    const html = await tab.evaluate(() => {
      // Remove all inline <script> tags containing app JS (keep only tailwind config)
      document.querySelectorAll('script:not([type="application/ld+json"])').forEach(s => {
        // Keep tailwind CDN and config scripts
        if (s.src && s.src.includes('tailwindcss')) return;
        if (!s.src && s.textContent.includes('tailwind.config')) return;
        s.remove();
      });
      // Mark as prerendered so app JS skips re-render if ever re-added
      document.getElementById('app').setAttribute('data-prerendered', '1');
      return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    });

    const outPath = path.join(DIST_DIR, page.out);
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(`  ✓ ${page.out} (${Math.round(html.length / 1024)}kb)`);
    await tab.close();
  }

  await browser.close();
  server.close();
  console.log('\nPrerender complete → dist/');
}

prerender().catch(err => {
  console.error('Prerender failed:', err);
  process.exit(1);
});
