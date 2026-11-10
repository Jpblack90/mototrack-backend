import 'dotenv/config';
import app from './src/app.js';
import { testConnection } from './src/config/database.js';
import { warmUp } from './src/modules/inventory/inventory.aiClient.js';
import { startNotPickedUpScheduler } from './src/modules/jobs/notPickedUp.scheduler.js';
import { startSubscriptionsScheduler } from './src/modules/jobs/subscriptions.scheduler.js';

const PORT = process.env.PORT ?? 4000;

async function bootstrap() {
  await testConnection(); // Falla y termina el proceso si la BD no responde

  // Precalentamiento de la conexión con Gemini — fire-and-forget.
  // No bloqueamos app.listen(): si warmUp falla solo loguea una advertencia.
  warmUp();

  // Temporizador interno para verificar motos no recogidas (RF-17)
  startNotPickedUpScheduler();

  // Temporizador interno para verificar suscripciones vencidas (Tarea 13.2)
  startSubscriptionsScheduler();

  app.listen(PORT, () => {
    console.log(`🚀  MotoTrack AI backend corriendo en http://localhost:${PORT}`);
    console.log(`📋  Health check: http://localhost:${PORT}/api/health`);
  });
}

bootstrap();
