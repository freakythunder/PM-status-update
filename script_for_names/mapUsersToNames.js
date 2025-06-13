require('dotenv').config();
const winston = require('winston');
const { google } = require('googleapis');
const GoogleAuthManager = require('../utils/googleAuth');
const { connectToMongoDB, getAllActiveUsers } = require('../utils/mongodb');
const fs = require('fs').promises;
const path = require('path');

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class UserNameMapper {
  constructor() {
    this.googleAuth = new GoogleAuthManager();
    this.userMap = new Map(); // userId -> { name, email, status }
    this.processedSpaces = 0;
    this.totalMembers = 0;
    this.uniqueUsers = new Set();
    logger.info('🗺️ User Name Mapper initialized');
  }

  async mapAllUsersToNames() {
    try {
      logger.info('🚀 Starting user mapping process...');
      
      // Get user from database
      const users = await getAllActiveUsers();
      if (users.length === 0) {
        logger.error('❌ No active users found in database');
        return;
      }

      const user = users[0];
      logger.info(`👤 Using credentials for: ${user.email}`);

      // Refresh tokens if needed
      const refreshedTokens = await this.googleAuth.refreshTokenIfNeeded(user.google_tokens);
      
      // Create Chat client
      const chatClient = this.googleAuth.createChatClient(refreshedTokens);
      
      logger.info('📋 Starting comprehensive user mapping...');
      
      // Step 1: Fetch all spaces
      const allSpaces = await this.fetchAllSpaces(chatClient);
      
      // Step 2: Fetch all members from all spaces
      await this.fetchAllMembers(chatClient, allSpaces);
      
      // Step 3: Resolve names using People API
      await this.resolveUserNames(refreshedTokens);
      
      // Step 4: Save to JSON file
      await this.saveToJsonFile();
      
      // Step 5: Print summary
      this.printSummary();
      
    } catch (error) {
      logger.error('❌ Error during user mapping:', error);
    }
  }

  async fetchAllSpaces(chatClient) {
    try {
      logger.info('📝 Fetching all spaces...');
      
      let allSpaces = [];
      let nextPageToken = null;
      let pageCount = 0;
      
      do {
        pageCount++;
        logger.info(`📄 Fetching spaces page ${pageCount}...`);
        
        const spacesResponse = await chatClient.spaces.list({
          pageSize: 100,
          pageToken: nextPageToken
        });
        
        if (spacesResponse.data.spaces) {
          allSpaces = allSpaces.concat(spacesResponse.data.spaces);
          logger.info(`   Found ${spacesResponse.data.spaces.length} spaces on page ${pageCount}`);
        }
        
        nextPageToken = spacesResponse.data.nextPageToken;
      } while (nextPageToken);
      
      logger.info(`✅ Total spaces found: ${allSpaces.length}`);
      return allSpaces;
      
    } catch (error) {
      logger.error('❌ Error fetching spaces:', error);
      return [];
    }
  }

  async fetchAllMembers(chatClient, spaces) {
    try {
      logger.info(`👥 Fetching members from ${spaces.length} spaces...`);
      
      for (const [index, space] of spaces.entries()) {
        logger.info(`📍 Processing space ${index + 1}/${spaces.length}: ${space.displayName || space.name}`);
        
        try {
          let allMembers = [];
          let nextPageToken = null;
          
          do {
            const membersResponse = await chatClient.spaces.members.list({
              parent: space.name,
              pageSize: 100,
              pageToken: nextPageToken,
              filter: 'member.type = "HUMAN"' // Only human members
            });
            
            if (membersResponse.data.memberships) {
              allMembers = allMembers.concat(membersResponse.data.memberships);
            }
            
            nextPageToken = membersResponse.data.nextPageToken;
          } while (nextPageToken);
          
          // Process members from this space
          allMembers.forEach(membership => {
            if (membership.member?.name && membership.member.type === 'HUMAN') {
              const userId = membership.member.name;
              this.uniqueUsers.add(userId);
              this.totalMembers++;
              
              // Initialize user entry if not exists
              if (!this.userMap.has(userId)) {
                this.userMap.set(userId, {
                  name: null,
                  email: null,
                  status: 'pending',
                  spaces: []
                });
              }
              
              // Add space info
              const userEntry = this.userMap.get(userId);
              userEntry.spaces.push({
                spaceName: space.name,
                spaceDisplayName: space.displayName || 'No display name',
                role: membership.role,
                state: membership.state
              });
            }
          });
          
          this.processedSpaces++;
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 50));
          
        } catch (error) {
          logger.error(`❌ Error fetching members for space ${space.name}: ${error.message}`);
        }
      }
      
      logger.info(`✅ Found ${this.uniqueUsers.size} unique users across ${this.processedSpaces} spaces`);
      
    } catch (error) {
      logger.error('❌ Error fetching members:', error);
    }
  }

  async resolveUserNames(tokens) {
    try {
      logger.info(`🔍 Resolving names for ${this.uniqueUsers.size} unique users...`);
      
      let resolvedCount = 0;
      let failedCount = 0;
      
      for (const userId of this.uniqueUsers) {
        try {
          logger.info(`📞 Fetching details for user: ${userId}`);
          
          const userDetails = await this.googleAuth.fetchUserDetails(tokens, userId);
          const userEntry = this.userMap.get(userId);
          
          // Extract name
          if (userDetails.names && userDetails.names.length > 0) {
            userEntry.name = userDetails.names[0].displayName || 'No display name';
          }
          
          // Extract email
          if (userDetails.emailAddresses && userDetails.emailAddresses.length > 0) {
            userEntry.email = userDetails.emailAddresses[0].value || 'No email';
          }
          
          // Extract additional info
          if (userDetails.organizations && userDetails.organizations.length > 0) {
            userEntry.organization = userDetails.organizations[0].name;
          }
          
          userEntry.status = 'resolved';
          resolvedCount++;
          
          logger.info(`✅ Resolved: ${userEntry.name} (${userEntry.email})`);
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (error) {
          logger.error(`❌ Failed to resolve user ${userId}: ${error.message}`);
          
          const userEntry = this.userMap.get(userId);
          userEntry.status = 'failed';
          userEntry.error = error.message;
          failedCount++;
        }
      }
      
      logger.info(`✅ Name resolution complete: ${resolvedCount} resolved, ${failedCount} failed`);
      
    } catch (error) {
      logger.error('❌ Error resolving user names:', error);
    }
  }

  async saveToJsonFile() {
    try {
      logger.info('💾 Saving results to JSON file...');
      
      // Convert Map to Object for JSON serialization
      const userObject = {};
      
      for (const [userId, userInfo] of this.userMap.entries()) {
        userObject[userId] = {
          name: userInfo.name || 'NAME_NOT_FOUND',
          email: userInfo.email || 'EMAIL_NOT_FOUND',
          organization: userInfo.organization || null,
          status: userInfo.status,
          error: userInfo.error || null,
          totalSpaces: userInfo.spaces.length,
          spaces: userInfo.spaces
        };
      }
      
      // Create the final JSON structure
      const finalData = {
        metadata: {
          totalUsers: this.uniqueUsers.size,
          totalSpaces: this.processedSpaces,
          generatedAt: new Date().toISOString(),
          resolvedUsers: Array.from(this.userMap.values()).filter(u => u.status === 'resolved').length,
          failedUsers: Array.from(this.userMap.values()).filter(u => u.status === 'failed').length
        },
        users: userObject
      };
      
      // Save to file
      const filePath = path.join(__dirname, 'user_name_mapping.json');
      await fs.writeFile(filePath, JSON.stringify(finalData, null, 2), 'utf8');
      
      logger.info(`✅ Results saved to: ${filePath}`);
      
      // Also save a simplified version for easy editing
      const simplifiedData = {};
      for (const [userId, userInfo] of this.userMap.entries()) {
        simplifiedData[userId] = userInfo.name || 'FILL_NAME_HERE';
      }
      
      const simplifiedPath = path.join(__dirname, 'user_name_mapping_simple.json');
      await fs.writeFile(simplifiedPath, JSON.stringify(simplifiedData, null, 2), 'utf8');
      
      logger.info(`✅ Simplified mapping saved to: ${simplifiedPath}`);
      
    } catch (error) {
      logger.error('❌ Error saving to JSON file:', error);
    }
  }

  printSummary() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 USER MAPPING SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total spaces processed: ${this.processedSpaces}`);
    console.log(`Total member entries found: ${this.totalMembers}`);
    console.log(`Unique users discovered: ${this.uniqueUsers.size}`);
    
    const resolved = Array.from(this.userMap.values()).filter(u => u.status === 'resolved').length;
    const failed = Array.from(this.userMap.values()).filter(u => u.status === 'failed').length;
    
    console.log(`Names successfully resolved: ${resolved}`);
    console.log(`Names failed to resolve: ${failed}`);
    console.log(`Success rate: ${((resolved / this.uniqueUsers.size) * 100).toFixed(1)}%`);
    
    console.log('\n📁 Files created:');
    console.log('  - user_name_mapping.json (detailed data)');
    console.log('  - user_name_mapping_simple.json (simple ID->name mapping)');
    
    if (failed > 0) {
      console.log('\n⚠️  Some names could not be resolved. Check the JSON files for entries marked as "FILL_NAME_HERE" or "NAME_NOT_FOUND"');
    }
  }
}

// Run the mapping
async function runMapping() {
  await connectToMongoDB();
  
  const mapper = new UserNameMapper();
  await mapper.mapAllUsersToNames();
  
  console.log('\n✅ USER MAPPING COMPLETED');
  process.exit(0);
}

// Run if called directly
if (require.main === module) {
  runMapping().catch(error => {
    console.error('❌ Mapping failed:', error);
    process.exit(1);
  });
}

module.exports = UserNameMapper;
