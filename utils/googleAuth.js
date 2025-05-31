const { google } = require('googleapis');
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

class GoogleAuthManager {
  constructor() {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      throw new Error('Missing Google OAuth configuration. Please check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.');
    }    this.clientId = process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    
    // Use ngrok URL if available, otherwise fall back to localhost
    const baseUrl = process.env.NGROK_URL || `http://localhost:${process.env.PORT || 3000}`;
    this.redirectUri = `${baseUrl}/auth/callback`;    // Required scopes for Google Chat and Gmail APIs
    this.scopes = [
      'https://www.googleapis.com/auth/chat.spaces.readonly',
      'https://www.googleapis.com/auth/chat.messages.readonly',
      'https://www.googleapis.com/auth/chat.memberships.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ];

    logger.info('Google Auth Manager initialized successfully');
  }

  // Create OAuth2 client
  createOAuth2Client() {
    return new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      this.redirectUri
    );
  }
  // Generate authorization URL
  generateAuthUrl(state = null) {
    const oauth2Client = this.createOAuth2Client();
    
    // Generate state if not provided
    const finalState = state || Math.random().toString(36).substring(7);
    
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: this.scopes,
      prompt: 'consent', // Force consent to get refresh token
      state: finalState
    });

    logger.info(`Generated auth URL for Google OAuth with state: ${finalState}`);
    return { authUrl, state: finalState };
  }

  // Exchange authorization code for tokens
  async exchangeCodeForTokens(code) {
    try {
      const oauth2Client = this.createOAuth2Client();
      const { tokens } = await oauth2Client.getToken(code);
      
      // Set credentials for user info retrieval
      oauth2Client.setCredentials(tokens);
      
      // Get user info
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const { data: userInfo } = await oauth2.userinfo.get();

      logger.info(`Successfully exchanged code for tokens for user: ${userInfo.email}`);
      
      return {
        tokens,
        userInfo: {
          email: userInfo.email,
          name: userInfo.name,
          picture: userInfo.picture
        }
      };
    } catch (error) {
      logger.error('Error exchanging code for tokens:', error);
      throw error;
    }
  }

  // Create authenticated client from stored tokens
  createAuthenticatedClient(tokens) {
    const oauth2Client = this.createOAuth2Client();
    oauth2Client.setCredentials(tokens);
    return oauth2Client;
  }

  // Refresh access token if needed
  async refreshTokenIfNeeded(tokens) {
    try {
      const oauth2Client = this.createAuthenticatedClient(tokens);
      
      // Check if token is expired or about to expire (within 5 minutes)
      const now = Date.now();
      const expiryTime = tokens.expiry_date || 0;
      const fiveMinutes = 5 * 60 * 1000;

      if (expiryTime - now < fiveMinutes) {
        logger.info('Refreshing expired access token');
        const { credentials } = await oauth2Client.refreshAccessToken();
        return credentials;
      }

      return tokens;
    } catch (error) {
      logger.error('Error refreshing token:', error);
      throw error;
    }
  }  // Create Google Chat API client
  createChatClient(tokens) {
    const auth = this.createAuthenticatedClient(tokens);
    return google.chat({ version: 'v1', auth });
  }

  // Create Google Gmail API client
  createGmailClient(tokens) {
    const auth = this.createAuthenticatedClient(tokens);
    return google.gmail({ version: 'v1', auth });
  }

  // Validate token and get user info
  async validateTokenAndGetUserInfo(tokens) {
    try {
      const oauth2Client = this.createAuthenticatedClient(tokens);
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const { data: userInfo } = await oauth2.userinfo.get();

      return {
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture
      };
    } catch (error) {
      logger.error('Error validating token:', error);
      throw error;
    }
  }

  // Handle API rate limiting with exponential backoff
  async executeWithRetry(apiCall, maxRetries = 3, baseDelay = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error) {
        if (error.code === 429 || error.code === 503) {
          // Rate limited or service unavailable
          if (attempt === maxRetries) {
            logger.error(`Max retries reached for API call: ${error.message}`);
            throw error;
          }

          const delay = baseDelay * Math.pow(2, attempt - 1);
          logger.warn(`Rate limited, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
          await this.sleep(delay);
        } else {
          // Other errors - don't retry
          throw error;
        }
      }
    }
  }

  // Helper method for delays
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }  // Check if user has required permissions
  async checkPermissions(tokens) {
    try {
      const oauth2Client = this.createAuthenticatedClient(tokens);
      
      const permissions = {
        chat: false,
        gmail: false
      };

      // Test Chat API access - actually test spaces listing
      try {
        const chat = google.chat({ version: 'v1', auth: oauth2Client });
        // Test the actual API call that's failing
        await chat.spaces.list({ pageSize: 1 });
        permissions.chat = true;
        logger.info('Chat API spaces access verified successfully');
      } catch (error) {
        logger.warn('Chat API spaces permission check failed:', error.message);
        permissions.chat = false;
      }

      // Test Gmail API access
      try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        await gmail.users.messages.list({ userId: 'me', maxResults: 1 });
        permissions.gmail = true;
        logger.info('Gmail API access verified successfully');
      } catch (error) {
        logger.warn('Gmail API permission check failed:', error.message);
        permissions.gmail = false;
      }

      return permissions;
    } catch (error) {
      logger.error('Error checking permissions:', error);
      return { chat: false, gmail: false };
    }
  }
}

module.exports = GoogleAuthManager;
