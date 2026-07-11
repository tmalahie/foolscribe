import cookieParser from 'cookie-parser';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { resetStaleAnalyses } from './analysis/jobs';
import { config } from './config';
import { initDb } from './db';
import { errorMiddleware } from './errors';
import { authRouter } from './routes/auth';
import { recordingsRouter } from './routes/recordings';
import { rehearsalsRouter } from './routes/rehearsals';
import { syncRouter } from './routes/sync';

const app = express();
app.set('trust proxy', 1); // derrière nginx en prod
app.use(express.json());
app.use(cookieParser());

app.get('/api/config', (_req, res) => {
  res.json({ googleClientId: config.google.clientId });
});
app.use('/api/auth', authRouter);
app.use('/api/rehearsals', rehearsalsRouter);
app.use('/api/recordings', recordingsRouter);
app.use('/api/sync', syncRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Route API inconnue' });
});

// En prod, le serveur peut aussi servir le build front (nginx le fait sinon).
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.use(errorMiddleware);

async function main() {
  await initDb();
  await resetStaleAnalyses();
  app.listen(config.port, () => {
    console.log(`foolscribe server à l'écoute sur le port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('Démarrage impossible :', err);
  process.exit(1);
});
