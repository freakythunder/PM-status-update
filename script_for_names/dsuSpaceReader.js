require('dotenv').config();
const {
  connectToMongoDB,
  ChatMessage,
  User,
  mongoose
} = require('../utils/mongodb');

class DSUSpaceReader {
  async findDSUSpace() {
    await connectToMongoDB();
    
    // Find spaces that contain "DSU" or "implementation" in their name
    const dsuMessages = await ChatMessage.find({
      $or: [
        { space_name: { $regex: /dsu/i } },
        { space_name: { $regex: /implementation/i } },
        { space_name: { $regex: /daily.*standup/i } },
        { space_name: { $regex: /standup/i } }
      ]
    }).limit(1);

    if (dsuMessages.length === 0) {
      console.log('❌ No DSU implementation space found');
      return null;
    }

    return dsuMessages[0].space_id;
  }

  async fetchDSUMessages(spaceId = null, limit = 50) {
    await connectToMongoDB();
    
    let query = {};
    
    if (spaceId) {
      query.space_id = spaceId;
    } else {
      // If no specific space ID, search by space name patterns
      query = {
        $or: [
          { space_name: { $regex: /dsu/i } },
          { space_name: { $regex: /implementation/i } },
          { space_name: { $regex: /daily.*standup/i } },
          { space_name: { $regex: /standup/i } }
        ]
      };
    }

    const messages = await ChatMessage.find(query)
      .sort({ message_time: 1 }) // Oldest first for chronological order
      .limit(limit)
      .populate('user_id', 'email name');

    return messages;
  }

  formatMessage(message, index) {
    const timestamp = message.message_time.toLocaleString();
    const sender = message.sender_name || 'Unknown';
    const content = message.content.substring(0, 200); // Truncate long messages
    
    return `
${index + 1}. [${timestamp}] ${sender}
   Space: ${message.space_name}
   Message: ${content}${content.length >= 200 ? '...' : ''}
   Thread: ${message.is_threaded ? 'Yes' : 'No'}
${'─'.repeat(80)}`;
  }

  async displayDSUMessages() {
    try {
      console.log('🔍 Searching for DSU implementation space...\n');
      
      const spaceId = await this.findDSUSpace();
      const messages = await this.fetchDSUMessages(spaceId, 50);
      
      if (messages.length === 0) {
        console.log('❌ No messages found in DSU implementation space');
        return;
      }

      console.log(`✅ Found ${messages.length} messages from DSU implementation space\n`);
      console.log('='.repeat(100));
      console.log('DSU IMPLEMENTATION SPACE MESSAGES');
      console.log('='.repeat(100));

      messages.forEach((message, index) => {
        console.log(this.formatMessage(message, index));
      });

      console.log(`\n📊 Summary: Displayed ${messages.length} messages from DSU implementation space`);
      
    } catch (error) {
      console.error('❌ Error fetching DSU messages:', error.message);
    } finally {
      await mongoose.disconnect();
      console.log('🔌 Database connection closed');
    }
  }
}

// Run the script if executed directly
if (require.main === module) {
  const reader = new DSUSpaceReader();
  reader.displayDSUMessages();
}

module.exports = DSUSpaceReader;
