const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';

const DB_H  = '\u2550';
const DB_V  = '\u2551';
const DB_TL = '\u2554';
const DB_TR = '\u2557';
const DB_BL = '\u255A';
const DB_BR = '\u255D';
const DB_T  = '\u2566';
const DB_B  = '\u2569';
const DB_L  = '\u2560';
const DB_R  = '\u2563';
const DB_X  = '\u256C';

const lastItems = [];

function pad(s, len) {
  return String(s).padEnd(len);
}

export function createLogger(projectName, version) {
  const cols = (process.stdout.columns || 100) - 2;
  const boxWidth = Math.max(60, Math.min(cols, 120));
  const contentWidth = boxWidth - 4;

  const headerText = `${BOLD}${CYAN}${projectName}${RESET} ${DIM}v${version}${RESET}`;

  function topLine() {
    console.log(`  ${DB_TL}${DB_H.repeat(boxWidth - 2)}${DB_TR}`);
  }

  function bottomLine() {
    console.log(`  ${DB_BL}${DB_H.repeat(boxWidth - 2)}${DB_BR}`);
  }

  function separator() {
    console.log(`  ${DB_L}${DB_H.repeat(boxWidth - 2)}${DB_R}`);
  }

  function boxLine(label, value = '') {
    const content = ` ${label}${value ? ' ' + value : ''}`;
    if (content.length > contentWidth) {
      const truncated = content.slice(0, contentWidth - 3) + '...';
      console.log(`  ${DB_V} ${truncated}${RESET} ${DB_V}`);
    } else {
      const padded = pad(content, contentWidth);
      console.log(`  ${DB_V} ${padded}${RESET} ${DB_V}`);
    }
  }

  function header(target, mode) {
    topLine();
    boxLine(`${headerText}`);
    separator();
    boxLine(`${WHITE}Target:${RESET} ${CYAN}${target}${RESET}    ${WHITE}Mode:${RESET} ${YELLOW}${mode}${RESET}`);
    separator();
  }

  function step(icon, text) {
    boxLine(` ${icon} ${text}`);
  }

  function data(label, status, extra = '') {
    const s = status === 'SAVED' ? `${GREEN}[${status}]${RESET}` :
              status === 'SKIP'  ? `${YELLOW}[${status}]${RESET}` :
              status === 'FAIL'  ? `${RED}[${status}]${RESET}`   :
              status === 'DONE'  ? `${GREEN}[${status}]${RESET}` :
              `[${status}]`;
    boxLine(` ${DIM}${label}${RESET}  ${s} ${DIM}${extra}${RESET}`);
  }

  function warn(text) {
    boxLine(` ${YELLOW}\u26A0${RESET} ${YELLOW}${text}${RESET}`);
  }

  function error(text) {
    boxLine(` ${RED}\u2716${RESET} ${RED}${text}${RESET}`);
  }

  function info(text) {
    boxLine(` ${BLUE}\u2139${RESET} ${text}`);
  }

  function success(text) {
    boxLine(` ${GREEN}\u2714${RESET} ${GREEN}${text}${RESET}`);
  }

  function section(title) {
    separator();
    boxLine(`${BOLD}${MAGENTA}\u25B6 ${title}${RESET}`);
    separator();
  }

  function summary(items) {
    separator();
    boxLine(`${BOLD}${WHITE}Summary${RESET}`);
    for (const item of items) {
      boxLine(` ${DIM}\u2022${RESET} ${item}`);
    }
  }

  function footer() {
    bottomLine();
    console.log();
  }

  function raw(...args) {
    console.log(...args);
  }

  return {
    topLine, bottomLine, separator, boxLine,
    header, step, data, warn, error, info, success,
    section, summary, footer, raw,
  };
}
