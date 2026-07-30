const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const RED = '\x1b[31m';
const GRN = '\x1b[32m';
const YLW = '\x1b[33m';
const BLU = '\x1b[34m';
const MGN = '\x1b[35m';
const CYN = '\x1b[36m';

function bold(t) { return `${B}${t}${R}`; }
function dim(t) { return `${D}${t}${R}`; }
function green(t) { return `${GRN}${t}${R}`; }
function yellow(t) { return `${YLW}${t}${R}`; }
function red(t) { return `${RED}${t}${R}`; }
function blue(t) { return `${BLU}${t}${R}`; }
function cyan(t) { return `${CYN}${t}${R}`; }

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

  return {
    header, section, divider, step, data,
    warn, error, info, success,
    summary, footer, raw,
  };
}
