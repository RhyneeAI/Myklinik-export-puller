import { createContext, close } from './src/browser.js';

const ctx = await createContext();
const p = await ctx.newPage();

await p.goto('https://apps.myklinik.id/', { waitUntil: 'load', timeout: 30000 });
await p.waitForSelector('[id="Pendaftaran"]', { timeout: 15000 });

// Try multiple navigation methods
const tests = [
  ['Method 1: el.click()', () => {
    const clickById = (id) => { const el = document.getElementById(id); if (el) { (el.closest('a') || el).click(); } };
    clickById('Pendaftaran');
    clickById('Report Pendaftaran');
    const link = document.querySelector('a[href="#klinik/report/infodaftarharian/infodaftarharian"]');
    if (link) link.click();
  }],
  ['Method 2: dispatchEvent MouseEvent', () => {
    [['Pendaftaran'], ['Report Pendaftaran']].forEach(([id]) => {
      const el = document.getElementById(id)?.closest('a');
      if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });
    const link = document.querySelector('a[href="#klinik/report/infodaftarharian/infodaftarharian"]');
    if (link) link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }],
  ['Method 3: jQuery trigger', () => {
    if (window.$) {
      $('[id="Pendaftaran"]').closest('a').trigger('click');
      $('[id="Report Pendaftaran"]').closest('a').trigger('click');
      $('a[href="#klinik/report/infodaftarharian/infodaftarharian"]').trigger('click');
    }
  }],
];

for (const [name, fn] of tests) {
  console.log(`\n=== ${name} ===`);
  const p2 = await ctx.newPage();
  await p2.goto('https://apps.myklinik.id/', { waitUntil: 'load', timeout: 30000 });
  await p2.waitForSelector('[id="Pendaftaran"]', { timeout: 15000 });
  await p2.evaluate(fn);
  await new Promise(r => setTimeout(r, 5000));
  console.log('Hash:', await p2.evaluate(() => window.location.hash));
  console.log('Has Cari:', !!(await p2.$('button:has-text("Cari")')));
  await p2.close();
}

await close();
