const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const https = require('https');
const cors = require('cors');
const { exec } = require('child_process');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

// Configurar CORS para permitir todos los orígenes
app.use(cors());

let sessions = {};

// Función de espera personalizada
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function initPuppeteer(token) {
  exec('Xvfb :99 -screen 0 1280x1024x16 &', (error) => {
    if (error) {
      console.error(`Error al iniciar Xvfb: ${error.message}`);
      return;
    }
    console.log('Xvfb iniciado');
  });

  const browser = await puppeteer.launch({ 
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--display=:99']
  });
  const page = await browser.newPage();
  await page.goto('https://chat.openai.com/', { waitUntil: 'networkidle2' });

  const checkTextarea = async () => {
    try {
      await page.waitForSelector('textarea', { timeout: 10000 });
      console.log('Textarea encontrado');
      return true;
    } catch (error) {
      console.error('No se encontró el campo de entrada de texto');
      return false;
    }
  };

  const retryOnError = async (attempts) => {
    let isTextareaFound = await checkTextarea();
    while (!isTextareaFound && attempts > 0) {
      console.log(`Reintentando... Intentos restantes: ${attempts}`);
      await page.reload({ waitUntil: 'networkidle2' });
      isTextareaFound = await checkTextarea();
      attempts--;
    }
    return isTextareaFound;
  };

  const maxAttempts = 3;
  const isTextareaFound = await retryOnError(maxAttempts);
  if (!isTextareaFound) {
    console.error('Fallo la inicialización: no se encontró el campo de entrada de texto después de varios intentos');
    throw new Error('Fallo la inicialización: no se encontró el campo de entrada de texto después de varios intentos');
  }

  sessions[token] = { browser, page, lastActivity: Date.now() };
}


// Función para enviar un mensaje y obtener la respuesta de ChatGPT
async function sendMessageAndGetResponse(token, message) {
  const session = sessions[token];
  if (!session) {
    throw new Error('Sesión no encontrada o expirada.');
  }

  const { page } = session;
  await page.type('textarea', message);
  await page.keyboard.press('Enter');
  await wait(20000); // Esperar 20 segundos

  // Esperar a que el mensaje del usuario aparezca en la página
  await page.waitForSelector(`[data-message-author-role="user"]:last-child`);

 

  // Esperar a que aparezca la nueva respuesta del asistente
  const newResponse = await page.evaluate(async () => {
    const selector = '.markdown.prose.w-full.break-words';
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    let responseText = '';
    let newMessageGenerated = false;
    let retries = 0;
    let lastMessageId = '';

    while (!newMessageGenerated && retries < 160) { // Esperar hasta 160 segundos
      const responseMessages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
      const lastMessage = responseMessages[responseMessages.length - 1];
      console.log(responseMessages);

      if (lastMessage) {
        const currentMessageId = lastMessage.getAttribute('data-message-id');
        if (currentMessageId !== lastMessageId) {
          const element = lastMessage.querySelector(selector);
          if (element) {
            responseText = element.innerText;
            newMessageGenerated = true;
            lastMessageId = currentMessageId;
          }
        }
      }

      await sleep(10000);
      retries++;
    }

    if (!newMessageGenerated) {
      throw new Error("No se pudo obtener una nueva respuesta de ChatGPT en el tiempo esperado.");
    }

    return responseText;
  });

  session.lastActivity = Date.now();
  return newResponse;
}

// Endpoint para inicializar una nueva sesión
app.post('/init', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token no proporcionado' });
  }

  if (sessions[token]) {
    return res.json({ session: true ,message: 'Ya tienes una sesión activa', token });
  }

  try {
    await initPuppeteer(token);
    res.json({session: false, message: 'Sesión inicializada', token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para enviar un mensaje y recibir la respuesta
app.post('/chat', async (req, res) => {
  const { token, message } = req.body;
  if (!token || !message) {
    return res.status(400).json({ error: 'Token o mensaje no proporcionado' });
  }

  try {
    const response = await sendMessageAndGetResponse(token, message);
    res.json({ response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para cerrar un cliente específico por token
app.post('/close-session', (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token no proporcionado' });
  }

  const session = sessions[token];
  if (session) {
    session.browser.close();
    delete sessions[token];
    res.json({ message: `Sesión con token ${token} cerrada` });
  } else {
    res.status(404).json({ error: 'Sesión no encontrada' });
  }
});

// Endpoint para cerrar todas las sesiones
app.post('/close-all-sessions', (req, res) => {
  for (const [token, session] of Object.entries(sessions)) {
    session.browser.close();
    delete sessions[token];
  }
  res.json({ message: 'Todas las sesiones han sido cerradas' });
});

// Función para cerrar sesiones inactivas
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of Object.entries(sessions)) {
    if (now - session.lastActivity > 2.5 * 60 * 1000) { // 2.5 minutos
      session.browser.close();
      delete sessions[token];
      console.log(`Sesión con token ${token} cerrada por inactividad.`);
    }
  }
}, 60 * 1000); // Verificar cada minuto


// Lee los certificados SSL
const privateKey = fs.readFileSync('/etc/letsencrypt/live/dendenmushi.space/privkey.pem', 'utf8');
const certificate = fs.readFileSync('/etc/letsencrypt/live/dendenmushi.space/fullchain.pem', 'utf8');

const credentials = { key: privateKey, cert: certificate };

// Inicializar Puppeteer y luego iniciar el servidor Express
(async () => {
  const httpsServer = https.createServer(credentials, app);
  httpsServer.listen(3001, () => {
    console.log('Servidor HTTPS corriendo en https://localhost:3001');
  });
})();
