const { createClient } = require('@supabase/supabase-js');
const winston = require('winston');

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

class SupabaseClient {
  constructor() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('Missing Supabase configuration. Please check SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables.');
    }

    this.client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    logger.info('Supabase client initialized successfully');
  }

  // User management methods
  async createOrUpdateUser(email, googleTokens) {
    try {
      const { data, error } = await this.client
        .from('users')
        .upsert(
          { 
            email, 
            google_tokens: googleTokens,
            last_sync: new Date().toISOString()
          },
          { 
            onConflict: 'email',
            returning: 'minimal'
          }
        )
        .select()
        .single();

      if (error) throw error;
      logger.info(`User ${email} created/updated successfully`);
      return data;
    } catch (error) {
      logger.error('Error creating/updating user:', error);
      throw error;
    }
  }

  async getUserByEmail(email) {
    try {
      const { data, error } = await this.client
        .from('users')
        .select('*')
        .eq('email', email)
        .eq('is_active', true)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data;
    } catch (error) {
      logger.error('Error fetching user:', error);
      throw error;
    }
  }

  async getAllActiveUsers() {
    try {
      const { data, error } = await this.client
        .from('users')
        .select('*')
        .eq('is_active', true);

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching active users:', error);
      throw error;
    }
  }

  async updateUserTokens(userId, tokens) {
    try {
      const { error } = await this.client
        .from('users')
        .update({ 
          google_tokens: tokens,
          last_sync: new Date().toISOString()
        })
        .eq('id', userId);

      if (error) throw error;
      logger.info(`Updated tokens for user ${userId}`);
    } catch (error) {
      logger.error('Error updating user tokens:', error);
      throw error;
    }
  }

  // Chat messages methods
  async insertChatMessages(messages) {
    if (!messages || messages.length === 0) return [];

    try {
      const { data, error } = await this.client
        .from('chat_messages')
        .upsert(messages, { 
          onConflict: 'user_id,message_id,space_id',
          ignoreDuplicates: true
        })
        .select();

      if (error) throw error;
      logger.info(`Inserted/updated ${data?.length || 0} chat messages`);
      return data || [];
    } catch (error) {
      logger.error('Error inserting chat messages:', error);
      throw error;
    }
  }
  async getChatMessagesByUser(userId, limit = 100) {
    try {
      let query = this.client
        .from('chat_messages')
        .select('*')
        .eq('user_id', userId)
        .order('timestamp', { ascending: false });
      
      // Only apply limit if specified and not null
      if (limit !== null) {
        query = query.limit(limit);
      }
      
      const { data, error } = await query;

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching chat messages:', error);
      throw error;
    }
  }

  // Gmail messages methods
  async insertGmailMessages(messages) {
    if (!messages || messages.length === 0) return [];

    try {
      const { data, error } = await this.client
        .from('gmail_messages')
        .upsert(messages, { 
          onConflict: 'user_id,message_id',
          ignoreDuplicates: true
        })
        .select();

      if (error) throw error;
      logger.info(`Inserted/updated ${data?.length || 0} gmail messages`);
      return data || [];
    } catch (error) {
      logger.error('Error inserting gmail messages:', error);
      throw error;
    }
  }
  async getGmailMessagesByUser(userId, limit = null) {
    try {
      let query = this.client
        .from('gmail_messages')
        .select('*')
        .eq('user_id', userId)
        .order('date_received', { ascending: false });
      
      // Only apply limit if specified
      if (limit !== null) {
        query = query.limit(limit);
      }
      
      const { data, error } = await query;

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching gmail messages:', error);
      throw error;
    }
  }

  // Get last successful Gmail sync time for a user
  async getLastGmailSyncTime(userId) {
    try {
      const { data, error } = await this.client
        .from('sync_logs')
        .select('completed_at')
        .eq('user_id', userId)
        .eq('sync_type', 'gmail')
        .eq('status', 'success')
        .order('completed_at', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return data?.completed_at || null;
    } catch (error) {
      logger.error('Error fetching last Gmail sync time:', error);
      return null;
    }
  }
  // Get recent Gmail messages for dashboard (limited to 50)
  async getRecentGmailMessages(userId, limit = 50) {
    try {
      const { data, error } = await this.client
        .from('gmail_messages')
        .select('*')
        .eq('user_id', userId)
        .order('date_received', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching recent Gmail messages:', error);
      throw error;
    }
  }

  // Check if user has any existing Gmail messages
  async hasExistingGmailMessages(userId) {
    try {
      const { data, error } = await this.client
        .from('gmail_messages')
        .select('id')
        .eq('user_id', userId)
        .limit(1);

      if (error) throw error;
      return data && data.length > 0;
    } catch (error) {
      logger.error('Error checking existing Gmail messages:', error);
      return false;
    }
  }

  // System stats methods
  async getSystemStats() {
    try {
      const { data, error } = await this.client
        .rpc('get_system_stats');

      if (error) throw error;
      return data || {};
    } catch (error) {
      logger.error('Error fetching system stats:', error);
      return await this.getSystemStatsManual();
    }
  }

  async getSystemStatsManual() {
    try {
      const [users, chatMessages, gmailMessages] = await Promise.all([
        this.getAllActiveUsers(),
        this.client.from('chat_messages').select('id', { count: 'exact' }),
        this.client.from('gmail_messages').select('id', { count: 'exact' })
      ]);

      return {
        total_users: users.length,
        total_chat_messages: chatMessages.count || 0,
        total_gmail_messages: gmailMessages.count || 0
      };
    } catch (error) {
      logger.error('Error calculating manual system stats:', error);
      return { total_users: 0, total_chat_messages: 0, total_gmail_messages: 0 };
    }
  }

  // Sync logs methods
  async createSyncLog(userId, syncType, status, message = null, recordsProcessed = 0, errorDetails = null) {
    try {
      const logData = {
        user_id: userId,
        sync_type: syncType,
        status,
        message,
        records_processed: recordsProcessed,
        error_details: errorDetails,
        completed_at: new Date().toISOString()
      };

      const { data, error } = await this.client
        .from('sync_logs')
        .insert(logData)
        .select()
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Error creating sync log:', error);
      throw error;
    }
  }

  async getRecentSyncLogs(userId, limit = 10) {
    try {
      const { data, error } = await this.client
        .from('sync_logs')
        .select('*')
        .eq('user_id', userId)
        .order('completed_at', { ascending: false, nullsLast: true })
        .order('started_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data || [];
    } catch (error) {
      logger.error('Error fetching sync logs:', error);
      throw error;
    }
  }

  // User stats methods
  async getUserStats(userId) {
    try {
      const { data, error } = await this.client
        .rpc('get_user_stats', { user_uuid: userId });

      if (error) {
        // If function doesn't exist, fall back to manual counting
        if (error.code === '42883') {
          return await this.getUserStatsManual(userId);
        }
        throw error;
      }
      return data || {};
    } catch (error) {
      logger.error('Error fetching user stats:', error);
      return await this.getUserStatsManual(userId);
    }
  }
  async getUserStatsManual(userId) {
    try {
      const [chatMessages, gmailMessages, syncLogs] = await Promise.all([
        this.getChatMessagesByUser(userId, null), // No limit
        this.getGmailMessagesByUser(userId, null), // No limit
        this.getRecentSyncLogs(userId, 100)
      ]);

      const lastChatSync = syncLogs
        .filter(log => log.sync_type === 'chat' && log.status === 'success')
        .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))[0]?.completed_at;

      const lastGmailSync = syncLogs
        .filter(log => log.sync_type === 'gmail' && log.status === 'success')
        .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))[0]?.completed_at;

      const uniqueSpaces = [...new Set(chatMessages.map(msg => msg.space_id))].length;

      return {
        total_chat_messages: chatMessages.length,
        total_gmail_messages: gmailMessages.length,
        last_chat_sync: lastChatSync,
        last_gmail_sync: lastGmailSync,
        unique_spaces: uniqueSpaces
      };
    } catch (error) {
      logger.error('Error calculating manual user stats:', error);
      return { 
        total_chat_messages: 0, 
        total_gmail_messages: 0, 
        last_chat_sync: null, 
        last_gmail_sync: null, 
        unique_spaces: 0 
      };
    }
  }

  // Health check method
  async healthCheck() {
    try {
      const { data, error } = await this.client
        .from('users')
        .select('count')
        .limit(1);

      if (error) throw error;
      return { status: 'healthy', timestamp: new Date().toISOString() };
    } catch (error) {
      logger.error('Supabase health check failed:', error);
      throw error;
    }
  }
}

// Export singleton instance
module.exports = new SupabaseClient();
