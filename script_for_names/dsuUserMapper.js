require('dotenv').config();
const fs = require('fs');
const path = require('path');
const GoogleAuthManager = require('../utils/googleAuth');
const { connectToMongoDB, getAllActiveUsers, mongoose } = require('../utils/mongodb');

class DSUUserMapper {
  constructor() {
    this.googleAuth = new GoogleAuthManager();
    this.userMappings = new Map();
    this.outputFilePath = path.join(__dirname, 'dsu_user_mappings.json');
  }

  async findDSUSpace(chatClient) {
    console.log('🔍 Finding DSU implementation space...');
    
    const spacesResponse = await this.googleAuth.executeWithRetry(async () => {
      return await chatClient.spaces.list({ pageSize: 100 });
    });

    const spaces = spacesResponse.data.spaces || [];
    const dsuSpace = spaces.find(space => {
      const name = (space.displayName || '').toLowerCase();
      return name.includes('dsu') && name.includes('implementation');
    });

    if (!dsuSpace) {
      throw new Error('DSU Implementation space not found');
    }

    console.log(`✅ Found DSU space: ${dsuSpace.displayName} (${dsuSpace.name})`);
    return dsuSpace;
  }

  extractUserMentions(message) {
    if (!message.annotations || !message.argumentText || !message.formattedText) {
      return [];
    }

    const userMentions = message.annotations.filter(ann => ann.type === 'USER_MENTION');
    if (userMentions.length === 0) {
      return [];
    }

    console.log(`\n🔍 Processing message with ${userMentions.length} user mentions:`);
    console.log(`📝 ArgumentText: ${message.argumentText}`);
    console.log(`🏷️  FormattedText: ${message.formattedText}`);

    const mappings = [];
    const argumentText = message.argumentText;
    const formattedText = message.formattedText;
    
    // Find all user IDs in formattedText
    const userIdRegex = /<users\/(\d+)>/g;
    const userIds = [];
    let match;
    while ((match = userIdRegex.exec(formattedText)) !== null) {
      userIds.push({
        fullPattern: match[0],
        userId: `users/${match[1]}`,
        startIndex: match.index,
        endIndex: match.index + match[0].length
      });
    }

    console.log(`🆔 Found ${userIds.length} user IDs:`, userIds.map(u => u.userId));

    // PRIMARY METHOD: Use word-by-word deletion technique
    console.log(`🔍 Using word deletion method as primary approach`);
    const wordDeletionMappings = this.extractFullNamesAlternative(argumentText, formattedText, userIds);
    if (wordDeletionMappings.length > 0) {
      console.log(`✅ Word deletion method found ${wordDeletionMappings.length} mappings`);
      mappings.push(...wordDeletionMappings);
    }

    // FALLBACK 1: Perfect text replacement matching
    if (mappings.length === 0) {
      console.log(`⚠️ Fallback 1: Trying perfect text replacement matching`);
      
      // Find all @mentions in argumentText with their positions
      const mentionRegex = /@([^@\n]+?)(?=\s|$|-|,|\.|\n|!|\?)/g;
      const mentions = [];
      while ((match = mentionRegex.exec(argumentText)) !== null) {
        mentions.push({
          fullMention: match[0],
          name: match[1].trim(),
          startIndex: match.index,
          endIndex: match.index + match[0].length
        });
      }

      // Match mentions to user IDs by simulating text replacement
      for (const mention of mentions) {
        for (const userIdInfo of userIds) {
          const testText = argumentText.substring(0, mention.startIndex) +
                          userIdInfo.fullPattern +
                          argumentText.substring(mention.endIndex);
          
          if (testText === formattedText) {
            mappings.push({ 
              username: mention.name, 
              userId: userIdInfo.userId 
            });
            console.log(`✅ Perfect match: "${mention.name}" -> ${userIdInfo.userId}`);
            break;
          }
        }
      }
    }

    // FALLBACK 2: Positional matching
    if (mappings.length === 0) {
      console.log(`⚠️ Fallback 2: Trying positional matching`);
      
      const mentionRegex = /@([^@\n]+?)(?=\s|$|-|,|\.|\n|!|\?)/g;
      const mentions = [];
      while ((match = mentionRegex.exec(argumentText)) !== null) {
        mentions.push({
          name: match[1].trim()
        });
      }

      if (mentions.length === userIds.length) {
        for (let i = 0; i < mentions.length; i++) {
          mappings.push({
            username: mentions[i].name,
            userId: userIds[i].userId
          });
          console.log(`✅ Positional match: "${mentions[i].name}" -> ${userIds[i].userId}`);
        }
      }
    }

    // FALLBACK 3: Old regex method
    if (mappings.length === 0) {
      console.log(`⚠️ Fallback 3: Using old regex method`);
      
      const mentionRegex = /@([^@\n]+?)(?=\s|$|@)/g;
      const argumentMentions = [];
      let match;
      while ((match = mentionRegex.exec(message.argumentText)) !== null) {
        argumentMentions.push(match[1].trim());
      }

      const userIdRegex = /<users\/(\d+)>/g;
      const formattedUserIds = [];
      while ((match = userIdRegex.exec(message.formattedText)) !== null) {
        formattedUserIds.push(match[1]);
      }

      console.log(`📋 Found mentions: [${argumentMentions.join(', ')}]`);
      console.log(`🆔 Found user IDs: [${formattedUserIds.join(', ')}]`);

      // Map mentions to user IDs (same order assumption)
      const minLength = Math.min(argumentMentions.length, formattedUserIds.length);
      for (let i = 0; i < minLength; i++) {
        const username = argumentMentions[i];
        const userId = `users/${formattedUserIds[i]}`;
        mappings.push({ username, userId });
        console.log(`✅ Fallback mapped: "${username}" -> ${userId}`);
      }
    }

    if (mappings.length !== userIds.length) {
      console.warn(`⚠️ Mapping mismatch: Found ${userIds.length} user IDs but mapped ${mappings.length} names`);
    }

    return mappings;
  }

