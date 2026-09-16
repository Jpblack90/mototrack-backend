import 'dotenv/config';
import { analyzeProductImage } from '../src/modules/inventory/inventory.aiClient.js';

// PNG 1x1 pixel azul — formato PNG mínimo válido reconocido por la API de visión.
// Base64 de 68 bytes, verificado como PNG bien formado.
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const mimeType = 'image/png';

console.log('Modelo: gemini-3.5-flash-lite | thinkingLevel: minimal\n');

console.log('--- Medicion 1 ---');
const r1 = await analyzeProductImage({ imageBase64, mimeType });
console.log(JSON.stringify({ medicion: 1, latency_ms: r1.latency_ms, detected_name: r1.detected_name, detected_brand: r1.detected_brand, confidence: r1.confidence }, null, 2));

console.log('\n--- Medicion 2 ---');
const r2 = await analyzeProductImage({ imageBase64, mimeType });
console.log(JSON.stringify({ medicion: 2, latency_ms: r2.latency_ms, detected_name: r2.detected_name, detected_brand: r2.detected_brand, confidence: r2.confidence }, null, 2));

console.log('\n--- Resumen ---');
console.log(JSON.stringify({
  medicion_1_ms: r1.latency_ms,
  medicion_2_ms: r2.latency_ms,
  rf01_cumple: r1.latency_ms < 4000 || r2.latency_ms < 4000,
}, null, 2));

process.exit(0);
