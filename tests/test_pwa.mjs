import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const rendererDir = path.join(projectRoot, 'renderer');

test('Tüm renderer/*.js ve electron/*.cjs dosyaları sözdizimi (node --check) kontrolünden geçer', () => {
  for (const dir of [rendererDir, path.join(projectRoot, 'electron')]) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.js') || file.endsWith('.cjs')) {
        execFileSync(process.execPath, ['--check', path.join(dir, file)], { stdio: 'pipe' });
      }
    }
  }
});

test('Mobil PWA: Manifest, gerçek PNG simgeler (180/192/512), Service Worker, iOS/Android meta ve alt mobil menü', () => {
  const manifestPath = path.join(rendererDir, 'manifest.webmanifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './index.html');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);

  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), '192x192 simgesi eksik');
  assert.ok(sizes.includes('512x512'), '512x512 simgesi eksik');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'maskable simge eksik');

  // Tüm PNG simgeler gerçekten diskte ve geçerli PNG başlığına sahip olmalı
  for (const rel of ['assets/icon-192.png', 'assets/icon-512.png', 'assets/icon-maskable-512.png', 'assets/apple-touch-icon.png']) {
    const abs = path.join(rendererDir, rel);
    assert.ok(fs.existsSync(abs), `PWA simgesi bulunamadı: ${rel}`);
    const hdr = fs.readFileSync(abs).subarray(0, 8);
    assert.deepEqual(Array.from(hdr), [137, 80, 78, 71, 13, 10, 26, 10], `Geçersiz PNG başlığı: ${rel}`);
  }

  // Service Worker tüm zorunlu dosyaları önbelleğe almalı ve /wp-json/ isteklerini atlamalı
  const sw = fs.readFileSync(path.join(rendererDir, 'sw.js'), 'utf8');
  for (const asset of ['./index.html', './app.js', './duty_module.js', './pwa_install.js', './assets/icon-192.png', './assets/icon-512.png']) {
    assert.ok(sw.includes(asset), `sw.js önbellek listesinde eksik: ${asset}`);
  }
  assert.ok(sw.includes('/wp-json/'), 'sw.js API isteklerini önbellek dışı bırakmalı');
  assert.ok(sw.includes('isCodeOrStyle'), 'sw.js JS/CSS dosyaları için Network-First kullanmalı');

  // HTML mobil PWA meta etiketleri ve alt gezinme çubuğu
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  assert.ok(html.includes('viewport-fit=cover'));
  assert.ok(html.includes('apple-mobile-web-app-capable'));
  assert.ok(html.includes('apple-touch-icon.png'));
  assert.ok(html.includes('id="btnMobilePwaInstall"'));
  assert.ok(html.includes('id="mobileBottomNav"'));
  assert.ok(html.includes('./pwa_install.js'));
});
