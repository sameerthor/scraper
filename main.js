const { app, BrowserWindow,ipcMain } = require('electron');
const { createWorker } = require('tesseract.js');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const express = require('express');

// Configuration
const dirPath = 'G:/electron';
if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
const PORT = 3000;

// Utility function
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Express Server Setup
const expressApp = express();
expressApp.use(express.json());

// Global window reference
let mainWindow;

/**
 * Extract and recognize captcha from window
 */
async function extractAndRecognizeCaptcha(win) {
  try {
    const base64Image = await win.webContents.executeJavaScript(`
      (function() {
        try {
          const canvas = document.getElementById('captchaCanvas');
          return canvas ? canvas.toDataURL('image/png') : null;
        } catch (err) {
          console.error('❌ Error accessing captcha canvas:', err);
          return null;
        }
      })();
    `);

    if (!base64Image) throw new Error('Captcha canvas not found');

    const timestamp = Date.now();
    const imageBuffer = Buffer.from(base64Image.split(',')[1], 'base64');
    
    // Save raw image for debugging
    const rawPath = path.join(dirPath, `captcha_raw_${timestamp}.png`);
    //fs.writeFileSync(rawPath, imageBuffer);
    console.log('✅ Raw captcha saved at:', rawPath);

    // Process image for better OCR
    const processedBuffer = await sharp(imageBuffer)
      .grayscale()
      .threshold(150)
      .toBuffer();

    const cleanPath = path.join(dirPath, `captcha_clean_${timestamp}.png`);
    //fs.writeFileSync(cleanPath, processedBuffer);
    console.log('✅ Cleaned captcha saved at:', cleanPath);

    // OCR Processing
    const worker = await createWorker('eng', 1);
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    });

    const { data: { text } } = await worker.recognize(processedBuffer);
    await worker.terminate();

    const captchaText = text.trim();
    console.log('🔍 OCR Result:', captchaText);
    return captchaText;
  } catch (error) {
    console.error('❌ Error in extractAndRecognizeCaptcha:', error);
    throw error;
  }
}

/**
 * Fill captcha and submit form
 */
async function fillCaptchaAndSubmit(win, captchaText) {
  return win.webContents.executeJavaScript(`
    (function(captcha) {
      try {
        const input = document.getElementById('customCaptchaInput');
        const button = document.getElementById('check');
        if (!input || !button) {
          throw new Error('Captcha input or check button not found');
        }
        input.value = captcha;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
        return true;
      } catch (err) {
        console.error('Error in fillCaptchaAndSubmit:', err);
        return false;
      }
    })('${captchaText}');
  `);
}

/**
 * Check if captcha failed
 */
async function isCaptchaIncorrect(win) {
  return win.webContents.executeJavaScript(`
    (function() {
      try {
        return document.body.innerText.includes("The captcha entered is incorrect");
      } catch (e) {
        console.error("Error checking captcha text:", e);
        return false;
      }
    })();
  `);
}

/**
 * Refresh captcha
 */
async function refreshCaptcha(win) {
  await win.webContents.executeJavaScript(`
    (function() {
      const refresh = document.getElementById('refresh-img');
      if (refresh) refresh.click();
    })();
  `);
  await sleep(1000); // Wait for new captcha to load
}

/**
 * Attempt to solve captcha with retries
 */
async function attemptCaptchaSolve(win, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`🔁 Attempt ${attempt} to solve captcha...`);
    try {
      const captchaText = await extractAndRecognizeCaptcha(win);
      if (!captchaText) continue;

      await fillCaptchaAndSubmit(win, captchaText);
      await sleep(1000);

      const failed = await isCaptchaIncorrect(win);
      if (!failed) {
        console.log('✅ Captcha accepted.');
        return true;
      }

      console.log('❌ Captcha incorrect. Refreshing...');
      await refreshCaptcha(win);
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error);
    }
  }
  throw new Error('All captcha attempts failed');
}

/**
 * Main automation flow
 */
async function automateMCAProcess(win, companyID) {
  try {
    // Fill search input
    await win.webContents.executeJavaScript(`
      (function(companyID) {
        try {
          const input = document.getElementById('masterdata-search-box');
          if (input) {
            input.value = companyID;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const enterEvent = new KeyboardEvent('keydown', {
              bubbles: true,
              cancelable: true,
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              which: 13
            });
            input.dispatchEvent(enterEvent);
            return true;
          }
          return false;
        } catch (err) {
          console.error('Error in input fill:', err);
          return false;
        }
      })('${companyID}');
    `);

    await sleep(1000);

    // First captcha
    await attemptCaptchaSolve(win);

    await sleep(2000);

    // Click first company
    await win.webContents.executeJavaScript(`
      (function() {
        try {
          const firstCompany = document.querySelector('td.companyname');
          if (firstCompany) {
            firstCompany.click();
            return firstCompany.innerText.trim();
          }
          throw new Error('No company name found to click');
        } catch (err) {
          console.error('Error clicking company name:', err);
          return null;
        }
      })();
    `);

    await sleep(2000);

    // Second captcha
    await attemptCaptchaSolve(win);

    await sleep(1500);

    // Extract company details
    return await win.webContents.executeJavaScript(`
      (function() {
        try {
          window.myLogger.log("SessionStorage Keys:", Object.keys(sessionStorage));
           const pageHTML = document.documentElement.outerHTML;
      window.myLogger.log("Page HTML:", pageHTML);
          const details = sessionStorage.getItem("companyDetails");
          return details ? JSON.parse(details) : null;
        } catch (err) {
          window.myLogger.log("Error reading sessionStorage:", err);
          return null;
        }
      })();
    `);
  } catch (error) {
    console.error('Automation process failed:', error);
    throw error;
  }
}

/**
 * Create Electron window and process data
 */
async function createAndProcessWindow(companyID) {
  return new Promise(async (resolve, reject) => {
    try {
      const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false
        },
        show: false // Work in background
      });

      // Error handling
      win.webContents.on('did-fail-load', (event, errorCode, errorDesc) => {
        reject(new Error(`Failed to load page: ${errorDesc}`));
      });

      // Load target URL
      await win.loadURL('https://www.mca.gov.in/content/mca/global/en/mca/master-data/MDS.html');
      console.log('✅ Page loaded successfully');

      // Process the page
      const result = await automateMCAProcess(win, companyID);
      
      // Clean up
 //     win.destroy();
      resolve(result);
    } catch (error) {
      reject(error);
    }
  });
}

// API Endpoint
expressApp.get('/fetch-company', async (req, res) => {
  try {
    const companyID = req.query.id;
    if (!companyID) {
      return res.status(400).json({ 
        success: false, 
        error: "Missing company ID parameter. Use ?id=YOUR_COMPANY_ID" 
      });
    }

    console.log(`🔍 Fetching data for company ID: ${companyID}`);
    const companyData = await createAndProcessWindow(companyID);
console.log("d",companyData)
    if (!companyData) {
      return res.status(404).json({ 
        success: false, 
        error: "Company data not found" 
      });
    }

    res.json({ 
      success: true, 
      data: companyData 
    });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Start the application
app.whenReady().then(() => {
  expressApp.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔗 Endpoint: GET /fetch-company?id=COMPANY_ID`);
  });
});

// Electron app lifecycle
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

ipcMain.on('log', (event, ...args) => {
  console.log('[Renderer Log]:', ...args);
});