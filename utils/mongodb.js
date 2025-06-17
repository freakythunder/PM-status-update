const mongoose = require('mongoose');
require('dotenv').config();

// Connection state
let isConnected = false;

// Utility function to get local date
function getLocalDate() {
  const now = new Date();
  const timezoneOffset = now.getTimezoneOffset() * 60000; // offset in milliseconds
  return new Date(now.getTime() - timezoneOffset);
}

// Utility function to convert UTC date to local date
function toLocalDate(utcDate) {
  if (!utcDate) return null;
  const date = new Date(utcDate);
  const timezoneOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - timezoneOffset);
}

// Connect to MongoDB
async function connectToMongoDB() {
  if (isConnected) {
    return;
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      dbName: process.env.DB_NAME,
    });
    
    isConnected = true;
    console.log('✅ Connected to MongoDB successfully');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error);
    throw error;
  }
}

// User Schema
const userSchema = new mongoose.Schema({
  google_id: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  access_token: { type: String, required: true },
  refresh_token: { type: String, required: true },
  token_expiry: { type: Date, required: true },
  created_at: { type: Date, default: getLocalDate },
  updated_at: { type: Date, default: getLocalDate },
  last_gmail_sync: { type: Date },
  last_chat_sync: { type: Date }
});

// Update the updated_at field before saving
userSchema.pre('save', function(next) {
  this.updated_at = getLocalDate();
  next();
});

// Gmail Messages Schema
const gmailMessageSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message_id: { type: String, required: true },
  thread_id: { type: String, required: true },
  subject: { type: String, required: true },
  sender: { type: String, required: true },
  recipient: { type: String, required: true },
  message_time: { type: Date, required: true },
  content: { type: String, required: true },
  labels: [{ type: String }],
  raw_data: { type: mongoose.Schema.Types.Mixed },
  created_at: { type: Date, default: getLocalDate }
});

// Create compound index for unique constraint
gmailMessageSchema.index({ user_id: 1, message_id: 1 }, { unique: true });
gmailMessageSchema.index({ user_id: 1, message_time: -1 });

// Chat Messages Schema
const chatMessageSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  message_id: { type: String, required: true },
  space_id: { type: String, required: true },
  space_name: { type: String, required: true },
  space_type: { 
    type: String, 
    required: true,
    enum: ['DIRECT_MESSAGE', 'GROUP_CHAT', 'SPACE']
  },
  sender_id: { type: String, required: true },
  sender_name: { type: String, required: true },
  sender_email: { type: String },
  content: { type: String, required: true },
  message_time: { type: Date, required: true },
  thread_id: { type: String },
  is_threaded: { type: Boolean, default: false },
  raw_data: { type: mongoose.Schema.Types.Mixed },
  created_at: { type: Date, default: getLocalDate }
});

// LLM Analysis Results Schema
const llmAnalysisResultSchema = new mongoose.Schema({
  generated_at: { type: Date, required: true, default: getLocalDate },
  total_responses: { type: Number, required: true, default: 0 },
  responses: [{
    to: { type: String, required: true },
    msg: { type: String, required: true },
    time_generated: { type: String, required: true }
  }],
  is_latest: { type: Boolean, default: false }, // Flag to mark the latest analysis
  analysis_version: { type: String, default: '1.0' },
  created_at: { type: Date, default: getLocalDate }
});

// Index for performance
llmAnalysisResultSchema.index({ generated_at: -1 });
llmAnalysisResultSchema.index({ is_latest: 1 });

// Create models
const User = mongoose.model('User', userSchema);
const GmailMessage = mongoose.model('GmailMessage', gmailMessageSchema);
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
const LLMAnalysisResult = mongoose.model('LLMAnalysisResult', llmAnalysisResultSchema);

// Utility Functions

