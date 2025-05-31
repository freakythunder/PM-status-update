require('dotenv').config();
const cron = require('node-cron');
const winston = require('winston');

const GoogleAuthManager = require('./utils/googleAuth');
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
    }),
    new winston.transports.File({ 
      filename: 'data-fetcher.log',
      format: winston.format.json()
    })
  ]
});

class DataFetcher {
  constructor() {
    this.googleAuth = new GoogleAuthManager();
    this.isRunning = false;
    this.lastRunTime = null;
    this.stats = {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      lastError: null
    };
  }

  // Main data collection method
  async collectAllData() {
    if (this.isRunning) {
      logger.warn('Data collection already in progress, skipping this run');
      return;
    }

    this.isRunning = true;
    this.lastRunTime = new Date();
    this.stats.totalRuns++;

    logger.info('🚀 Starting data collection cycle');

    try {
      const activeUsers = await supabase.getAllActiveUsers();
      logger.info(`Found ${activeUsers.length} active users for data collection`);

      if (activeUsers.length === 0) {
        logger.info('No active users found, skipping data collection');
        this.isRunning = false;
        return;
      }

      // Process each user
      for (const user of activeUsers) {
        try {
          await this.collectUserData(user);
        } catch (error) {
          logger.error(`Failed to collect data for user ${user.email}:`, error);
          // Continue with other users even if one fails
        }
      }

      this.stats.successfulRuns++;
      logger.info('✅ Data collection cycle completed successfully');

    } catch (error) {
      this.stats.failedRuns++;
      this.stats.lastError = error.message;
      logger.error('❌ Data collection cycle failed:', error);
    } finally {
      this.isRunning = false;
    }
  }

