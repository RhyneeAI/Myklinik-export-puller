import dotenv from 'dotenv';
dotenv.config();

const DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || '15000', 10);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestDelay() {
  const jitter = Math.floor(Math.random() * 3000);
  await sleep(DELAY_MS + jitter);
}

export function parseDateRange(startStr, endStr) {
  const [sy, sm] = startStr.split('-').map(Number);
  const [ey, em] = endStr.split('-').map(Number);

  const start = { year: sy, month: sm };
  const end = { year: ey, month: em };

  return { start, end };
}

export function generateMonthlyRange(start, end) {
  const months = [];
  let y = start.year;
  let m = start.month;

  while (y > end.year || (y === end.year && m >= end.month)) {
    months.push({ year: y, month: m });
    m--;
    if (m < 1) { m = 12; y--; }
  }

  return months;
}

export function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

export function formatDateDMY(year, month, day) {
  return `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
}

export function formatFileDate(year, month, day) {
  return day
    ? `${year}_${String(month).padStart(2, '0')}_${String(day).padStart(2, '0')}`
    : `${year}_${String(month).padStart(2, '0')}`;
}

export function looksLikeHTML(buffer) {
  try {
    const head = buffer.slice(0, 512).toString('utf8').toLowerCase();
    return head.includes('<!doctype html') || head.includes('<html');
  } catch {
    return false;
  }
}

export function summarizeHtml(buffer) {
  try {
    const text = buffer.toString('utf8');
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(text);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const hasLogin = /<form[^>]+action="[^"]*\/login/i.test(text) || /name="_token"/i.test(text);
    const serverError = /500|internal server error|we're sorry/i.test(text);
    return { title, hasLogin, serverError };
  } catch {
    return { title: '', hasLogin: false, serverError: false };
  }
}
