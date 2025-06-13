const { getChatMessagesBySpace } = require('./utils/mongodb');

// Format messages for LLM consumption
function formatMessagesForLLM(messages) {
  const currentTime = new Date();

  return messages.map(msg => {
    const messageTime = new Date(msg.message_time);
    // Calculate time difference in minutes
    const timeDiffMinutes = Math.floor((currentTime - messageTime) / (1000 * 60));

    return {
      senderName: msg.sender_name,
      content: msg.content || '',
      localTime:formatLocalTime(msg.message_time),
      timePassedMinutes: timeDiffMinutes
    };
  });
}

// Convert UTC time to local time string
function formatLocalTime(utcTime) {
  if (!utcTime) return 'Unknown time';
  
  const date = new Date(utcTime);
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', // IST timezone for India
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

async function testChatMessages() {
  try {
    // Replace 'your-space-id-here' with an actual space ID from your database
    const spaceId = 'spaces/kHt0N8AAAAE';
    const limit = 5; // Optional: adjust the number of messages to fetch
    
    console.log(`🔍 Fetching chat messages for space: ${spaceId}`);
    console.log(`📊 Limit: ${limit} messages\n`);
    
    const messages = await getChatMessagesBySpace(spaceId, limit);
    
    console.log(`✅ Found ${messages.length} messages:`);
    console.log('═'.repeat(80));
    
    if (messages.length === 0) {
      console.log('📭 No messages found for this space ID');
    } else {
      const formattedMessages = formatMessagesForLLM(messages);
      console.log('📝 Formatted Messages:');
      console.log(JSON.stringify(formattedMessages, null, 2));
    }
    
    console.log('═'.repeat(80));
    console.log('🏁 Script completed successfully');
    
  } catch (error) {
    console.error('❌ Error fetching chat messages:', error.message);
    console.error('Stack trace:', error.stack);
  } finally {
    // Exit the process since we're using mongoose connection
    process.exit(0);
  }
}

// Run the test
testChatMessages();