// Get all active users
async function getAllActiveUsers() {
  await connectToMongoDB();
  const users = await User.find({
    access_token: { $exists: true, $ne: null },
    refresh_token: { $exists: true, $ne: null }
  });
  
  // Transform user data to include google_tokens object for compatibility
  return users.map(user => ({
    id: user._id,
    email: user.email,
    name: user.name,
    google_id: user.google_id,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_gmail_sync: user.last_gmail_sync,
    last_chat_sync: user.last_chat_sync,
    google_tokens: {
      access_token: user.access_token,
      refresh_token: user.refresh_token,
      expiry_date: user.token_expiry ? user.token_expiry.getTime() : Date.now() + (60 * 60 * 1000), // Default to 1 hour from now if not set
      token_type: 'Bearer'
    }
  }));
}

// Update user tokens
async function updateUserTokens(userId, tokens) {
  await connectToMongoDB();
  
  const updateData = {
    access_token: tokens.access_token,
    token_expiry: new Date(tokens.expiry_date),
    updated_at: getLocalDate()
  };
  
  if (tokens.refresh_token) {
    updateData.refresh_token = tokens.refresh_token;
  }
  
  return await User.findByIdAndUpdate(userId, updateData, { new: true });
}

// Gmail message functions
async function insertGmailMessages(messages) {
  await connectToMongoDB();
  
  if (!messages || messages.length === 0) return { insertedCount: 0 };
  
  try {
    const result = await GmailMessage.insertMany(messages, { 
      ordered: false,
      rawResult: true 
    });
    return { insertedCount: result.insertedCount || messages.length };
  } catch (error) {
    if (error.code === 11000) {
      // Handle duplicate key errors
      const insertedCount = messages.length - error.writeErrors?.length || 0;
      return { insertedCount };
    }
    throw error;
  }
}

async function hasExistingGmailMessages(userId) {
  await connectToMongoDB();
  const count = await GmailMessage.countDocuments({ user_id: userId });
  return count > 0;
}

async function getLastGmailSyncTime(userId) {
  await connectToMongoDB();
  const user = await User.findById(userId);
  return user?.last_gmail_sync || null;
}

async function getLatestGmailMessageTime(userId) {
  await connectToMongoDB();
  const latest = await GmailMessage.findOne(
    { user_id: userId },
    { message_time: 1 },
    { sort: { message_time: -1 } }
  );
  return latest?.message_time || null;
}

// Chat message functions  
async function insertChatMessages(messages) {
  await connectToMongoDB();
  
  if (!messages || messages.length === 0) {
    console.log('insertChatMessages: No messages provided');
    return { insertedCount: 0 };
  }
  
  console.log(`insertChatMessages: Attempting to insert ${messages.length} messages`);
  
  // Validate messages before insertion
  const validMessages = [];
  const invalidMessages = [];
  
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.user_id || !msg.message_id || !msg.space_id || !msg.space_name || !msg.space_type) {
      console.warn(`Invalid message at index ${i}:`, {
        user_id: msg.user_id,
        message_id: msg.message_id,
        space_id: msg.space_id,
        space_name: msg.space_name,
        space_type: msg.space_type
      });
      invalidMessages.push(i);
    } else {
      validMessages.push(msg);
    }
  }
  
  if (invalidMessages.length > 0) {
    console.warn(`Found ${invalidMessages.length} invalid messages, proceeding with ${validMessages.length} valid messages`);
  }
  
  if (validMessages.length === 0) {
    console.warn('No valid messages to insert');
    return { insertedCount: 0 };
  }
  
  try {
    console.log(`Inserting ${validMessages.length} valid chat messages...`);
    const result = await ChatMessage.insertMany(validMessages, { 
      ordered: false,
      rawResult: true 
    });
    
    console.log(`✅ Insert operation completed. Result:`, {
      insertedCount: result.insertedCount || validMessages.length,
      acknowledged: result.acknowledged,
      rawResult : JSON.stringify(result.mongoose, null, 2)
    });
    
    return { insertedCount: result.insertedCount || validMessages.length };
  } catch (error) {
    console.error('❌ Insert operation failed:', error.message);
    
    if (error.code === 11000) {
      // Handle duplicate key errors
      console.log('Handling duplicate key errors...');
      const writeErrors = error.writeErrors || [];
      const insertedCount = validMessages.length - writeErrors.length;
      
      console.log(`Duplicate key handling: ${insertedCount} inserted, ${writeErrors.length} duplicates`);
      
      if (writeErrors.length > 0) {
        console.log(`Sample duplicate error:`, writeErrors[0]);
      }
      
      return { insertedCount };
    } else {
      console.error('Non-duplicate error details:', {
        name: error.name,
        message: error.message,
        code: error.code
      });
      throw error;
    }
  }
}