  extractFullNamesAlternative(argumentText, formattedText, userIds) {
    console.log(`🔍 Using word-by-word deletion method`);
    
    try {
      // Clone the texts for processing
      let processedArgText = argumentText;
      let processedFormText = formattedText;
      
      // Replace all user IDs with placeholders in formatted text
      userIds.forEach(userIdInfo => {
        processedFormText = processedFormText.replace(userIdInfo.fullPattern, '<>');
      });
      
      console.log(`📝 Formatted text with placeholders: ${processedFormText}`);
      console.log(`📝 Original argument text: ${processedArgText}`);
      
      // Split both texts into words
      const argWords = processedArgText.split(/\s+/);
      const formWords = processedFormText.split(/\s+/);
      
      console.log(`📊 Starting with ${argWords.length} arg words and ${formWords.length} form words`);
      
      // Remove common words from both texts word by word
      let i = 0;
      while (i < formWords.length) {
        const formWord = formWords[i].replace(/[.,!?;:(){}[\]<>]/g, '');
        
        if (formWord === '' || formWord === '<>') {
          // Skip empty words and placeholders
          i++;
          continue;
        }
        
        // Find and remove this word from argument text if it exists
        const argIndex = argWords.findIndex(w => 
          w.replace(/[.,!?;:(){}[\]<>]/g, '') === formWord);
        
        if (argIndex !== -1) {
          console.log(`🗑️ Removing word: "${formWord}"`);
          argWords.splice(argIndex, 1);
          formWords.splice(i, 1);
          // Don't increment i since we removed an element
        } else {
          i++;
        }
      }
      
      // What's left in argWords should be @mentions
      const remainingText = argWords.join(' ');
      console.log(`📝 Remaining text after word deletion: ${remainingText}`);
      
      // Improved mention extraction from remaining text
      const remainingMentions = [];
      
      // Split by @ symbol and process each segment
      const segments = remainingText.split('@').filter(s => s.trim() !== '');
      
      segments.forEach(segment => {
        // Clean the segment by removing trailing punctuation
        let cleanedName = segment.trim();
        
        // Remove trailing commas, periods, etc.
        cleanedName = cleanedName.replace(/[,\.;:!?]+$/, '').trim();
        
        // If there's another @ in the segment, only take text up to that point
        const nextAtIndex = cleanedName.indexOf('@');
        if (nextAtIndex !== -1) {
          cleanedName = cleanedName.substring(0, nextAtIndex).trim();
        }
        
        // Check if we have a valid name
        if (cleanedName) {
          remainingMentions.push({
            fullMention: '@' + cleanedName,
            name: cleanedName
          });
        }
      });
      
      console.log(`📊 Found ${remainingMentions.length} mentions from remaining text`);
      remainingMentions.forEach(m => console.log(`   - "${m.name}"`));
      
      // Map mentions to user IDs in order
      const mappings = [];
      if (remainingMentions.length === userIds.length) {
        for (let i = 0; i < remainingMentions.length; i++) {
          mappings.push({
            username: remainingMentions[i].name,
            userId: userIds[i].userId
          });
          console.log(`✅ Word-deletion mapped: "${remainingMentions[i].name}" -> ${userIds[i].userId}`);
        }
      } else {
        console.log(`⚠️ Mention count (${remainingMentions.length}) doesn't match user ID count (${userIds.length})`);
      }
      
      return mappings;
    } catch (error) {
      console.error('❌ Error in word deletion method:', error.message);
      return [];
    }
  }

