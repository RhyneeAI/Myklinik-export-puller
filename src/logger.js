const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YLW = '\x1b[33m';
const BLU = '\x1b[34m';
const MGN = '\x1b[35m';
const CYN = '\x1b[36m';

export function bold(t) { return `${B}${t}${R}`; }
export function dim(t) { return `${D}${t}${R}`; }
export function green(t) { return `${GRN}${t}${R}`; }
export function yellow(t) { return `${YLW}${t}${R}`; }
export function red(t) { return `${RED}${t}${R}`; }
export function blue(t) { return `${BLU}${t}${R}`; }
export function cyan(t) { return `${CYN}${t}${R}`; }

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const TL = '┌'; const TR = '┐';
const BL = '└'; const BR = '┘';
const VL = '│'; const HL = '─';
const MA = '┬'; const MB = '┴';
const ML = '├'; const MR = '┤';
const CC = '┼';

let _tableCols = [];

// Progress bar state -- lives on its own unfinished line (no trailing \n)
// so it can be redrawn in place. Any other log function must clear it
// first (via println below) so its old text doesn't bleed into the next
// printed line.
let _progressActive = false;
let _progressLineLen = 0;

function clearProgressLine() {
  if (_progressActive) {
    process.stdout.write('\r' + ' '.repeat(_progressLineLen) + '\r');
    _progressActive = false;
    _progressLineLen = 0;
  }
}

// Every other log function should call this instead of console.log directly,
// so it plays nicely with an in-progress progress bar.
function println(...args) {
  clearProgressLine();
  console.log(...args);
}

export function createLogger(projectName, version) {
  function progressBar(current, total, label = '') {
    if (!process.stdout.isTTY) {
      // Non-interactive output (piped/redirected) -- skip the redraw dance,
      // just leave the last real log line as-is.
      return;
    }
    clearProgressLine();
    const width = 28;
    const pct = total > 0 ? Math.min(1, current / total) : 0;
    const filled = Math.round(width * pct);
    const bar = green('█'.repeat(filled)) + dim('░'.repeat(width - filled));
    const pctText = String(Math.round(pct * 100)).padStart(3) + '%';
    const line = `  [${bar}] ${pctText} (${current}/${total})${label ? ' ' + dim(label) : ''}`;
    process.stdout.write(line);
    _progressLineLen = stripAnsi(line).length;
    _progressActive = true;
  }

  function endProgress() {
    if (_progressActive) {
      process.stdout.write('\n');
      _progressActive = false;
      _progressLineLen = 0;
    }
  }

  function header(target, mode) {
    divider();
    println(`# ${bold(projectName)} ${dim('v' + version)}`);
    println();
    println(`**Target:** ${target}  **Mode:** ${mode}`);
    println();
  }

  function divider() {
    println('---');
    println();
  }

  function section(title) {
    divider();
    println(`## ${bold(title)}`);
    println();
  }

  function step(text) {
    println(text);
  }

  function data(label, statusText, extra = '') {
    const icon = statusText === 'SAVED' ? green('✓') :
                 statusText === 'SKIP'  ? yellow('-') :
                 statusText === 'FAIL'  ? red('x') :
                 statusText === 'DONE'  ? green('✓') : '';
    const s = statusText === 'SAVED' ? green(statusText) :
              statusText === 'SKIP'  ? yellow(statusText) :
              statusText === 'FAIL'  ? red(statusText)   :
              statusText === 'DONE'  ? green(statusText) : statusText;
    println(`  ${icon} ${dim(label)} ${s}${extra ? dim(' (' + extra + ')') : ''}`);
  }

  function warn(text) {
    println(yellow('  Warning: ' + text));
  }

  function error(text) {
    println(red('  Error: ' + text));
  }

  function info(text) {
    println('  ' + text);
  }

  function success(text) {
    println(green('  ' + text));
  }

  function summary(items) {
    println();
    println('---');
    println(bold('Summary'));
    for (const item of items) {
      if (item) println('- ' + item);
    }
    println();
  }

  function footer() {
    endProgress();
    println();
  }

  function raw(...args) {
    println(...args);
  }

  function clickableUrl(metadata, fullUrl) {
    const OSC8 = '\x1b]8;;';
    const ST = '\x1b\\';
    const label = metadata || fullUrl;
    println(`  ${dim('→')} ${OSC8}${fullUrl}${ST}${dim(label)}${ST}${OSC8}${ST}`);
  }

  function startTable(columns) {
    _tableCols = columns.map(c => ({
      ...c,
      width: Math.max(c.label.length + 2, (c.width || 10) + 2),
    }));
    const top = _tableCols.map((c, i) =>
      HL.repeat(c.width) + (i < _tableCols.length - 1 ? MA : '')
    ).join('');
    println(`  ${TL}${top}${TR}`);

    const hdr = _tableCols.map((c, i) =>
      ' ' + padCenter(c.label, c.width - 2) + ' ' + (i < _tableCols.length - 1 ? VL : '')
    ).join('');
    println(`  ${VL}${hdr}${VL}`);

    const sep = _tableCols.map((c, i) =>
      HL.repeat(c.width) + (i < _tableCols.length - 1 ? CC : '')
    ).join('');
    println(`  ${ML}${sep}${MR}`);
  }

  function tableRow(values) {
    const row = _tableCols.map((c, i) => {
      const val = values[i] !== undefined ? String(values[i]) : '';
      const plain = stripAnsi(val);
      const padNeeded = c.width - 2 - plain.length;
      if (padNeeded >= 0) {
        return ' ' + val + ' '.repeat(padNeeded) + ' ' + (i < _tableCols.length - 1 ? VL : '');
      }
      const truncated = plain.slice(0, c.width - 5) + '...';
      return ' ' + truncated + ' ' + (i < _tableCols.length - 1 ? VL : '');
    }).join('');
    println(`  ${VL}${row}${VL}`);
  }

  function endTable() {
    const bot = _tableCols.map((c, i) =>
      HL.repeat(c.width) + (i < _tableCols.length - 1 ? MB : '')
    ).join('');
    println(`  ${BL}${bot}${BR}`);
    _tableCols = [];
  }

  return {
    header, section, divider, step, data,
    warn, error, info, success,
    summary, footer, raw, clickableUrl,
    startTable, tableRow, endTable,
    progressBar, endProgress,
  };
}

function padCenter(s, w) {
  const pad = w - stripAnsi(s).length;
  if (pad <= 0) return s.slice(0, w);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return ' '.repeat(left) + s + ' '.repeat(right);
}
