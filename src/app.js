import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import apiRoutes from './routes/index.js';
import { errorHandler } from './shared/middlewares/errorHandler.js';
import { getAiHealthStatus } from './modules/inventory/inventory.aiClient.js';

const app = express();

// Configuración de 'trust proxy' según variable de entorno (por defecto false para evitar spoofing de X-Forwarded-For)
const trustProxyEnv = process.env.TRUST_PROXY;
let trustProxySetting = false;
if (trustProxyEnv === 'true') {
  trustProxySetting = true;
} else if (trustProxyEnv !== undefined && trustProxyEnv !== '' && !isNaN(Number(trustProxyEnv))) {
  trustProxySetting = Number(trustProxyEnv);
} else if (trustProxyEnv) {
  trustProxySetting = trustProxyEnv;
}
app.set('trust proxy', trustProxySetting);

// ── Middlewares globales ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    ai: getAiHealthStatus(),
    timestamp: new Date().toISOString(),
  });
});

// ── Rutas de la API ─────────────────────────────────────────────────────────
app.use('/api', apiRoutes);

// ── Ruta no encontrada ───────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Ruta no encontrada' });
});

// ── Manejo global de errores (debe ser el último middleware) ─────────────────
app.use(errorHandler);

export default app;
