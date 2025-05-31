require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const winston = require('winston');

const fs = require('fs');
const path = require('path');

const supabase = require('./utils/supabase');

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
    })
  ]
});

const app = express();
const port = process.env.DASHBOARD_PORT || 4000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Allow inline styles for dashboard
}));
app.use(cors());
app.use(express.json());

// Dashboard route - serve HTML template
app.get('/dashboard', async (req, res) => {
  try {
    const dashboardHtmlPath = path.join(__dirname, 'views', 'dashboard.html');
    
    if (!fs.existsSync(dashboardHtmlPath)) {
      throw new Error('Dashboard HTML template not found');
    }
    
    const htmlContent = fs.readFileSync(dashboardHtmlPath, 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(htmlContent);

  } catch (error) {
    logger.error('Error loading dashboard:', error);
    res.status(500).send(`
      <html><body style="font-family: sans-serif; padding: 50px; text-align: center;">
        <h1>❌ Dashboard Error</h1>
        <p>Failed to load dashboard template.</p>
        <p style="color: #666;">Error: ${error.message}</p>
        <button onclick="location.reload()" style="padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer;">Retry</button>
      </body></html>
    `);
  }
});

// API endpoint for system-wide statistics
app.get('/api/system-stats', async (req, res) => {
  try {
    const systemStats = await supabase.getSystemStats();
    const activeUsers = await supabase.getAllActiveUsers();
    
    res.json({
      total_users: activeUsers.length,
      total_chats: systemStats.total_chat_messages || 0,
      total_gmails: systemStats.total_gmail_messages || 0,
      users: activeUsers.map(user => ({
        id: user.id,
        email: user.email,
        created_at: user.created_at,
        last_sync: user.last_sync
      })),
      timestamp: new Date().toISOString(),
      server_uptime: process.uptime()
    });

  } catch (error) {
    logger.error('Error fetching system stats:', error);
    res.status(500).json({ error: 'Failed to fetch system statistics' });
  }
});

// API endpoint for raw dashboard data
app.get('/api/dashboard-data', async (req, res) => {
  try {
    const activeUsers = await supabase.getAllActiveUsers();
    const dashboardStats = await supabase.getDashboardStats();
    
    const usersWithData = await Promise.all(
      activeUsers.map(async (user) => {
        const [userStats, recentLogs] = await Promise.all([
          supabase.getUserStats(user.id),
          supabase.getRecentSyncLogs(user.id, 10)
        ]);

        return {
          id: user.id,
          email: user.email,
          created_at: user.created_at,
          last_sync: user.last_sync,
          stats: userStats,
          recent_sync_logs: recentLogs
        };
      })
    );

    res.json({
      timestamp: new Date().toISOString(),
      total_users: activeUsers.length,
      users: usersWithData,
      server_uptime: process.uptime()
    });

  } catch (error) {
    logger.error('Error fetching dashboard API data:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// Sample data endpoint for specific user
app.get('/api/user/:userId/sample-data', async (req, res) => {
  try {
    const { userId } = req.params;
    const chatLimit = parseInt(req.query.chatLimit) || 50;
    const syncLimit = parseInt(req.query.syncLimit) || 20;

    const [chatMessages, gmailMessages, syncLogs] = await Promise.all([
      supabase.getChatMessagesByUser(userId, chatLimit),
      supabase.getRecentGmailMessages(userId), // Fetch recent 50 Gmail messages for dashboard
      supabase.getRecentSyncLogs(userId, syncLimit)
    ]);

    res.json({
      user_id: userId,
      chat_messages: chatMessages,
      gmail_messages: gmailMessages,
      sync_logs: syncLogs,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error fetching sample data:', error);
    res.status(500).json({ error: 'Failed to fetch sample data' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'dashboard',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Dashboard HTML template is now served from views/dashboard.html

// Start server
app.listen(port, () => {
  logger.info(`📊 PM Assistant Dashboard running on http://localhost:${port}`);
  logger.info(`🔍 Dashboard: http://localhost:${port}/dashboard`);
  logger.info(`🔗 System Stats API: http://localhost:${port}/api/system-stats`);
});

module.exports = app;