  // Collect data for a specific user
  async collectUserData(user) {
    logger.info(`📊 Collecting data for user: ${user.email}`);

    try {
      // Refresh tokens if needed
      const refreshedTokens = await this.googleAuth.refreshTokenIfNeeded(user.google_tokens);
      
      if (JSON.stringify(refreshedTokens) !== JSON.stringify(user.google_tokens)) {
        await supabase.updateUserTokens(user.id, refreshedTokens);
        user.google_tokens = refreshedTokens;
        logger.info(`Updated tokens for user ${user.email}`);      }

      // Collect Chat data (continue if fails)
      try {
        await this.collectChatData(user);
      } catch (error) {
        logger.error(`Chat collection failed for ${user.email}, continuing with Gmail:`, error);
      }

      // Collect Gmail data (continue if fails) 
      try {
        await this.collectGmailData(user);
      } catch (error) {
        logger.error(`Gmail collection failed for ${user.email}:`, error);
      }

      // Update user's last sync time
      await supabase.updateUserTokens(user.id, user.google_tokens);

    } catch (error) {
      logger.error(`Error collecting data for user ${user.email}:`, error);
      throw error;
    }
  }  // Collect Google Chat data
  async collectChatData(user) {
    try {
      logger.info(`💬 Collecting Chat data for ${user.email}`);
      
      const chatClient = this.googleAuth.createChatClient(user.google_tokens);
      let totalMessages = 0;

      // With the available scopes, we can:
      // 1. List spaces (chat.spaces.readonly)
      // 2. Read memberships (chat.memberships.readonly) 
      // 3. Read messages (chat.messages.readonly)

      // Get spaces the user has access to
      const spacesResponse = await this.googleAuth.executeWithRetry(async () => {
        return await chatClient.spaces.list({
          pageSize: 100
        });
      });

      const spaces = spacesResponse.data.spaces || [];
      logger.info(`Found ${spaces.length} Chat spaces for ${user.email}`);

      const chatMessages = [];

      // Process each space
      for (const space of spaces) {
        try {
          logger.debug(`Processing space: ${space.name} (${space.displayName || space.type})`);

          // Get messages from this space (last 30 days)
          const messagesResponse = await this.googleAuth.executeWithRetry(async () => {
            return await chatClient.spaces.messages.list({
              parent: space.name,
              pageSize: 100,
              orderBy: 'createTime desc'
            });
          });

          const messages = messagesResponse.data.messages || [];
          logger.debug(`Found ${messages.length} messages in space ${space.name}`);
          
          // Filter messages from last 30 days
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          
          // Process each message in this space
          for (const message of messages) {
            try {
              const messageDate = new Date(message.createTime);
              if (messageDate < thirtyDaysAgo) {
                continue; // Skip messages older than 30 days
              }

              const chatMessage = {
                user_id: user.id,
                message_id: message.name,
                space_id: space.name,
                space_name: space.displayName || space.type || 'Unknown Space',
                space_type: space.type || 'UNKNOWN',
                sender_name: message.sender?.displayName || 'Unknown',
                sender_email: message.sender?.name || '',
                text: message.text || '',
                timestamp: message.createTime,
                thread_id: message.thread?.name || null,
                raw_data: message
              };

              chatMessages.push(chatMessage);
              totalMessages++;

              // Rate limiting
              await this.googleAuth.sleep(50);

            } catch (messageError) {
              logger.warn(`Error processing Chat message ${message.name}:`, messageError.message);
            }
          }

          // Rate limiting between spaces
          await this.googleAuth.sleep(200);

        } catch (spaceError) {
          logger.warn(`Error processing Chat space ${space.name}:`, spaceError.message);
        }
      }

      // Save to database
      if (chatMessages.length > 0) {
        await supabase.insertChatMessages(chatMessages);
      }

      // Log sync result
      await supabase.createSyncLog(
        user.id,
        'chat',
        'success',
        `Collected ${totalMessages} Chat messages from ${spaces.length} spaces`,
        totalMessages
      );

      logger.info(`✅ Chat data collection completed for ${user.email}: ${totalMessages} messages from ${spaces.length} spaces`);

    } catch (error) {
      await supabase.createSyncLog(
        user.id,
        'chat',
        'error',
        `Failed to collect chat data: ${error.message}`,
        0,
        { error: error.message, stack: error.stack }
      );
      
      logger.error(`❌ Chat data processing failed for ${user.email}:`, error);
      throw error;
    }
  }  // Collect Gmail data with smart incremental updates
  async collectGmailData(user) {
    try {
      logger.info(`📧 Collecting Gmail data for ${user.email}`);
      
      const gmailClient = this.googleAuth.createGmailClient(user.google_tokens);
      let totalMessages = 0;

      // Check if this is initial collection or incremental update
      const hasExistingMessages = await supabase.hasExistingGmailMessages(user.id);
      const lastSyncTime = await supabase.getLastGmailSyncTime(user.id);
      
      let searchQuery = '';
      let maxResults = 100; // Default for initial collection
      
      if (!hasExistingMessages) {
        // Initial collection: Get last 100 messages
        logger.info(`📥 Initial Gmail collection for ${user.email} - fetching last 100 messages`);
        searchQuery = 'newer_than:30d'; // Last 30 days but limit to 100
        maxResults = 100;
      } else {
        // Incremental update: Only get new messages since last sync
        logger.info(`🔄 Incremental Gmail update for ${user.email}`);
        if (lastSyncTime) {
          const lastSyncDate = new Date(lastSyncTime);
          const searchDate = Math.floor(lastSyncDate.getTime() / 1000);
          searchQuery = `after:${searchDate}`;
          maxResults = 50; // Limit incremental updates
        } else {
          // Fallback: get recent messages
          searchQuery = 'newer_than:1d';
          maxResults = 50;
        }
      }

      // Get messages based on strategy
      const messagesResponse = await this.googleAuth.executeWithRetry(async () => {
        return await gmailClient.users.messages.list({
          userId: 'me',
          maxResults: maxResults,
          q: searchQuery
        });
      });

      const messageIds = messagesResponse.data.messages || [];
      logger.info(`Found ${messageIds.length} Gmail messages for ${user.email} (${hasExistingMessages ? 'incremental' : 'initial'})`);

      if (messageIds.length === 0) {
        logger.info(`✅ No new Gmail messages for ${user.email}`);
        
        // Still log a successful sync even if no messages
        await supabase.createSyncLog(
          user.id,
          'gmail',
          'success',
          'No new Gmail messages found',
          0
        );
        return;
      }

      const gmailMessages = [];

      // Process each message
      for (const messageRef of messageIds) {
        try {
          const messageResponse = await this.googleAuth.executeWithRetry(async () => {
            return await gmailClient.users.messages.get({
              userId: 'me',
              id: messageRef.id,
              format: 'full'
            });
          });

          const message = messageResponse.data;
          const headers = message.payload?.headers || [];
          
          const getHeader = (name) => headers.find(h => h.name === name)?.value || '';

          // Parse sender information from "From" header
          const fromHeader = getHeader('From');
          let senderName = '';
          let senderEmail = '';
          
          if (fromHeader) {
            // Pattern: "Name <email@domain.com>" or just "email@domain.com"
            const emailMatch = fromHeader.match(/<(.+@.+)>/);
            if (emailMatch) {
              senderEmail = emailMatch[1];
              senderName = fromHeader.replace(/<.+>/, '').trim();
              // Clean up sender name by removing quotes
              senderName = senderName.replace(/^["']|["']$/g, '').trim();
            } else if (fromHeader.includes('@')) {
              senderEmail = fromHeader.trim();
              senderName = fromHeader.split('@')[0];
            } else {
              senderName = fromHeader;
            }
          }

          // Extract and properly format date from Date header (more accurate than internalDate)
          const dateHeader = getHeader('Date');
          let dateReceived;
          
          if (dateHeader) {
            // Parse RFC 2822 date format from Date header
            const parsedDate = new Date(dateHeader);
            if (!isNaN(parsedDate.getTime())) {
              dateReceived = parsedDate.toISOString();
            } else {
              // Fallback to internalDate if Date header is invalid
              dateReceived = new Date(parseInt(message.internalDate)).toISOString();
            }
          } else {
            // Fallback to internalDate if Date header is missing
            dateReceived = new Date(parseInt(message.internalDate)).toISOString();
          }

          const gmailMessage = {
            user_id: user.id,
            message_id: message.id,
            thread_id: message.threadId,
            sender_name: senderName || 'Unknown',
            sender_email: senderEmail || '',
            subject: getHeader('Subject') || 'No Subject',
            body: message.snippet || '',
            date_received: dateReceived
          };

          gmailMessages.push(gmailMessage);
          totalMessages++;

          // Rate limiting
          await this.googleAuth.sleep(50);

        } catch (error) {
          logger.warn(`Error processing Gmail message ${messageRef.id}:`, error.message);
        }
      }

      // Sort messages by date_received in descending order (newest first) before saving
      gmailMessages.sort((a, b) => new Date(b.date_received) - new Date(a.date_received));

      // Save to database
      if (gmailMessages.length > 0) {
        await supabase.insertGmailMessages(gmailMessages);
      }

      // Log sync result
      await supabase.createSyncLog(
        user.id,
        'gmail',
        'success',
        `Collected ${totalMessages} Gmail messages (${hasExistingMessages ? 'incremental' : 'initial'})`,
        totalMessages
      );

      logger.info(`✅ Gmail data collection completed for ${user.email}: ${totalMessages} messages (${hasExistingMessages ? 'incremental' : 'initial'})`);

    } catch (error) {
      await supabase.createSyncLog(
        user.id,
        'gmail',
        'error',
        'Failed to collect gmail data',
        0,
        { error: error.message, stack: error.stack }
      );

      logger.error(`❌ Gmail data collection failed for ${user.email}:`, error);
      throw error;
    }
  }

  // Get status information
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      stats: this.stats,
      uptime: process.uptime(),
      nextRun: this.getNextRunTime()
    };
  }