async function hasExistingChatMessages(userId) {
  await connectToMongoDB();
  const count = await ChatMessage.countDocuments({ user_id: userId });
  return count > 0;
}

async function getLastChatSyncTime(userId) {
  await connectToMongoDB();
  const user = await User.findById(userId);
  return user?.last_chat_sync || null;
}

async function getLatestChatMessageTime(userId) {
  await connectToMongoDB();
  const latest = await ChatMessage.findOne(
    { user_id: userId },
    { message_time: 1 }, // Schema uses message_time
    { sort: { message_time: -1 } }
  );
  return latest?.message_time || null;
}

async function getChatMessagesBySpace(spaceId, limit = 50) {
  await connectToMongoDB();
  return await ChatMessage.find(
    {space_id: spaceId },
    null,
    { sort: { message_time: -1 }, limit }
  );
}

// Get all chat messages for a user
async function getChatMessagesByUser(userId, limit = 100) {
  await connectToMongoDB();
  return await ChatMessage.find(
    { user_id: userId },
    null,
    { sort: { message_time: -1 }, limit }
  );
}

// Get recent Gmail messages for a user  
async function getRecentGmailMessages(userId, limit = 100) {
  await connectToMongoDB();
  return await GmailMessage.find(
    { user_id: userId },
    null,
    { sort: { message_time: -1 }, limit }
  );
}

// New function to check if a space has any messages for a user
async function hasExistingChatMessagesInSpace(userId, spaceId) {
  await connectToMongoDB();
  const count = await ChatMessage.countDocuments({ user_id: userId, space_id: spaceId });
  return count > 0;
}

// New function to get the createTime of the latest chat message in a specific space for a user
async function getLatestChatMessageCreateTimeForSpace(userId, spaceId) {
  await connectToMongoDB();
  const latestMessage = await ChatMessage.findOne(
    { user_id: userId, space_id: spaceId },
    { message_time: 1 }, // message_time stores the original createTime as a Date
    { sort: { message_time: -1 } }
  );
  return latestMessage?.message_time || null; // This will be a Date object or null
}

// Sync log function (simple logging to console for now)
async function createSyncLog(userId, syncType, status, details = {}, itemCount = 0) {
  const logEntry = {
    user_id: userId,
    sync_type: syncType,
    status,
    details: typeof details === 'string' ? details : JSON.stringify(details),
    item_count: itemCount,
    timestamp: getLocalDate()
  };
  
  console.log(`SYNC_LOG: user_id=${userId}, type=${syncType}, status=${status}, items=${itemCount}, details=${logEntry.details}, time=${logEntry.timestamp.toLocaleString()}`);
  
  // Update user's last sync time based on sync type
  if (status === 'success') {
    const updateField = syncType === 'gmail' ? 'last_gmail_sync' : 'last_chat_sync';
    await User.findByIdAndUpdate(userId, { 
      [updateField]: getLocalDate(),
      updated_at: getLocalDate() 
    });
  }
  
  return logEntry;
}

// User management functions
async function createOrUpdateUser(email, tokens) {
  await connectToMongoDB();
  
  try {
    // Check if user exists
    let user = await User.findOne({ email });
    
    if (user) {
      // Update existing user
      user.access_token = tokens.access_token;
      user.refresh_token = tokens.refresh_token;
      user.token_expiry = new Date(tokens.expiry_date);
      user.updated_at = getLocalDate();
      await user.save();
    } else {
      // Create new user
      user = new User({
        google_id: tokens.google_id || email,
        email,
        name: tokens.name || email.split('@')[0],
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expiry: new Date(tokens.expiry_date)
      });
      await user.save();
    }
    
    return user;
  } catch (error) {
    console.error('Error creating/updating user:', error);
    throw error;
  }
}

