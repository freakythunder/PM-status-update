require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const winston = require('winston');

const GoogleAuthManager = require('./utils/googleAuth');
const MessageRewriteService = require('./services/messageRewriteService');
const { 
  connectToMongoDB, 
  User, 
  GmailMessage, 
  ChatMessage,
  getAllActiveUsers,
  updateUserTokens,
  createOrUpdateUser,
  getUserByEmail,
  healthCheck,
  getDashboardStats,
  getUserStats,
  getRecentSyncLogs,
  getLatestLLMAnalysisResults,
  getAllLLMAnalysisResults
} = require('./utils/mongodb');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ 
      filename: 'server.log',
      format: winston.format.json()
    })
  ]
});

const app = express();
const port = process.env.PORT || 3000;
// Trust proxy for localtunnel - Add this line
app.set('trust proxy', 1);
// Initialize Google Auth Manager
let googleAuth;
try {
  googleAuth = new GoogleAuthManager();
} catch (error) {
  logger.error('Failed to initialize Google Auth Manager:', error);
  process.exit(1);
}

// Initialize Message Rewrite Service
let messageRewriteService;
try {
  messageRewriteService = new MessageRewriteService();
} catch (error) {
  logger.error('Failed to initialize Message Rewrite Service:', error);
}

// Middleware
app.use(helmet());
app.use(cors()); // New CORS configuration: Allow all origins

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Store auth states temporarily (in production, use Redis or database)
const authStates = new Map();

// Routes

// Endpoint to serve latest LLM analysis responses from MongoDB
app.get('/api/latest-responses', async (req, res) => {
  try {
    const latestResults = await getLatestLLMAnalysisResults();
    
    if (!latestResults) {
      return res.status(404).json({ 
        error: 'No analysis results found',
        generated_at: new Date().toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          day: '2-digit',
          month: '2-digit', 
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        }).replace(/(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})/, '$1/$2/$3, $4:$5:$6'),
        total_responses: 0,
        responses: []
      });
    }
    
    res.json(latestResults);
    
  } catch (error) {
    logger.error('Error fetching latest LLM analysis results from MongoDB:', error);
    res.status(500).json({ error: 'Failed to fetch analysis results from database' });
  }
});

// New endpoint to get all analysis results with pagination
app.get('/api/analysis-history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const results = await getAllLLMAnalysisResults(limit);
    
    res.json({
      total_results: results.length,
      results: results
    });
    
  } catch (error) {
    logger.error('Error fetching LLM analysis history from MongoDB:', error);
    res.status(500).json({ error: 'Failed to fetch analysis history from database' });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const dbHealth = await healthCheck();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: dbHealth,
      version: '1.0.0'
    });
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Database connection failed'
    });
  }
});

