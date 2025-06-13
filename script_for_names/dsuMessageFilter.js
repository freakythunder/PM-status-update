require('dotenv').config();
const GoogleAuthManager = require('../utils/googleAuth');
const { connectToMongoDB, getAllActiveUsers, mongoose } = require('../utils/mongodb');

class DSUMessageFilter {
  constructor() {
    this.googleAuth = new GoogleAuthManager();
    // Target user IDs to filter for
    this.targetUserIds = [
   'users/101264342520983707507',
   'users/100801998779771682098',
   'users/110061618913611509932', 
   'users/111660142706640776350' 
    ];
  }

  async findDSUSpace(chatClient) {
    console.log('🔍 Finding DSU implementation space...');
    
    const spacesResponse = await this.googleAuth.executeWithRetry(async () => {
      return await chatClient.spaces.list({ pageSize: 100 });
    });

    const spaces = spacesResponse.data.spaces || [];
    const dsuSpace = spaces.find(space => {
      const name = (space.displayName || '').toLowerCase();
      return name.includes('climaty.ai');
    });

    if (!dsuSpace) {
      throw new Error('DSU Implementation space not found');
    }

    console.log(`✅ Found DSU space: ${dsuSpace.displayName} (${dsuSpace.name})`);
    return dsuSpace;
  }

  checkForTargetUsers(message) {
    if (!message.annotations) {
      return null;
    }

    // Filter for USER_MENTION annotations with HUMAN type
    const userMentions = message.annotations.filter(annotation => {
      return annotation.type === 'USER_MENTION' &&
             annotation.userMention &&
             annotation.userMention.user &&
             annotation.userMention.user.type === 'HUMAN';
    });

    if (userMentions.length === 0) {
      return null;
    }

    // Check if any mentioned user is in our target list
    const matchingUsers = userMentions.filter(mention => {
      const userName = mention.userMention.user.name;
      return this.targetUserIds.includes(userName);
    });

    return matchingUsers.length > 0 ? matchingUsers : null;
  }

  async fetchAndFilterMessages(user) {
    try {
      console.log(`🚀 Starting message filtering for: ${user.email}\n`);
      
      const chatClient = this.googleAuth.createChatClient(user.google_tokens);
      const dsuSpace = await this.findDSUSpace(chatClient);

      console.log('\n📥 Fetching all DSU messages...');
      
      let allMessages = [];
      let nextPageToken = null;
      let pageCount = 0;

      do {
        pageCount++;
        console.log(`📄 Fetching page ${pageCount}...`);
        
        const messagesResponse = await this.googleAuth.executeWithRetry(async () => {
          return await chatClient.spaces.messages.list({
            parent: dsuSpace.name,
            pageSize: 100,
            orderBy: 'createTime asc',
            pageToken: nextPageToken
          });
        });

        const messages = messagesResponse.data.messages || [];
        allMessages.push(...messages);
        nextPageToken = messagesResponse.data.nextPageToken;

        console.log(`📊 Page ${pageCount}: ${messages.length} messages (Total: ${allMessages.length})`);
        
        if (nextPageToken) {
          await this.googleAuth.sleep(200);
        }

      } while (nextPageToken);

      console.log(`\n✅ Total messages fetched: ${allMessages.length}`);

      // Filter messages for target users
      let matchCount = 0;
      console.log('\n🎯 Filtering messages for target users...\n');

      allMessages.forEach((message, index) => {
        const matchingUsers = this.checkForTargetUsers(message);
        
        if (matchingUsers) {
          matchCount++;
          console.log(`\n=== MATCH ${matchCount} - Message ${index + 1} ===`);
          
          // Print matching user details
          console.log('👥 Matching Users:');
          matchingUsers.forEach(mention => {
            console.log(`   - ${mention.userMention.user.name} (${mention.userMention.user.type})`);
          });
          
          // Print message content
          console.log('\n📝 ArgumentText:');
          console.log(message.argumentText || 'N/A');
          
          console.log('\n🏷️ FormattedText:');
          console.log(message.formattedText || 'N/A');
          
          console.log('\n📅 Created:');
          console.log(message.createTime || 'N/A');
          
          console.log('\n' + '='.repeat(50));
        }
      });

      console.log(`\n📊 Summary: Found ${matchCount} messages mentioning target users`);
      console.log(`🎯 Target users searched: ${this.targetUserIds.length}`);
      
      return { totalMessages: allMessages.length, matchingMessages: matchCount };

    } catch (error) {
      console.error('❌ Error in filtering process:', error.message);
      throw error;
    }
  }

  async run() {
    try {
      await connectToMongoDB();
      
      const activeUsers = await getAllActiveUsers();
      if (activeUsers.length === 0) {
        console.log('❌ No active users found');
        return;
      }

      console.log(`Found ${activeUsers.length} active users. Using: ${activeUsers[0].email}\n`);
      
      const user = activeUsers[0];
      
      // Refresh tokens if needed
      const refreshedTokens = await this.googleAuth.refreshTokenIfNeeded(user.google_tokens);
      if (refreshedTokens) {
        user.google_tokens = { ...user.google_tokens, ...refreshedTokens };
      }

      const result = await this.fetchAndFilterMessages(user);
      
      console.log('\n🎉 Message filtering completed!');
      console.log(`📊 Results: ${result.matchingMessages} matches out of ${result.totalMessages} total messages`);
      
    } catch (error) {
      console.error('❌ Script failed:', error.message);
    } finally {
      await mongoose.disconnect();
      console.log('\n🔌 Database connection closed');
    }
  }
}

// Run script if executed directly
if (require.main === module) {
  const filter = new DSUMessageFilter();
  filter.run();
}

module.exports = DSUMessageFilter;
