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

const TL = '\u250C'; const TR = '\u2510';
const BL = '\u2514'; const BR = '\u2518';
const VL = '\u2502'; const HL = '\u2500';
const MA = '\u252C'; const MB = '\u2534';
const ML = '\u251C'; const MR = '\u2524';
const CC = '\u253C';

let _tableCols = [];

export function createLogger(projectName, version) {
  function header(target, mode) {
    divider();
    console.log(`# ${bold(projectName)} ${dim('v' + version)}`);
    console.log();
    console.log(`**Target:** ${target}  **Mode:** ${mode}`);
    console.log();
  }

  function divider() {
    console.log('---');
    console.log();
  }

  function section(title) {
    divider();
    console.log(`## ${bold(title)}`);
    console.log();
  }

  function step(text) {
    console.log(text);
  }

  function data(label, statusText, extra = '') {
    const icon = statusText === 'SAVED' ? green('\u2713') :
                 statusText === 'SKIP'  ? yellow('-') :
                 statusText === 'FAIL'  ? red('x') :
                 statusText === 'DONE'  ? green('\u2713') : '';
    const s = statusText === 'SAVED' ? green(statusText) :
              statusText === 'SKIP'  ? yellow(statusText) :
              statusText === 'FAIL'  ? red(statusText)   :
              statusText === 'DONE'  ? green(statusText) : statusText;
    console.log(`  ${icon} ${dim(label)} ${s}${extra ? dim(' (' + extra + ')') : ''}`);
  }

  function warn(text) {
    console.log(yellow('  Warning: ' + text));
  }

  function error(text) {
    console.log(red('  Error: ' + text));
  }

  function info(text) {
    console.log('  ' + text);
  }

  function success(text) {
    console.log(green('  ' + text));
  }

  function summary(items) {
    console.log();
    console.log('---');
    console.log(bold('Summary'));
    for (const item of items) {
      if (item) console.log('- ' + item);
    }
    console.log();
  }

  function footer() {
    console.log();
  }

  function raw(...args) {
    console.log(...args);
  }

  function startTable(columns) {
    _tableCols = columns.map(c => ({
      ...c,
      width: Math.max(c.label.length + 2, (c.width || 10) + 2),
    }));
    const top = _tableCols.map((c, i) =>
      HL.repeat(c.width) + (i < _tableCols.length - 1 ? MA : '')
    ).join('');
    console.log(`  ${TL}${top}${TR}`);

    const hdr = _tableCols.map((c, i) =>
      ' ' + padCenter(c.label, c.width - 2) + ' ' + (i < _tableCols.length - 1 ? VL : '')
    ).join('');
    console.log(`  ${VL}${hdr}${VL}`);

    const sep = _tableCols.map((c, i) =>
      HL.repeat(c.width) + (i < _tableCols.length - 1 ? CC : '')
    ).join('');
    console.log(`  ${ML}${sep}${MR}`);
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
    console.log(`  ${VL}${row}${VL}`);
  }

  function endTable() {
    const bot = _tableCols.map((c, i) =>
      HL.repeat(c.width) + (i < _tableCols.length - 1 ? MB : '')
    ).join('');
    console.log(`  ${BL}${bot}${BR}`);
    _tableCols = [];
  }

  return {
    header, section, divider, step, data,
    warn, error, info, success,
    summary, footer, raw,
    startTable, tableRow, endTable,
  };
}

function padCenter(s, w) {
  const pad = w - stripAnsi(s).length;
  if (pad <= 0) return s.slice(0, w);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return ' '.repeat(left) + s + ' '.repeat(right);
}
