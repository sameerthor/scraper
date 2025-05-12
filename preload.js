const log = (...args) => require('electron').ipcRenderer.send('log', ...args);

window.addEventListener('DOMContentLoaded', () => {
  log('SessionStorage Keys:', Object.keys(sessionStorage));
  log('Company Details:', sessionStorage.getItem('companyDetails'));
});