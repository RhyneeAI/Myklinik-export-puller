import { chromium } from 'playwright';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const ENDPOINT_URL = process.env.ENDPOINT_URL || 'https://apps.myklinik.id';
const BASE = ENDPOINT_URL.replace(/\/+$/, '');

let context = null;
let tempProfileDir = null;

export async function createContext() {
  tempProfileDir = path.join(process.env.TEMP || 'D:\\temp', 'pw-chrome-' + Date.now());

  context = await chromium.launchPersistentContext(tempProfileDir, {
    channel: 'chrome',
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    args: ['--no-first-run', '--disable-default-apps', '--no-default-browser-check'],
    locale: 'id-ID',
  });

  return context;
}

export async function close() {
  if (context) {
    try { await context.close(); } catch {}
    context = null;
  }
  if (tempProfileDir) {
    try {
      const fs = await import('fs');
      fs.rmSync(tempProfileDir, { recursive: true, force: true });
    } catch {}
    tempProfileDir = null;
  }
}
