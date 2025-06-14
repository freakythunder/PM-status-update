require('dotenv').config();
const cron = require('node-cron');
const winston = require('winston');
const fs = require('fs');
const path = require('path');

const GoogleAuthManager = require('./utils/googleAuth');
const LLMAnalyzer = require('./llmAnalyzer');
const {
  connectToMongoDB,
  User,
  GmailMessage,
  ChatMessage,
  getAllActiveUsers,
  updateUserTokens,
  insertGmailMessages,
  hasExistingGmailMessages,
  getLastGmailSyncTime,
  getLatestGmailMessageTime,
  insertChatMessages,
  hasExistingChatMessages,
  getLastChatSyncTime,
  getLatestChatMessageTime,
  getChatMessagesBySpace,
  hasExistingChatMessagesInSpace, // Added
  getLatestChatMessageCreateTimeForSpace, // Added
  createSyncLog
} = require('./utils/mongodb');

// Load user name mapping with serverless compatibility
let userNameMapping = {};
try {
  const mappingFilePath = path.join(__dirname, 'user_name_mapping_simple.json');
  if (fs.existsSync(mappingFilePath)) {
    userNameMapping = JSON.parse(fs.readFileSync(mappingFilePath, 'utf8'));
    logger.info(`Loaded user name mapping with ${Object.keys(userNameMapping).length} entries`);
  } else {
    logger.warn('User name mapping file not found, continuing with empty mapping');
  }
} catch (error) {
  logger.warn(`Failed to load user name mapping file: ${error.message}`);
  // Continue with empty mapping
}

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info', // Default to 'info'
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), // More readable timestamp
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => { // Custom format for console
      let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
      if (meta && Object.keys(meta).length && !(meta.stack && Object.keys(meta).length === 1)) {
        // Avoid printing stack trace if it's the only meta, as errors({stack:true}) handles it.
        try {
          log += ` ${JSON.stringify(meta)}`;
        } catch (e) {
          // Fallback for circular structures or other stringify errors
          log += " (unable to stringify metadata)";
        }
      }
      return log;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(), // Colorize console output
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
          // Simplified meta stringification for console to avoid excessive output
          if (meta && Object.keys(meta).length && !(meta.stack && Object.keys(meta).length === 1)) {
            const metaString = Object.entries(meta)
              .filter(([key]) => key !== 'stack') // Stack is already handled by errors({stack:true})
              .map(([key, value]) => `${key}=${value}`)
              .join(', ');
            if (metaString) log += ` (${metaString})`;
          }
          return log;
        })
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
    this.llmAnalyzer = new LLMAnalyzer();
    this.isRunning = false;
    this.lastRunTime = null;
    this.stats = {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,      lastError: null
    };
    this.spacesFilePath = path.join(__dirname, 'spaces_with_latest_messages.json');
  }

  // Utility functions for managing spaces JSON file
  loadSpacesFromJSON() {
    try {
      if (!fs.existsSync(this.spacesFilePath)) {
        logger.warn(`Spaces JSON file not found at ${this.spacesFilePath}, returning empty array`);
        return [];
      }
      const spacesData = JSON.parse(fs.readFileSync(this.spacesFilePath, 'utf8'));
      return spacesData;
    } catch (error) {
      logger.error(`Failed to load spaces JSON file: ${error.message}`);
      return []; // Return empty array instead of throwing error
    }
  }

  saveSpacesToJSON(spacesData) {
    try {
      // In serverless environment, try to write to /tmp directory
      const isServerless = process.env.VERCEL === '1';
      let targetPath = this.spacesFilePath;
      
      if (isServerless) {
        // Use /tmp directory in serverless environment
        const fileName = path.basename(this.spacesFilePath);
        targetPath = path.join('/tmp', fileName);
        logger.info(`Serverless detected, writing to ${targetPath}`);
      }
      
      fs.writeFileSync(targetPath, JSON.stringify(spacesData, null, 2), 'utf8');
      logger.info(`Updated spaces JSON file with latest message times at ${targetPath}`);
    } catch (error) {
      logger.error(`Failed to save spaces JSON file: ${error.message}`);
      // Don't throw error in serverless environment, just log it
      if (process.env.VERCEL !== '1') {
        throw error;
      }
    }
  }

  updateSpaceInJSON(spaceId, latestMessageTime, hasNewMsg = true) {
    try {
      const spacesData = this.loadSpacesFromJSON();
      const spaceIndex = spacesData.findIndex(space => space.space_id === spaceId);
      
      if (spaceIndex !== -1) {
        spacesData[spaceIndex].latest_message_time = latestMessageTime;
        spacesData[spaceIndex].has_new_msg = hasNewMsg;
        this.saveSpacesToJSON(spacesData);
        logger.info(`Updated space ${spaceId} with new message time: ${latestMessageTime}`);
      } else {
        logger.warn(`Space ${spaceId} not found in JSON file`);
      }
    } catch (error) {
      logger.error(`Failed to update space ${spaceId} in JSON: ${error.message}`);
    }
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
      const activeUsers = await getAllActiveUsers();
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
      }      this.stats.successfulRuns++;
      logger.info('✅ Data collection cycle completed successfully');

      // Trigger LLM analysis after successful data collection
      try {
        logger.info('🤖 Starting LLM analysis for response prediction');
        await this.llmAnalyzer.analyzeMessagesForResponsePrediction();
        logger.info('✅ LLM analysis completed successfully');
      } catch (error) {
        logger.error('❌ LLM analysis failed (data collection still successful):', error);
        // Don't fail the entire data collection cycle if LLM analysis fails
      }

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
    logger.info(`Processing user: ${user.email}`); // Simplified log
    try {
      // Refresh tokens if needed
      const refreshedTokens = await this.googleAuth.refreshTokenIfNeeded(user.google_tokens);

      // Check if tokens were updated and save them if so
      if (refreshedTokens && (
        refreshedTokens.access_token !== user.google_tokens.access_token ||
        refreshedTokens.expiry_date !== user.google_tokens.expiry_date
      )) {
        await updateUserTokens(user.id, refreshedTokens);
        user.google_tokens = {
          ...user.google_tokens,
          ...refreshedTokens
        };
        logger.info(`Refreshed tokens for ${user.email}`); // Simplified log
      }

      // Collect Chat data (continue if fails)
      try {
        await this.collectChatData(user);
      } catch (error) {
        // Error is already logged in collectChatData and createSyncLog
        logger.error(`Chat data collection failed for ${user.email}. See details in sync log.`);
      }

      // Collect Gmail data (continue if fails) 
      try {
        await this.collectGmailData(user);
      } catch (error) {
        // Error is already logged in collectGmailData and createSyncLog
        logger.error(`Gmail data collection failed for ${user.email}. See details in sync log.`);
      }

      // No need to call updateUserTokens here again as last_sync times are updated in createSyncLog
      // and token refreshes are saved when they happen.

    } catch (error) {
      logger.error(`Overall data collection failed for user ${user.email}: ${error.message}`, { stack: error.stack });
      // Optionally, create a general failure sync log if needed, though specific ones are preferred.
    }
  }  // Collect Google Chat data
  async collectChatData(user) {
    try {
      logger.info(`Collecting Chat data for ${user.email}`);

      const chatClient = this.googleAuth.createChatClient(user.google_tokens);
      let totalMessagesFetchedAndStored = 0;
      let spacesProcessed = 0;

      // Load spaces from JSON file
      const spacesData = this.loadSpacesFromJSON();
      
      // Transform JSON data to match expected space structure
      const spaces = spacesData.map(spaceData => ({
        name: spaceData.space_id,
        displayName: spaceData.space_name,
        space_id: spaceData.space_id,
        space_name: spaceData.space_name,
        latest_message_time: spaceData.latest_message_time,
        has_new_msg: spaceData.has_new_msg || false,
        spaceType: spaceData.spaceType // Default to UNKNOWN if not specified
      }));
      
      logger.info(`Loaded ${spaces.length} Chat spaces from JSON file for ${user.email}`);

      const allChatMessagesToStore = [];
      let hasAnyNewMessages = false;

      // Process each space
      for (const space of spaces) {
        spacesProcessed++;
        let messagesInThisSpaceProcessed = 0;
        let latestMessageTimeInThisSpace = null;
        
        try {
          logger.info(`Processing space: ${space.space_name}`);

          // Use JSON file as source of truth for latest message time
          let filterOption = {};
          if (space.latest_message_time) {
            const bufferTime = new Date(new Date(space.latest_message_time).getTime() + 1);
            const filterTimestamp = bufferTime.toISOString();
            filterOption.filter = `createTime > "${filterTimestamp}"`;
            logger.info(`Incremental fetch for space ${space.space_name}: messages after ${filterTimestamp}`);
          } else {
            logger.info(`Initial fetch for space ${space.space_name}: fetching all (up to pageSize)`);
          }

          let nextPageToken = null;
          const spaceMessagesToStore = [];

          do {
            const messagesResponse = await this.googleAuth.executeWithRetry(async () => {
              return await chatClient.spaces.messages.list({
                parent: space.name,
                pageSize: 100,
                orderBy: 'createTime asc',
                filter: filterOption.filter,
                pageToken: nextPageToken,
              });
            });

            const messages = messagesResponse.data.messages || [];
            logger.info(`Fetched ${messages.length} messages from space ${space.space_name} (page ${nextPageToken || '1'})`);

            if (messages.length === 0 && !nextPageToken) {
              // No messages found with the filter or in an empty space
              break;
            }            for (const message of messages) {
              try {
                const messageTime = new Date(message.createTime);
                
                // Track the latest message time in this space
                if (!latestMessageTimeInThisSpace || messageTime > latestMessageTimeInThisSpace) {
                  latestMessageTimeInThisSpace = messageTime;
                }
                
                const chatMessage = {
                  user_id: user.id,
                  message_id: message.name,
                  space_id: space.space_id,
                  space_name: space.space_name,
                  space_type: space.spaceType ,
                  sender_id: message.sender?.name,
                  sender_name: userNameMapping[message.sender?.name] || message.sender?.displayName || 'Unknown',
                  sender_email: message.sender?.email || '',
                  content: message.text || message.formattedText || '',
                  message_time: messageTime,
                  thread_id: message.thread?.name || null,
                  is_threaded: !!message.thread?.name,
                  raw_data: message
                };
                spaceMessagesToStore.push(chatMessage);
                messagesInThisSpaceProcessed++;
              } catch (messageError) {
                logger.warn(`Error processing Chat message ${message.name} in space ${space.space_name}: ${messageError.message}`);
              }
            }
            nextPageToken = messagesResponse.data.nextPageToken;
            if (nextPageToken) await this.googleAuth.sleep(200); // Be nice to the API if paginating

          } while (nextPageToken);

          // Update JSON file if new messages were found
          if (messagesInThisSpaceProcessed > 0 && latestMessageTimeInThisSpace) {
            this.updateSpaceInJSON(space.space_id, latestMessageTimeInThisSpace.toISOString(), true);
            hasAnyNewMessages = true;
          } else if (messagesInThisSpaceProcessed === 0) {
            // Reset has_new_msg to false if no new messages
            this.updateSpaceInJSON(space.space_id, space.latest_message_time, false);
          }

          if (spaceMessagesToStore.length > 0) {
            allChatMessagesToStore.push(...spaceMessagesToStore);
          }
          logger.info(`Finished processing space ${space.space_name}, ${messagesInThisSpaceProcessed} new messages found`);

        } catch (spaceError) {
          logger.error(`Error processing Chat space ${space.space_name} for ${user.email}: ${spaceError.message}`, { stack: spaceError.stack });
        }
      }

      // Save all collected messages to database
      if (allChatMessagesToStore.length > 0) {
        const insertResult = await insertChatMessages(allChatMessagesToStore);
        totalMessagesFetchedAndStored = insertResult.insertedCount || 0;
        logger.info(`Stored ${totalMessagesFetchedAndStored} chat messages for ${user.email}`);
      } else {
        logger.info(`No new chat messages to store for ${user.email}`);
      }

      await createSyncLog(
        user.id,
        'chat',
        'success',
        `Collected from ${spacesProcessed} spaces. ${hasAnyNewMessages ? 'New messages found.' : 'No new messages.'}`,
        totalMessagesFetchedAndStored
      );

      logger.info(`Chat data collection completed for ${user.email}: ${totalMessagesFetchedAndStored} messages from ${spacesProcessed} spaces`);

    } catch (error) {
      await createSyncLog(
        user.id,
        'chat',
        'error',
        { message: `Failed to collect chat data: ${error.message}`, stack: error.stack },
        0
      );

      logger.error(`Chat data processing failed for ${user.email}: ${error.message}`, { stack: error.stack });
    }
  }  // Collect Gmail data with smart incremental updates
  async collectGmailData(user) {
    try {
      logger.info(`Collecting Gmail data for ${user.email}`); // Simplified log
      const gmailClient = this.googleAuth.createGmailClient(user.google_tokens);
      let totalMessagesStored = 0;

      // Check if this is initial collection or incremental update
      const hasExistingMessages = await hasExistingGmailMessages(user.id);
      const lastSyncTime = await getLastGmailSyncTime(user.id); // This is from User.last_gmail_sync

      let searchQuery = '';
      let maxResultsToList = 100; // Max messages to list from API for initial sync
      const GMAIL_PAGE_SIZE = 100; // How many messages to fetch details for in one go (if needed, though we fetch one by one)

      if (!hasExistingMessages) {
        logger.info(`Initial Gmail collection for ${user.email} - fetching up to ${maxResultsToList} recent messages.`);
        // No specific query, rely on default ordering (usually newest first) and maxResultsToList
        // Gmail API q parameter can take 'newer_than:30d' but for initial, let's get most recent X.
        // If you want *all* messages, this strategy needs to change significantly due to pagination and API limits.
        // For now, "at most 100 mails" for initial sync.
      } else {
        logger.info(`Incremental Gmail update for ${user.email}.`);
        if (lastSyncTime) {
          const lastSyncDate = new Date(lastSyncTime);
          // Gmail API query for 'after' expects a Unix timestamp in seconds.
          const searchTimestamp = Math.floor(lastSyncDate.getTime() / 1000);
          searchQuery = `after:${searchTimestamp}`;
          maxResultsToList = 500; // For incremental, can be larger if many emails are expected.
          logger.info(`Fetching Gmail messages after ${lastSyncDate.toISOString()} (timestamp: ${searchTimestamp})`);
        } else {
          // Fallback if lastSyncTime is somehow not set despite hasExistingMessages being true
          logger.warn(`Last sync time not found for ${user.email} during incremental update. Fetching recent messages (last 7 days).`);
          searchQuery = 'newer_than:7d';
          maxResultsToList = 100;
        }
      }

      const gmailMessagesToStore = [];
      let nextPageToken = null;
      let listedMessagesCount = 0;

      do {
        const messagesResponse = await this.googleAuth.executeWithRetry(async () => {
          return await gmailClient.users.messages.list({
            userId: 'me',
            maxResults: Math.min(GMAIL_PAGE_SIZE, maxResultsToList - listedMessagesCount), // Fetch in pages, up to maxResultsToList
            q: searchQuery,
            pageToken: nextPageToken,
          });
        });

        const messageMetadatas = messagesResponse.data.messages || [];
        if (messageMetadatas.length === 0) {
          logger.info(`No (more) Gmail messages found for query: '${searchQuery}' for ${user.email}.`);
          break;
        }

        listedMessagesCount += messageMetadatas.length;
        logger.info(`Fetched ${messageMetadatas.length} Gmail message IDs for ${user.email}. (${listedMessagesCount}/${maxResultsToList} for this run)`);

        for (const messageRef of messageMetadatas) {
          try {
            // Fetch full message details
            const fullMessageResponse = await this.googleAuth.executeWithRetry(async () => {
              return await gmailClient.users.messages.get({
                userId: 'me',
                id: messageRef.id,
                format: 'full'
              });
            });
            const fullMessage = fullMessageResponse.data;

            const headers = fullMessage.payload?.headers || [];
            const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

            const fromHeader = getHeader('From');
            let senderName = '';
            let senderEmail = '';
            if (fromHeader) {
              const emailMatch = fromHeader.match(/<(.+@.+)>/);
              if (emailMatch) {
                senderEmail = emailMatch[1];
                senderName = fromHeader.replace(/<.+>/, '').replace(/["']/g, '').trim();
              } else if (fromHeader.includes('@')) {
                senderEmail = fromHeader.trim();
                senderName = senderEmail.split('@')[0];
              } else {
                senderName = fromHeader.trim();
              }
            }

            const dateHeader = getHeader('Date');
            let dateReceived;
            if (dateHeader) {
              const parsedDate = new Date(dateHeader);
              dateReceived = !isNaN(parsedDate.getTime()) ? parsedDate : new Date(parseInt(fullMessage.internalDate));
            } else {
              dateReceived = new Date(parseInt(fullMessage.internalDate));
            }

            const gmailMessage = {
              user_id: user.id,
              message_id: fullMessage.id,
              thread_id: fullMessage.threadId,
              subject: getHeader('Subject') || 'No Subject',
              sender: fromHeader, // Store full From header as 'sender'
              recipient: getHeader('To'), // Store full To header as 'recipient'
              message_time: dateReceived, // Store as Date
              content: fullMessage.snippet || '', // Snippet is usually enough
              labels: fullMessage.labelIds || [],
              raw_data: fullMessage // Store the full message object
            };

            gmailMessagesToStore.push(gmailMessage);

            // Rate limiting per message fetch
            await this.googleAuth.sleep(100); // Increased sleep due to 'full' fetch

          } catch (error) {
            logger.warn(`Error processing Gmail message ID ${messageRef.id} for ${user.email}: ${error.message}`);
          }
        } // end for messageRef

        nextPageToken = messagesResponse.data.nextPageToken;
        if (nextPageToken && listedMessagesCount < maxResultsToList) {
          logger.info("Fetching next page of Gmail messages...");
          await this.googleAuth.sleep(200); // Sleep before next page list
        } else {
          nextPageToken = null; // Stop if maxResultsToList reached or no more pages
        }

      } while (nextPageToken);


      if (gmailMessagesToStore.length > 0) {
        gmailMessagesToStore.sort((a, b) => b.message_time - a.message_time);

        const insertResult = await insertGmailMessages(gmailMessagesToStore);
        totalMessagesStored = insertResult.insertedCount || 0;
        logger.info(`Stored ${totalMessagesStored} Gmail messages for ${user.email}.`);
      } else {
        logger.info(`No new Gmail messages to store for ${user.email}.`);
      }

      await createSyncLog(
        user.id,
        'gmail',
        'success',
        `Collected messages. Query: '${searchQuery || 'initial_fetch'}', Listed: ${listedMessagesCount}`,
        totalMessagesStored // Pass the count of messages actually stored
      );

      logger.info(`Gmail data collection completed for ${user.email}: ${totalMessagesStored} messages stored (${hasExistingMessages ? 'incremental' : 'initial'}).`);

    } catch (error) {
      await createSyncLog(
        user.id,
        'gmail',
        'error',
        { message: `Failed to collect Gmail data: ${error.message}`, stack: error.stack }, // Pass error object
        0 // No items processed in case of a full failure
      );

      logger.error(`Gmail data collection failed for ${user.email}: ${error.message}`, { stack: error.stack });
      // Do not re-throw, as per user request for independent operation
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
