const { app, BrowserWindow, ipcMain, session } = require('electron');
const { createWorker } = require('tesseract.js');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const express = require('express');

const dirPath = 'G:/electron';
if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
const PORT = 3000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const expressApp = express();
expressApp.use(express.json());

let mainWindow;
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

async function extractAndRecognizeCaptcha(win) {
  try {
    const base64Image = await win.webContents.executeJavaScript(`
      (function() {
        try {
          const canvas = document.getElementById('captchaCanvas');
          return canvas ? canvas.toDataURL('image/png') : null;
        } catch (err) {
          console.error('Error accessing captcha canvas:', err);
          return null;
        }
      })();
    `);

    if (!base64Image) throw new Error('Captcha canvas not found');

    const imageBuffer = Buffer.from(base64Image.split(',')[1], 'base64');

      const form = new FormData();
      const imageBlob = new Blob([imageBuffer], { type: 'image/png' });
  form.append('image', imageBlob, { filename: 'captcha.png', contentType: 'image/png' });

  try {
    const response = await axios.post('http://173.231.203.186:5000/solve-captcha', form, {
     headers: {
        ...form.getHeaders?.(), // Use optional chaining to avoid errors if getHeaders is missing
        'Content-Type': 'multipart/form-data', // Manually set Content-Type as a fallback
      }
    });

    // console.log('Solved text:', response.data.captcha);
    return response.data.captcha.replace(/\s/g, "").trim();
  } catch (err) {
    console.error('Error solving captcha:', err.response?.data || err.message);
    return null;
  }
  } catch (error) {
    console.error('Captcha recognition failed:', error);
    throw error;
  }
}

async function fillCaptchaAndSubmit(win, captchaText) {
  return win.webContents.executeJavaScript(`
    (function(captcha) {
      try {
        const input = document.getElementById('customCaptchaInput');
        const button = document.getElementById('check');
        if (!input || !button) throw new Error('Captcha input or button missing');
        input.value = captcha;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => {
          button.click();
          input.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 13, bubbles: true }));
        }, 1500);
        return true;
      } catch (err) {
        console.error('Captcha fill error:', err);
        return false;
      }
    })('${captchaText}');
  `);
}

async function isCaptchaIncorrect(win) {
  return await win.webContents.executeJavaScript(`
    (() => {
      try {
        const bodyText = document.body?.innerText || "";
        const errorKeywords = [
          "The captcha entered is incorrect",
          "The captcha is expired",
          "Please enter the captcha"
        ];
        return errorKeywords.some(msg => bodyText.includes(msg));
      } catch (e) {
        console.error("Error checking captcha error:", e);
        return false;
      }
    })();
  `);
}

async function refreshCaptcha(win) {
  await win.webContents.executeJavaScript(`
    (function() {
      const refresh = document.getElementById('refresh-img');
      if (refresh) refresh.click();
    })();
  `);
  await sleep(1000);
}

async function attemptCaptchaSolve(win, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const text = await extractAndRecognizeCaptcha(win);
      if (!text) continue;
      await fillCaptchaAndSubmit(win, text);
      await sleep(2000);
      if (!(await isCaptchaIncorrect(win))) return true;
      await refreshCaptcha(win);
      await sleep(1000);
    } catch (e) {
      console.error(`Captcha attempt ${i + 1} failed:`, e);
    }
  }
  throw new Error('All captcha attempts failed');
}

async function automateMCAProcess(win, companyID) {
  try {
    await win.webContents.executeJavaScript(`
      (function(id) {
        const input = document.getElementById('masterdata-search-box');
        if (input) {
          input.value = id;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        }
      })('${companyID}');
    `);

    await sleep(2500);
    await attemptCaptchaSolve(win);
    await sleep(2000);

    const companyName = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const interval = setInterval(() => {
          const el = document.querySelector('td.companyname');
          if (el) {
            clearInterval(interval);
            el.click();
            resolve(el.innerText.trim());
          }
        }, 300);
        setTimeout(() => {
          clearInterval(interval);
          resolve(null);
        }, 10000);
      });
    `);

    await sleep(3000);
    await attemptCaptchaSolve(win);
    await sleep(3000);

    return await win.webContents.executeJavaScript(`
      (function() {
        try {
          const data = sessionStorage.getItem("companyDetails");
          return data ? JSON.parse(data) : null;
        } catch (err) {
          return null;
        }
      })();
    `);
  } catch (e) {
    console.error('Automation failed:', e);
    throw e;
  }
}

async function createAndProcessWindow(companyID) {
  return new Promise(async (resolve, reject) => {
    let win;
    try {
      win = new BrowserWindow({
        width: 1200,
        height: 800,
        show: true,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false
        }
      });

      win.webContents.on('did-fail-load', (_, code, desc) => reject(new Error(`Load fail: ${desc}`)));

      await win.loadURL('https://www.mca.gov.in/content/mca/global/en/mca/master-data/MDS.html');
      await sleep(1500);
      const result = await automateMCAProcess(win, companyID);
      win.destroy();
      resolve(result);
    } catch (err) {
      if (win) win.destroy();
      reject(err);
    }
  });
}

expressApp.get('/fetch-company', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ success: false, error: 'Missing company ID' });
    const data = await createAndProcessWindow(id);
    if (!data) return res.status(404).json({ success: false, error: 'Company data not found' });
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.whenReady().then(async () => {
  await session.defaultSession.setProxy({
    proxyRules: 'http=104.238.48.37:5427;https=104.238.48.37:5427',
    proxyBypassRules: '<-loopback>'
  });

  app.on('login', (event, webContents, request, authInfo, callback) => {
    if (authInfo.isProxy) {
      event.preventDefault();
      callback('earihumh', '7eafuflyhpsu');
    }
  });

  expressApp.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

ipcMain.on('log', (event, ...args) => console.log('[Renderer Log]:', ...args));