// Welcome page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>PM Assistant - OAuth Server</title>
        <style>
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                max-width: 800px; 
                margin: 50px auto; 
                padding: 20px;
                background: #f5f5f5;
                color: #333;
            }
            .container {
                background: white;
                padding: 40px;
                border-radius: 12px;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            }
            h1 { color: #2563eb; margin-bottom: 30px; }
            .feature {
                background: #f8fafc;
                padding: 20px;
                margin: 15px 0;
                border-radius: 8px;
                border-left: 4px solid #2563eb;
            }
            .btn {
                display: inline-block;
                padding: 12px 24px;
                background: #2563eb;
                color: white;
                text-decoration: none;
                border-radius: 6px;
                margin: 10px 5px 0 0;
                transition: background 0.2s;
            }
            .btn:hover { background: #1d4ed8; }
            .btn.secondary {
                background: #6b7280;
            }
            .btn.secondary:hover { background: #4b5563; }
            .status {
                padding: 10px;
                border-radius: 4px;
                margin: 10px 0;
                background: #dcfce7;
                border: 1px solid #16a34a;
                color: #166534;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 PM Assistant - OAuth Server</h1>
            <div class="status">
                ✅ Server is running on port ${port}
            </div>            <p>Welcome to the PM Assistant backend server! This system automatically collects Gmail data for AI-powered project management insights.</p>
            
            <div class="feature">
                <h3>🔐 OAuth Authentication</h3>
                <p>Grant secure access to your Gmail data</p>
                <a href="/auth" class="btn">Start OAuth Setup</a>
            </div>
            
            <div class="feature">
                <h3>📊 Data Dashboard</h3>
                <p>View collected data structure and statistics</p>
                <a href="http://localhost:${process.env.DASHBOARD_PORT || 4000}/dashboard" class="btn secondary">Open Dashboard</a>
            </div>
            
            <div class="feature">
                <h3>🔍 API Endpoints</h3>
                <p>Available endpoints:</p>
                <ul>
                    <li><code>GET /health</code> - Health check</li>
                    <li><code>GET /auth</code> - Start OAuth flow</li>
                    <li><code>GET /auth/callback</code> - OAuth callback</li>
                    <li><code>GET /stats</code> - System statistics</li>
                </ul>
            </div>
            
            <div class="feature">
                <h3>⚙️ Automatic Data Collection</h3>                <p>Data is automatically fetched every ${process.env.FETCH_INTERVAL_MINUTES || 10} minutes from:</p>
                <ul>
                    <li>Google Chat spaces and messages</li>
                    <li>Google Gmail messages and metadata</li>
                </ul>
            </div>
        </div>
    </body>
    </html>
  `);
});

// Start OAuth flow
app.get('/auth', (req, res) => {
  try {
    const { authUrl, state } = googleAuth.generateAuthUrl();
    
    // Store state temporarily (expires in 10 minutes)
    authStates.set(state, { timestamp: Date.now() });
    
    // Clean up old states
    setTimeout(() => authStates.delete(state), 10 * 60 * 1000);
    
    logger.info(`Generated OAuth URL for state: ${state}`);
    
    res.redirect(authUrl);
  } catch (error) {
    logger.error('Error generating auth URL:', error);
    res.status(500).json({ 
      error: 'Failed to generate authorization URL',
      message: 'Please try again or contact support'
    });
  }
});

// OAuth callback handler
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    logger.error('OAuth error:', error);
    return res.status(400).send(`
      <html><body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>❌ Authorization Failed</h1>
        <p>Error: ${error}</p>
        <a href="/auth" style="padding: 10px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
      </body></html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <html><body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>❌ Missing Authorization Code</h1>
        <p>No authorization code received from Google.</p>
        <a href="/auth" style="padding: 10px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
      </body></html>
    `);
  }

  // Verify state parameter
  if (state && !authStates.has(state)) {
    logger.warn(`Invalid state parameter: ${state}`);
    return res.status(400).send(`
      <html><body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>❌ Invalid State Parameter</h1>
        <p>The authorization request may have expired or been tampered with.</p>
        <a href="/auth" style="padding: 10px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
      </body></html>
    `);
  }

  try {
    // Exchange code for tokens
    const { tokens, userInfo } = await googleAuth.exchangeCodeForTokens(code);
    
    // Check permissions
    const permissions = await googleAuth.checkPermissions(tokens);
    const missingPermissions = Object.entries(permissions)
      .filter(([key, value]) => !value)
      .map(([key]) => key);

    if (missingPermissions.length > 0) {
      logger.warn(`User ${userInfo.email} missing permissions: ${missingPermissions.join(', ')}`);
    }

    // Store user and tokens in database
    const user = await createOrUpdateUser(userInfo.email, tokens);
    
    // Clean up state
    if (state) {
      authStates.delete(state);
    }

    logger.info(`User ${userInfo.email} successfully authenticated and stored`);

    res.send(`
      <html>
      <head>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 600px; 
            margin: 50px auto; 
            padding: 20px;
            background: #f5f5f5;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            text-align: center;
          }
          .success { color: #059669; }
          .warning { color: #d97706; background: #fef3c7; padding: 10px; border-radius: 6px; margin: 15px 0; }
          .info { background: #dbeafe; padding: 15px; border-radius: 6px; margin: 15px 0; }
          .btn {
            display: inline-block;
            padding: 12px 24px;
            background: #2563eb;
            color: white;
            text-decoration: none;
            border-radius: 6px;
            margin: 10px 5px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1 class="success">✅ Authorization Successful!</h1>
          <p>Hello <strong>${userInfo.name}</strong> (${userInfo.email})</p>
            <div class="info">
            <h3>🔒 Permissions Granted:</h3>
            <ul style="text-align: left;">
              <li>Google Chat: ${permissions.chat ? '✅' : '❌'}</li>
              <li>Google Gmail: ${permissions.gmail ? '✅' : '❌'}</li>
            </ul>
          </div>

          ${missingPermissions.length > 0 ? `
            <div class="warning">
              <strong>⚠️ Some permissions are missing.</strong><br>
              Data collection for ${missingPermissions.join(', ')} may not work properly.
            </div>
          ` : ''}
          
          <div class="info">
            <h3>🚀 What's Next?</h3>
            <p>Your data will be automatically collected every ${process.env.FETCH_INTERVAL_MINUTES || 10} minutes.</p>
            <p>Monitor progress using the dashboard below.</p>
          </div>
          
          <a href="http://localhost:${process.env.DASHBOARD_PORT || 4000}/dashboard" class="btn">View Dashboard</a>
          <a href="/" class="btn" style="background: #6b7280;">Back to Home</a>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    logger.error('Error in OAuth callback:', error);
    res.status(500).send(`
      <html><body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>❌ Authentication Failed</h1>
        <p>An error occurred while processing your authorization.</p>
        <p style="color: #666; font-size: 14px;">Error: ${error.message}</p>
        <a href="/auth" style="padding: 10px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
      </body></html>
    `);
  }
});

// System statistics endpoint
app.get('/stats', async (req, res) => {
  try {    const stats = await getDashboardStats();
    const activeUsers = await getAllActiveUsers();
    
    res.json({
      timestamp: new Date().toISOString(),
      total_active_users: activeUsers.length,
      users: stats,
      server_uptime: process.uptime(),
      memory_usage: process.memoryUsage(),
      node_version: process.version
    });
  } catch (error) {
    logger.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// User-specific stats endpoint
app.get('/user/:email/stats', async (req, res) => {
  try {
    const { email } = req.params;    const user = await getUserByEmail(email);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const stats = await getUserStats(user.id);
    const recentLogs = await getRecentSyncLogs(user.id);
    
    res.json({
      user: {
        email: user.email,
        created_at: user.created_at,
        last_sync: user.last_sync
      },
      stats,
      recent_sync_logs: recentLogs
    });
  } catch (error) {
    logger.error('Error fetching user stats:', error);
    res.status(500).json({ error: 'Failed to fetch user statistics' });
  }
});

// Message rewrite endpoint
app.post('/api/rewrite-message', async (req, res) => {
  try {
    const { sampleMessage, type } = req.body;

    // Validate input
    if (!sampleMessage || !type) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'Both sampleMessage and type are required'
      });
    }

    if (typeof sampleMessage !== 'string' || typeof type !== 'string') {
      return res.status(400).json({ 
        error: 'Invalid data types',
        message: 'Both sampleMessage and type must be strings'
      });
    }

    logger.info(`Processing message rewrite request - Type: ${type}, Message length: ${sampleMessage.length}`);

    // Process the message rewrite
    const rewrittenMessage = await messageRewriteService.rewriteMessage(sampleMessage, type);

    res.json({
      success: true,
      originalMessage: sampleMessage,
      type: type,
      rewrittenMessage: rewrittenMessage,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error processing message rewrite:', error);
    res.status(500).json({ 
      error: 'Failed to rewrite message',
      message: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

// Start server only if not in Vercel serverless environment
if (process.env.VERCEL !== '1') {
  const server = app.listen(port, () => {
    logger.info(`🚀 PM Assistant OAuth Server running on http://localhost:${port}`);
    logger.info(`📊 Dashboard will be available on http://localhost:${process.env.DASHBOARD_PORT || 4000}/dashboard`);
    logger.info(`🔒 OAuth flow: http://localhost:${port}/auth`);
    logger.info(`📈 Stats: http://localhost:${port}/stats`);
    
    // Start the data fetcher in a separate process
    if (process.env.NODE_ENV !== 'test') {
      const { spawn } = require('child_process');
      const fetcherProcess = spawn('node', ['dataFetcher.js'], {
        stdio: 'inherit',
        cwd: __dirname
      });
      
      fetcherProcess.on('error', (error) => {
        logger.error('Failed to start data fetcher:', error);
      });
      
      logger.info('🤖 Data fetcher started in background');
    }
  });
}

module.exports = app;