async function getUserByEmail(email) {
  await connectToMongoDB();
  return await User.findOne({ email });
}

async function healthCheck() {
  try {
    await connectToMongoDB();
    return { status: 'connected', timestamp: getLocalDate() };
  } catch (error) {
    return { status: 'disconnected', error: error.message };
  }
}

async function getDashboardStats() {
  await connectToMongoDB();
  
  const totalUsers = await User.countDocuments();
  const totalGmailMessages = await GmailMessage.countDocuments();
  const totalChatMessages = await ChatMessage.countDocuments();
  
  // Get users with recent activity
  const activeUsers = await User.find({
    $or: [
      { last_gmail_sync: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      { last_chat_sync: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }
    ]
  }).countDocuments();
  
  return {
    total_users: totalUsers,
    active_users: activeUsers,
    total_gmail_messages: totalGmailMessages,
    total_chat_messages: totalChatMessages,
    last_updated: getLocalDate()
  };
}

async function getUserStats(userId) {
  await connectToMongoDB();
  
  const gmailCount = await GmailMessage.countDocuments({ user_id: userId });
  const chatCount = await ChatMessage.countDocuments({ user_id: userId });
  
  // Get latest message times
  const latestGmail = await GmailMessage.findOne(
    { user_id: userId },
    { message_time: 1 },
    { sort: { message_time: -1 } }
  );
  
  const latestChat = await ChatMessage.findOne(
    { user_id: userId },
    { message_time: 1 },
    { sort: { message_time: -1 } }
  );
  
  return {
    gmail_messages: gmailCount,
    chat_messages: chatCount,
    latest_gmail_message: latestGmail?.message_time,
    latest_chat_message: latestChat?.message_time
  };
}

async function getRecentSyncLogs(userId, limit = 10) {
  // For now, return empty array since we're not storing sync logs in MongoDB
  // In the future, you could create a SyncLog collection
  return [];
}

// LLM Analysis Result functions
async function saveLLMAnalysisResults(analysisData) {
  await connectToMongoDB();
  
  try {
    // First, mark all existing results as not latest
    await LLMAnalysisResult.updateMany(
      { is_latest: true },
      { is_latest: false }
    );
    
    // Parse the generated_at date properly
    let generatedAtDate;
    if (analysisData.generated_at) {
      // If it's a string, try to parse it or use current date
      if (typeof analysisData.generated_at === 'string') {
        generatedAtDate = new Date(); // Use current date as the string format might be locale-specific
      } else {
        generatedAtDate = new Date(analysisData.generated_at);
      }
    } else {
      generatedAtDate = new Date();
    }
    
    // Create new analysis result
    const analysisResult = new LLMAnalysisResult({
      generated_at: generatedAtDate,
      total_responses: analysisData.total_responses || 0,
      responses: analysisData.responses || [],
      is_latest: true,
      analysis_version: '1.0'
    });
    
    await analysisResult.save();
    
    console.log(`✅ LLM analysis results saved to MongoDB with ${analysisData.total_responses} responses`);
    return analysisResult;
    
  } catch (error) {
    console.error('❌ Failed to save LLM analysis results to MongoDB:', error);
    throw error;
  }
}

async function getLatestLLMAnalysisResults() {
  await connectToMongoDB();
  
  try {
    const latestResult = await LLMAnalysisResult.findOne(
      { is_latest: true },
      null,
      { sort: { generated_at: -1 } }
    );
    
    if (!latestResult) {
      return null;
    }
    
    // Convert to the expected format
    return {
      generated_at: latestResult.generated_at.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).replace(/(\d{4})-(\d{2})-(\d{2}), (\d{2}):(\d{2}):(\d{2})/, '$3/$2/$1, $4:$5:$6'),
      total_responses: latestResult.total_responses,
      responses: latestResult.responses
    };
    
  } catch (error) {
    console.error('❌ Failed to get latest LLM analysis results from MongoDB:', error);
    throw error;
  }
}

