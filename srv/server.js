'use strict';
const express = require('express');
const multer = require('multer');
const xssec = require('@sap/xssec');
const passport = require('passport');

const parseRouter = require('./routes/parse');
const uploadRouter = require('./routes/upload');
const documentsRouter = require('./routes/documents');

const app = express();
app.use(express.json());

// ── Auth ─────────────────────────────────────────────────────────────────────
const services = JSON.parse(process.env.VCAP_SERVICES || '{}');
const xsuaaService = (services.xsuaa || [])[0];

if (xsuaaService) {
  const xsuaaConfig = xsuaaService.credentials;
  passport.use('JWT', new xssec.JWTStrategy(xsuaaConfig));
  app.use(passport.initialize());
  app.use(passport.authenticate('JWT', { session: false }));
} else {
  // desenvolvimento local: skip auth
  app.use((req, _res, next) => {
    req.user = { user_name: 'local-dev', scopes: [] };
    next();
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/parse', parseRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/documents', documentsRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aidocparser-srv' }));

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`aidocparser-srv listening on ${PORT}`));
