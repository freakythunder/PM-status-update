require('dotenv').config();
const GoogleAuthManager = require('../utils/googleAuth');
const { connectToMongoDB, getAllActiveUsers, mongoose } = require('../utils/mongodb');

class DSURawFetcher {
  constructor() {
    this.googleAuth = new GoogleAuthManager();
  }

  async findDSUSpaceFromAPI(chatClient) {
    console.log('🔍 Searching for DSU implementation spaces via Google Chat API...\n');
    
    const spacesResponse = await this.googleAuth.executeWithRetry(async () => {
      return await chatClient.spaces.list({ pageSize: 100 });
    });

    const spaces = spacesResponse.data.spaces || [];
    console.log(`Found ${spaces.length} total spaces\n`);

    // Find DSU-related spaces
    const dsuSpaces = spaces.filter(space => {
      const name = (space.displayName || '').toLowerCase();
      return name.includes('dsu') || 
             name.includes('implementation') || 
             name.includes('standup') ||
             name.includes('daily');
    });

    if (dsuSpaces.length === 0) {
      console.log('❌ No DSU implementation spaces found in Google Chat API');
      return null;
    }

    console.log(`✅ Found ${dsuSpaces.length} DSU-related spaces:`);
    dsuSpaces.forEach((space, index) => {
      console.log(`${index + 1}. ${space.displayName || space.name} (${space.type})`);
    });
    console.log();

    return dsuSpaces[0]; // Return first DSU space
  }

  async fetchRawMessages(user) {
    try {
      console.log(`🚀 Fetching raw DSU messages for user: ${user.email}\n`);
      
      const chatClient = this.googleAuth.createChatClient(user.google_tokens);
      
      // Find DSU space
      const dsuSpace = await this.findDSUSpaceFromAPI(chatClient);
      if (!dsuSpace) {
        return;
      }

      console.log(`📍 Selected space: ${dsuSpace.displayName || dsuSpace.name}`);
      console.log(`🔗 Space ID: ${dsuSpace.name}\n`);

      // Fetch messages from the DSU space
      console.log('📥 Fetching raw messages...\n');
      
      const messagesResponse = await this.googleAuth.executeWithRetry(async () => {
        return await chatClient.spaces.messages.list({
          parent: dsuSpace.name,
          pageSize: 50,
          orderBy: 'createTime asc'
        });
      });

      const messages = messagesResponse.data.messages || [];
      
      console.log('='.repeat(100));
      console.log(`RAW GOOGLE CHAT API RESPONSE - ${messages.length} MESSAGES`);
      console.log('='.repeat(100));
      console.log();

      if (messages.length === 0) {
        console.log('❌ No messages found in DSU space');
        return;
      }

      // Display each message in raw format
      messages.forEach((message, index) => {
        console.log(`MESSAGE ${index + 1}:`);
        console.log(JSON.stringify(message, null, 2));
        console.log('\n' + '-'.repeat(80) + '\n');
      });

      console.log(`📊 Total messages displayed: ${messages.length}`);
      
    } catch (error) {
      console.error('❌ Error fetching raw messages:', error.message);
      if (error.stack) {
        console.error('Stack trace:', error.stack);
      }
    }
  }

  async run() {
    try {
      await connectToMongoDB();
      
      const activeUsers = await getAllActiveUsers();
      if (activeUsers.length === 0) {
        console.log('❌ No active users found in database');
        return;
      }

      console.log(`Found ${activeUsers.length} active users. Using first user: ${activeUsers[0].email}\n`);
      
      // Use first active user
      const user = activeUsers[0];
      
      // Refresh tokens if needed
      const refreshedTokens = await this.googleAuth.refreshTokenIfNeeded(user.google_tokens);
      if (refreshedTokens) {
        user.google_tokens = { ...user.google_tokens, ...refreshedTokens };
      }

      await this.fetchRawMessages(user);
      
    } catch (error) {
      console.error('❌ Script execution failed:', error.message);
    } finally {
      await mongoose.disconnect();
      console.log('\n🔌 Database connection closed');
    }
  }
}

// Run the script if executed directly
if (require.main === module) {
  const fetcher = new DSURawFetcher();
  fetcher.run();
}

module.exports = DSURawFetcher;
