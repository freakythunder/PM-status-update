require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');
const { connectToMongoDB, ChatMessage } = require('./utils/mongodb');

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
  transports: [
    new winston.transports.Console()
  ]
});

class SpaceLatestMessageUpdater {
  constructor() {
    this.spacesFilePath = path.join(__dirname, 'spaces_with_space_types.json');
    this.outputFilePath = path.join(__dirname, 'spaces_with_latest_messages.json');
  }

  async loadSpacesData() {
    try {
      logger.info('📂 Loading spaces data from JSON file...');
      const data = await fs.readFile(this.spacesFilePath, 'utf8');
      const spaces = JSON.parse(data);
      logger.info(`✅ Loaded ${spaces.length} spaces from file`);
      return spaces;
    } catch (error) {
      logger.error('❌ Error loading spaces data:', error.message);
      throw error;
    }
  }

  async getLatestMessageTimeForSpace(spaceId) {
    try {
      const latestMessage = await ChatMessage.findOne(
        { space_id: spaceId },
        { message_time: 1 },
        { sort: { message_time: -1 } }
      );
      
      return latestMessage?.message_time || null;
    } catch (error) {
      logger.error(`❌ Error fetching latest message for space ${spaceId}:`, error.message);
      return null;
    }
  }

  async updateSpacesWithLatestMessages() {
    try {
      logger.info('🚀 Starting spaces update with latest message times...');
      
      // Connect to MongoDB
      await connectToMongoDB();
      
      // Load spaces data
      const spaces = await this.loadSpacesData();
      
      // Process each space
      logger.info('🔍 Fetching latest message times for each space...');
      const updatedSpaces = [];
      
      for (let i = 0; i < spaces.length; i++) {
        const space = spaces[i];
        const spaceId = space.space_id;
        
        logger.info(`📊 Processing space ${i + 1}/${spaces.length}: ${space.space_name}`);
        
        // Get latest message time for this space
        const latestMessageTime = await this.getLatestMessageTimeForSpace(spaceId);
        
        // Create updated space object
        const updatedSpace = {
          ...space,
          latest_message_time: latestMessageTime
        };
        
        updatedSpaces.push(updatedSpace);
        
        // Log result
        if (latestMessageTime) {
          logger.info(`  ✅ Latest message: ${latestMessageTime.toISOString()}`);
        } else {
          logger.info(`  ⚠️ No messages found in this space`);
        }
      }
      
      // Save updated data
      logger.info('💾 Saving updated spaces data...');
      await fs.writeFile(
        this.outputFilePath, 
        JSON.stringify(updatedSpaces, null, 2),
        'utf8'
      );
      
      logger.info(`✅ Successfully saved updated data to: ${this.outputFilePath}`);
      
      // Display summary
      this.displaySummary(updatedSpaces);
      
      return updatedSpaces;
      
    } catch (error) {
      logger.error('❌ Error updating spaces with latest messages:', error.message);
      throw error;
    }
  }

  displaySummary(spaces) {
    console.log('\n' + '='.repeat(80));
    console.log('📊 SPACES LATEST MESSAGE SUMMARY');
    console.log('='.repeat(80));
    
    const spacesWithMessages = spaces.filter(space => space.latest_message_time !== null);
    const spacesWithoutMessages = spaces.filter(space => space.latest_message_time === null);
    
    console.log(`Total spaces processed: ${spaces.length}`);
    console.log(`Spaces with messages: ${spacesWithMessages.length}`);
    console.log(`Spaces without messages: ${spacesWithoutMessages.length}`);
    
    if (spacesWithMessages.length > 0) {
      // Find oldest and newest message times
      const sortedSpaces = spacesWithMessages
        .filter(space => space.latest_message_time)
        .sort((a, b) => new Date(a.latest_message_time) - new Date(b.latest_message_time));
      
      if (sortedSpaces.length > 0) {
        const oldestSpace = sortedSpaces[0];
        const newestSpace = sortedSpaces[sortedSpaces.length - 1];
        
        console.log(`\n🕰️ Oldest message: ${oldestSpace.latest_message_time} in "${oldestSpace.space_name}"`);
        console.log(`🆕 Newest message: ${newestSpace.latest_message_time} in "${newestSpace.space_name}"`);
      }
    }
    
    // Show top 5 most recently active spaces
    if (spacesWithMessages.length > 0) {
      console.log('\n🔥 TOP 5 MOST RECENTLY ACTIVE SPACES:');
      console.log('-'.repeat(60));
      
      const mostRecentSpaces = spacesWithMessages
        .filter(space => space.latest_message_time)
        .sort((a, b) => new Date(b.latest_message_time) - new Date(a.latest_message_time))
        .slice(0, 5);
      
      mostRecentSpaces.forEach((space, index) => {
        console.log(`${index + 1}. ${space.space_name}`);
        console.log(`   Latest: ${space.latest_message_time}`);
        console.log(`   Members: ${space.total_members}`);
        console.log(`   Space ID: ${space.space_id}`);
        console.log('');
      });
    }
    
    // Show spaces without messages
    if (spacesWithoutMessages.length > 0) {
      console.log('\n❌ SPACES WITHOUT MESSAGES:');
      console.log('-'.repeat(40));
      
      spacesWithoutMessages.forEach((space, index) => {
        console.log(`${index + 1}. ${space.space_name} (${space.total_members} members)`);
      });
    }
    
    console.log('\n' + '='.repeat(80));
  }

  async validateResults() {
    try {
      logger.info('🔍 Validating results...');
      
      // Check if output file exists
      const data = await fs.readFile(this.outputFilePath, 'utf8');
      const spaces = JSON.parse(data);
      
      // Validate structure
      let validSpaces = 0;
      let spacesWithLatestTime = 0;
      
      for (const space of spaces) {
        if (space.space_id && space.space_name && space.hasOwnProperty('latest_message_time')) {
          validSpaces++;
          if (space.latest_message_time !== null) {
            spacesWithLatestTime++;
          }
        }
      }
      
      logger.info(`✅ Validation complete:`);
      logger.info(`   Valid spaces: ${validSpaces}/${spaces.length}`);
      logger.info(`   Spaces with latest_message_time: ${spacesWithLatestTime}/${spaces.length}`);
      
      return { validSpaces, spacesWithLatestTime, totalSpaces: spaces.length };
      
    } catch (error) {
      logger.error('❌ Validation failed:', error.message);
      throw error;
    }
  }
}

// Command line interface
async function main() {
  try {
    const updater = new SpaceLatestMessageUpdater();
    
    logger.info('🎯 Starting spaces latest message update process...');
    
    // Update spaces with latest message times
    await updater.updateSpacesWithLatestMessages();
    
    // Validate results
    await updater.validateResults();
    
    logger.info('🎉 Script completed successfully!');
    process.exit(0);
    
  } catch (error) {
    logger.error('❌ Script failed:', error.message);
    console.log('\n💡 This script:');
    console.log('   1. Reads spaces from spaces_and_members_updated.json');
    console.log('   2. Queries MongoDB for latest message_time for each space');
    console.log('   3. Adds latest_message_time field to each space');
    console.log('   4. Saves results to spaces_with_latest_messages.json');
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = SpaceLatestMessageUpdater;
