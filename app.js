const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const corsOptions = require('./config/cors');
const { apiLimiter } = require('./middleware/rate-limiter');
const config = require('./config/index');
const logger = require('./config/logger');
const requestLogger = require('./middleware/request-logger');
const correlationIdMiddleware = require('./middleware/correlation-id');
const errorHandler = require('./middleware/error-handler');
const sanitizeInput = require('./middleware/sanitize-input');
const AppError = require('./utils/AppError');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');

const app = express();

// Trust reverse proxy (required for Render/Heroku to get real client IP for rate limiting)
app.set('trust proxy', 1);

// Mount Swagger Documentation UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));

// Note: MongoDB is now connected in index.js, not app.js, to keep testing clean.

// Epic 2.1: Security Headers
app.use(helmet({ 
  contentSecurityPolicy: false, 
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  xssFilter: true, 
  noSniff: true, 
  hsts: true, 
  frameguard: { action: 'deny' } 
}));

// Epic 2.2: CORS Configuration
app.use(cors(corsOptions));

// Epic 2.3: Rate Limiting (apply to all API routes)
app.use('/api', apiLimiter);

// Epic 2.4: Input Sanitization & Body Parser
app.use(express.json({ limit: '10kb' }));
app.use(sanitizeInput);

// Generate Unique Request ID
app.use(correlationIdMiddleware);

// Request Logger Middleware (Morgan + Winston)
app.use(requestLogger);

// 🔄 Time-Aware Keep-Alive: first user request of the day wakes the server ping timer.
// Timer logic + cutoff configured in utils/keep-alive.js, initialised by index.js.
app.use(require('./utils/keep-alive').middleware);

// Routes
app.get('/api/health', (req, res) => {
  res.json({
    status: 'success',
    message: 'System is online and operating optimally.',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.use('/api/features', require('./routes/features'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/webhooks', require('./routes/webhooks'));
// Fallback Route for Undefined Paths
app.use((req, res, next) => {
  next(AppError.notFound(`Route ${req.originalUrl}`));
});

// Global Error Handling Middleware
app.use(errorHandler);

module.exports = app;