  async fetchAndMapUsers(user) {
    try {
      console.log(`🚀 Starting user mapping for: ${user.email}\n`);
      
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

      // Filter messages with user mentions
      const mentionMessages = allMessages.filter(msg => 
        msg.annotations && 
        msg.annotations.some(ann => ann.type === 'USER_MENTION')
      );

      console.log(`🎯 Messages with user mentions: ${mentionMessages.length}`);

      // Process each message for user mappings
      let totalMappings = 0;
      mentionMessages.forEach((message, index) => {
        console.log(`\n--- Processing Message ${index + 1}/${mentionMessages.length} ---`);
        const mappings = this.extractUserMentions(message);
        
        mappings.forEach(({ username, userId }) => {
          if (!this.userMappings.has(userId)) {
            this.userMappings.set(userId, username);
            totalMappings++;
          }
        });
      });

      console.log(`\n📊 Total unique mappings discovered: ${totalMappings}`);
      console.log('🗂️ Discovered mappings:');
      
      this.userMappings.forEach((username, userId) => {
        console.log(`   ${userId} -> "${username}"`);
      });

      return this.updateMappingFile();

    } catch (error) {
      console.error('❌ Error in mapping process:', error.message);
      throw error;
    }
  }

  updateMappingFile() {
    console.log('\n📝 Creating new DSU user mapping file...');
    
    if (this.userMappings.size === 0) {
      console.log('ℹ️  No user mappings found to save');
      return { savedCount: 0, totalMappings: 0 };
    }

    // Create new mapping structure
    const newMapping = {
      metadata: {
        source: "DSU Implementation Space",
        generatedAt: new Date().toISOString(),
        totalMappings: this.userMappings.size,
        extractionMethod: "user_mentions_analysis"
      },
      userMappings: {}
    };

    // Convert Map to object
    this.userMappings.forEach((username, userId) => {
      newMapping.userMappings[userId] = {
        name: username,
        discoveredAt: new Date().toISOString(),
        source: "DSU_MENTIONS"
      };
    });

    // Save new mapping file
    try {
      fs.writeFileSync(this.outputFilePath, JSON.stringify(newMapping, null, 2));
      console.log(`✅ Successfully created DSU user mapping file: ${this.outputFilePath}`);
      console.log(`📊 Saved ${this.userMappings.size} user mappings`);
      
      // Display mappings
      console.log('\n🗂️ User Mappings Created:');
      this.userMappings.forEach((username, userId) => {
        console.log(`   ${userId} -> "${username}"`);
      });
      
    } catch (error) {
      console.error('❌ Failed to save mapping file:', error.message);
      throw error;
    }

    return { savedCount: this.userMappings.size, totalMappings: this.userMappings.size };
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

      const result = await this.fetchAndMapUsers(user);
      
      console.log('\n🎉 DSU User mapping completed!');
      console.log(`📊 Summary: ${result.savedCount} user mappings saved to new file`);
      console.log(`📁 Output file: ${this.outputFilePath}`);
      
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
  const mapper = new DSUUserMapper();
  mapper.run();
}

module.exports = DSUUserMapper;
