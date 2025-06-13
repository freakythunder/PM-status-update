require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');
const GoogleAuthManager = require('../utils/googleAuth');
const { connectToMongoDB, getAllActiveUsers } = require('../utils/mongodb');

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

class DSUMembersFinder {
  constructor() {
    this.googleAuth = new GoogleAuthManager();
    this.userMappings = null;
  }

  async loadUserMappings() {
    try {
      const mappingPath = path.join(__dirname, 'user_name_mapping_simple.json');
      const data = await fs.readFile(mappingPath, 'utf8');
      this.userMappings = JSON.parse(data);
      logger.info(`✅ Loaded ${Object.keys(this.userMappings).length} user mappings`);
    } catch (error) {
      logger.error('❌ Error loading user mappings:', error.message);
      throw error;
    }
  }

  async findDSUSpace(chatClient) {
    try {
      logger.info('🔍 Searching for DSU Implementation space...');
      
      let allSpaces = [];
      let nextPageToken = null;
      
      do {
        const spacesResponse = await chatClient.spaces.list({
          pageSize: 100,
          pageToken: nextPageToken
        });
        
        if (spacesResponse.data.spaces) {
          allSpaces = allSpaces.concat(spacesResponse.data.spaces);
        }
        
        nextPageToken = spacesResponse.data.nextPageToken;
      } while (nextPageToken);
      
      // Find DSU implementation space
      const dsuSpace = allSpaces.find(space => {
        const name = (space.displayName || space.name || '').toLowerCase();
        return name.includes('climaty.ai')          
      });
      
      if (dsuSpace) {
        logger.info(`✅ Found DSU space: ${dsuSpace.displayName || dsuSpace.name}`);
        return dsuSpace;
      } else {
        logger.error('❌ DSU Implementation space not found');
        return null;
      }
      
    } catch (error) {
      logger.error('❌ Error finding DSU space:', error.message);
      throw error;
    }
  }

  async fetchDSUMembers(chatClient, dsuSpace) {
    try {
      logger.info('👥 Fetching all members from DSU space...');
      
      let allMembers = [];
      let nextPageToken = null;
      
      do {
        const membersResponse = await chatClient.spaces.members.list({
          parent: dsuSpace.name,
          pageSize: 100,
          pageToken: nextPageToken
        });
        
        if (membersResponse.data.memberships) {
          allMembers = allMembers.concat(membersResponse.data.memberships);
        }
        
        nextPageToken = membersResponse.data.nextPageToken;
      } while (nextPageToken);
      
      // Filter for human members only
      const humanMembers = allMembers.filter(member => 
        member.member?.type === 'HUMAN' && 
        member.member?.name &&
        member.state === 'JOINED'
      );
      
      logger.info(`✅ Found ${humanMembers.length} human members in DSU space`);
      return humanMembers;
      
    } catch (error) {
      logger.error('❌ Error fetching DSU members:', error.message);
      throw error;
    }
  }

  async displayMembersWithNames() {
    try {
      await this.loadUserMappings();
      
      // Get authenticated user and create chat client
      const users = await getAllActiveUsers();
      if (users.length === 0) {
        logger.error('❌ No active users found in database');
        return;
      }

      const user = users[0];
      const refreshedTokens = await this.googleAuth.refreshTokenIfNeeded(user.google_tokens);
      const chatClient = this.googleAuth.createChatClient(refreshedTokens);

      // Find DSU space
      const dsuSpace = await this.findDSUSpace(chatClient);
      if (!dsuSpace) {
        return;
      }

      // Fetch DSU members
      const members = await this.fetchDSUMembers(chatClient, dsuSpace);
      if (members.length === 0) {
        logger.info('❌ No members found in DSU space');
        return;
      }

      // Display results
      console.log('\n' + '='.repeat(100));
      console.log('👥 DSU IMPLEMENTATION SPACE MEMBERS');
      console.log('='.repeat(100));
      console.log(`Space: ${dsuSpace.displayName || dsuSpace.name}`);
      console.log(`Total Members: ${members.length}`);
      console.log('='.repeat(100));

      let foundInMapping = 0;
      let notFoundInMapping = 0;

      members.forEach((member, index) => {
        const userId = member.member.name;
        const userName = this.userMappings[userId];
        
        console.log(`\n${index + 1}. User ID: ${userId}`);
        
        if (userName && userName !== 'FILL_NAME_HERE') {
          console.log(`   Name: ${userName}`);
          foundInMapping++;
        } else if (userName === 'FILL_NAME_HERE') {
          console.log(`   Name: FILL_NAME_HERE (needs to be filled)`);
          notFoundInMapping++;
        } else {
          console.log(`   Name: ❌ NOT FOUND IN MAPPING FILE`);
          notFoundInMapping++;
        }
        
        console.log(`   Role: ${member.role || 'Unknown'}`);
        console.log(`   State: ${member.state || 'Unknown'}`);
        console.log(`   Join Time: ${member.createTime || 'Unknown'}`);
      });

      // Summary
      console.log('\n' + '='.repeat(100));
      console.log('📊 SUMMARY');
      console.log('='.repeat(100));
      console.log(`Total members found: ${members.length}`);
      console.log(`Names found in mapping: ${foundInMapping}`);
      console.log(`Names missing/unfilled: ${notFoundInMapping}`);
      
      if (notFoundInMapping > 0) {
        console.log('\n💡 Members with missing names:');
        members.forEach((member, index) => {
          const userId = member.member.name;
          const userName = this.userMappings[userId];
          
          if (!userName || userName === 'FILL_NAME_HERE') {
            console.log(`   ${userId} - ${userName || 'NOT IN MAPPING FILE'}`);
          }
        });
      }

    } catch (error) {
      logger.error('❌ Error in DSU members finder:', error.message);
    }
  }
}

// Run the script if executed directly
async function runScript() {
  try {
    await connectToMongoDB();
    const finder = new DSUMembersFinder();
    await finder.displayMembersWithNames();
    console.log('\n✅ DSU Members Finder completed');
  } catch (error) {
    console.error('❌ Script failed:', error.message);
  } finally {
    process.exit(0);
  }
}

if (require.main === module) {
  runScript();
}

module.exports = DSUMembersFinder;