  // Calculate next run time (for display purposes)
  getNextRunTime() {
    if (!this.lastRunTime) return 'Pending first run';
    
    const intervalMinutes = parseInt(process.env.FETCH_INTERVAL_MINUTES) || 10;
    const nextRun = new Date(this.lastRunTime.getTime() + (intervalMinutes * 60 * 1000));
    return nextRun;
  }

  // Start the cron job
  start() {
    const intervalMinutes = parseInt(process.env.FETCH_INTERVAL_MINUTES) || 10;
    const cronExpression = `*/${intervalMinutes} * * * *`;

    logger.info(`🕐 Starting data fetcher with ${intervalMinutes}-minute intervals`);
    logger.info(`📅 Cron expression: ${cronExpression}`);

    // Schedule the cron job
    const task = cron.schedule(cronExpression, async () => {
      await this.collectAllData();
    }, {
      scheduled: false,
      timezone: 'UTC'
    });

    // Start the cron job
    task.start();

    // Run initial collection after 30 seconds
    setTimeout(async () => {
      logger.info('🎯 Running initial data collection...');
      await this.collectAllData();
    }, 30000);

    logger.info('✅ Data fetcher started successfully');

    // Handle graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down data fetcher...');
      task.stop();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down data fetcher...');
      task.stop();
      process.exit(0);
    });

    return task;
  }
}

// If this file is run directly, start the data fetcher
if (require.main === module) {
  const fetcher = new DataFetcher();
  
  fetcher.start();
  
  logger.info('🤖 PM Assistant Data Fetcher is running');
  logger.info(`📊 Status endpoint would be available if running with web server`);
  logger.info(`🔄 Data collection interval: ${process.env.FETCH_INTERVAL_MINUTES || 10} minutes`);
}

module.exports = DataFetcher;
