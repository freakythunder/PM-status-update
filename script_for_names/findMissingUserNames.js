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

class MissingUserNameFinder {
  constructor() {
    this.googleAuth = new GoogleAuthManager();
    this.missingUsers = []; // To store users with missing names
    this.userNameMap = {}; // Will hold data from user_name_mapping_simple.json
    logger.info('🔍 Missing User Name Finder initialized');
  }

  async findMissingUserNames() {
    try {
      logger.info('🚀 Starting process to find users with missing names...');
      
      // Load the user name mapping file
      await this.loadUserNameMapping();
      
      // Get user from database for auth
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
      
      // Step 1: Fetch all direct message spaces
      const directMessageSpaces = await this.fetchDirectMessageSpaces(chatClient);
      
      // Step 2: Fetch members from each space and check against mapping
      await this.checkMembersAgainstMapping(chatClient, directMessageSpaces);
      
      // Step 3: Print results
      this.displayResults();
      
    } catch (error) {
      logger.error('❌ Error during process:', error);
    }
  }

  async loadUserNameMapping() {
    try {
      logger.info('📖 Loading user name mapping file...');
      
      const filePath = path.join(__dirname, '.', 'user_name_mapping_simple.json');
      const fileData = await fs.readFile(filePath, 'utf8');
      this.userNameMap = JSON.parse(fileData);
      
      logger.info(`✅ Loaded mapping file with ${Object.keys(this.userNameMap).length} user entries`);
    } catch (error) {
      logger.error('❌ Error loading user name mapping file:', error);
      throw error;
    }
  }

  async fetchDirectMessageSpaces(chatClient) {
    try {
      logger.info('📝 Fetching direct message spaces...');
      
      let directMessageSpaces = [];
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
          // Filter for direct message spaces
          const dmSpaces = spacesResponse.data.spaces.filter(
            space => space.spaceType === 'DIRECT_MESSAGE'
          );
          
          directMessageSpaces = directMessageSpaces.concat(dmSpaces);
          logger.info(`   Found ${dmSpaces.length} direct message spaces on page ${pageCount}`);
        }
        
        nextPageToken = spacesResponse.data.nextPageToken;
      } while (nextPageToken);
      
      logger.info(`✅ Total direct message spaces found: ${directMessageSpaces.length}`);
      return directMessageSpaces;
      
    } catch (error) {
      logger.error('❌ Error fetching direct message spaces:', error);
      return [];
    }
  }

  async checkMembersAgainstMapping(chatClient, spaces) {
    try {
      logger.info(`👥 Checking members from ${spaces.length} direct message spaces...`);
      
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
          
          // Check each member against the mapping
          allMembers.forEach(membership => {
            if (membership.member?.name && membership.member.type === 'HUMAN') {
              const userId = membership.member.name;
              
              // Check if user exists in mapping and if their name is "FILL_NAME_HERE"
              if (this.userNameMap[userId] === 'FILL_NAME_HERE') {
                this.missingUsers.push({
                  userId: userId,
                  spaceId: space.name,
                  spaceDisplayName: space.displayName || 'No display name'
                });
                
                logger.info(`⚠️ Found user with missing name: ${userId} in space: ${space.name}`);
              }
            }
          });
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 50));
          
        } catch (error) {
          logger.error(`❌ Error checking members for space ${space.name}: ${error.message}`);
        }
      }
      
      logger.info(`✅ Found ${this.missingUsers.length} users with missing names`);
      
    } catch (error) {
      logger.error('❌ Error checking members:', error);
    }
  }

  displayResults() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 MISSING USER NAMES SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total users with missing names: ${this.missingUsers.length}`);
    
    if (this.missingUsers.length > 0) {
      console.log('\nList of users with missing names:');
      console.log('-'.repeat(80));
      console.log('| User ID                          | Space ID                         |');
      console.log('-'.repeat(80));
      
      this.missingUsers.forEach(user => {
        console.log(`| ${user.userId.padEnd(32)} | ${user.spaceId.padEnd(32)} |`);
      });
      
      console.log('-'.repeat(80));
    } else {
      console.log('\n✅ No users with missing names found!');
    }
    
    console.log('\n✅ PROCESS COMPLETED');
  }
}

// Run the finder
async function runFinder() {
  await connectToMongoDB();
  
  const finder = new MissingUserNameFinder();
  await finder.findMissingUserNames();
  
  process.exit(0);
}

// Run if called directly
if (require.main === module) {
  runFinder().catch(error => {
    console.error('❌ Process failed:', error);
    process.exit(1);
  });
}

module.exports = MissingUserNameFinder;