async function getAllLLMAnalysisResults(limit = 20) {
  await connectToMongoDB();
  
  try {
    const results = await LLMAnalysisResult.find(
      {},
      null,
      { 
        sort: { generated_at: -1 },
        limit: limit
      }
    );
    
    return results.map(result => ({
      id: result._id,
      generated_at: result.generated_at.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).replace(/(\d{4})-(\d{2})-(\d{2}), (\d{2}):(\d{2}):(\d{2})/, '$3/$2/$1, $4:$5:$6'),
      total_responses: result.total_responses,
      responses: result.responses,
      is_latest: result.is_latest,
      analysis_version: result.analysis_version
    }));
    
  } catch (error) {
    console.error('❌ Failed to get LLM analysis results from MongoDB:', error);
    throw error;
  }
}

// System State Schema for data fetcher tracking
const systemStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  isRunning: { type: Boolean, default: false },
  startTime: { type: Date },
  lastUpdated: { type: Date, default: Date.now }
});

const SystemState = mongoose.model('SystemState', systemStateSchema);

// Data Fetcher State Management
async function setDataFetcherRunning(isRunning, startTime = null) {
  await connectToMongoDB();
  
  try {
    const state = {
      isRunning,
      startTime: startTime ? new Date(startTime) : null,
      lastUpdated: new Date()
    };
    
    await SystemState.updateOne(
      { key: 'data_fetcher' },
      { $set: state },
      { upsert: true }
    );
    
    return true;
  } catch (error) {
    console.error('Error setting data fetcher state:', error);
    return false;
  }
}

async function getDataFetcherState() {
  await connectToMongoDB();
  
  try {
    const state = await SystemState.findOne({ key: 'data_fetcher' });
    
    if (!state) {
      console.log('No data fetcher state found in database, returning default state');
      return { isRunning: false, startTime: null };
    }
    
    // Check for stale state (running for more than 30 minutes = likely crashed)
    const now = new Date();
    const maxRunTime = 30 * 60 * 1000; // 30 minutes
    
    if (state.isRunning && state.startTime && 
        (now - new Date(state.startTime)) > maxRunTime) {
      const staleDuration = Math.round((now - new Date(state.startTime)) / 1000);
      console.log(`⚠️ Detected stale data fetcher state (running for ${staleDuration}s), resetting to false`);
      
      // Reset stale state
      await setDataFetcherRunning(false);
      return { 
        isRunning: false, 
        startTime: null,
        wasStale: true,
        staleDurationSeconds: staleDuration
      };
    }
    
    const currentDuration = state.startTime ? Math.round((now - new Date(state.startTime)) / 1000) : 0;
    console.log(`Data fetcher state: ${state.isRunning ? 'RUNNING' : 'IDLE'} (${currentDuration}s)`);
    
    return {
      isRunning: state.isRunning,
      startTime: state.startTime,
      lastUpdated: state.lastUpdated,
      currentDurationSeconds: currentDuration
    };
  } catch (error) {
    console.error('Error getting data fetcher state:', error);
    return { isRunning: false, startTime: null };
  }
}

module.exports = {  connectToMongoDB,
  User,
  GmailMessage,
  ChatMessage,
  LLMAnalysisResult,
  SystemState,
  mongoose,
  getLocalDate,
  toLocalDate,
  // Utility functions
  getAllActiveUsers,
  updateUserTokens,
  insertGmailMessages,
  hasExistingGmailMessages,
  getLastGmailSyncTime,
  getLatestGmailMessageTime,
  getRecentGmailMessages,
  insertChatMessages,
  hasExistingChatMessages,
  getLastChatSyncTime,
  getLatestChatMessageTime,
  getChatMessagesBySpace,
  getChatMessagesByUser,
  hasExistingChatMessagesInSpace, // Add new function
  getLatestChatMessageCreateTimeForSpace, // Add new function
  createSyncLog,
  // Server functions
  createOrUpdateUser,
  getUserByEmail,
  healthCheck,
  getDashboardStats,
  getUserStats,
  getRecentSyncLogs,
  // LLM Analysis Result functions
  saveLLMAnalysisResults,
  getLatestLLMAnalysisResults,
  getAllLLMAnalysisResults,
  // Data Fetcher State Management
  setDataFetcherRunning,
  getDataFetcherState
};
