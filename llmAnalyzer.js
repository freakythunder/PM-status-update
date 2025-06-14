require('dotenv').config();
const winston = require('winston');
const fs = require('fs').promises;
const path = require('path');
const { AzureOpenAI } = require('openai');

const {
  connectToMongoDB,
  getAllActiveUsers,
  getChatMessagesBySpace,
  ChatMessage,
  saveLLMAnalysisResults,
  getLatestLLMAnalysisResults
} = require('./utils/mongodb');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
      if (meta && Object.keys(meta).length && !(meta.stack && Object.keys(meta).length === 1)) {
        try {
          log += ` ${JSON.stringify(meta)}`;
        } catch (e) {
          log += " (unable to stringify metadata)";
        }
      }
      return log;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
          if (meta && Object.keys(meta).length && !(meta.stack && Object.keys(meta).length === 1)) {
            const metaString = Object.entries(meta)
              .filter(([key]) => key !== 'stack')
              .map(([key, value]) => `${key}=${value}`)
              .join(', ');
            if (metaString) log += ` (${metaString})`;
          }
          return log;
        })
      )
    }),
    new winston.transports.File({
      filename: 'llm-analyzer.log',
      format: winston.format.json()
    })
  ]
});

class LLMAnalyzer {
  constructor() {
    // Initialize Azure OpenAI client
    this.azureClient = new AzureOpenAI({
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'o4-mini',
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2025-01-01-preview'
    });

    // Aditya's user ID from the previous context exploration
    this.adityaUserId = 'users/116152071271346193304';
    this.outputDir = path.join(__dirname, 'llm-analysis-results');
    this.isRunning = false;
  }

  // Main method to analyze messages for response prediction
  async analyzeMessagesForResponsePrediction() {
    if (this.isRunning) {
      logger.warn('LLM analysis already in progress, skipping this run');
      return;
    }

    this.isRunning = true;
    logger.info('🤖 Starting LLM analysis for response prediction');

    try {
      // Ensure output directory exists
      await this.ensureOutputDirectory();

      // Connect to MongoDB
      await connectToMongoDB();

      // Get all unique spaces where Aditya has messages
      const adityaSpaces = await this.getAdityaSpaces();
      logger.info(`Found ${adityaSpaces.length} spaces where Aditya participates`);

      if (adityaSpaces.length === 0) {
        logger.info('No spaces found for Aditya, skipping analysis');
        return;
      }

      const suggestedResponses = [];

      // Process each space
      for (const space of adityaSpaces) {
        try {
          const spaceResponse = await this.analyzeSpaceMessages(space);
          if (spaceResponse) {
            suggestedResponses.push(spaceResponse);
          }
        } catch (error) {
          logger.error(`Failed to analyze space ${space.space_id}:`, error);
          // Continue with other spaces
        }
      }

      // Save single consolidated file with all suggested responses
      await this.saveSuggestedResponsesFile(suggestedResponses);

      logger.info(`✅ LLM analysis completed successfully. Found ${suggestedResponses.length} responses needed`);

    } catch (error) {
      logger.error('❌ LLM analysis failed:', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }
  // Get all spaces that have new messages
  async getAdityaSpaces() {
    try {
      const jsonFilePath = path.join(__dirname, 'spaces_with_latest_messages.json');
      const jsonData = await fs.readFile(jsonFilePath, 'utf8');
      const spaces = JSON.parse(jsonData);
      
      // Filter for spaces with new messages and return only space_id and space_name
      return spaces
        .map(space => ({
          space_id: space.space_id,
          space_name: space.space_name
        }));
      
    } catch (error) {
      logger.error('Failed to read spaces from JSON file:', error);
      return [];
    }
  }

  // Analyze messages in a specific space
  async analyzeSpaceMessages(space) {
    logger.info(`Analyzing space: ${space.space_name} (${space.space_id})`);

    try {
      // Fetch recent 10 messages from this space
      const messages = await getChatMessagesBySpace(space.space_id, 4);

      if (messages.length === 0) {
        logger.info(`No messages found in space ${space.space_id}, skipping`);
        return null;
      }
      
      // Format messages for LLM analysis (oldest to newest)
      const formattedMessages = this.formatMessagesForLLM(messages.reverse());
      // console.log(JSON.stringify(formattedMessages, null, 2));
      
      // Get LLM prediction
      const llmResponse = await this.getLLMPrediction(formattedMessages, space.space_name);

      // Parse JSON response
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(llmResponse);
      } catch (parseError) {
        logger.error(`Failed to parse LLM JSON response for space ${space.space_id}:`, parseError);
        return null;
      }

      // Return suggested response if needed
      if (parsedResponse.response_needed === true && parsedResponse.suggested_response) {
        return {
          to: space.space_name,
          msg: parsedResponse.suggested_response,
          time_generated: this.formatLocalTime(new Date())
        };
      }

      return null;

    } catch (error) {
      logger.error(`Error analyzing space ${space.space_id}:`, error);
      return null;
    }
  }

  // Format messages into the required JSON structure for LLM
  formatMessagesForLLM(messages) {
    const currentTime = new Date();
    
    return messages.map(msg => {
      const messageTime = new Date(msg.message_time);
      // Calculate time difference in minutes
      const timeDiffMinutes = Math.floor((currentTime - messageTime) / (1000 * 60));
      
      return {
        senderName: msg.sender_name,
        content: msg.content || '',
        localTime: this.formatLocalTime(msg.message_time),
        timePassedMinutes: timeDiffMinutes
      };
    });
  }

  // Convert UTC time to local time string
formatLocalTime(utcTime) {
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

  // Get LLM prediction for response requirement
  async getLLMPrediction(messages, spaceName) {
    const prompt = this.buildAnalysisPrompt(messages, spaceName);

    try {
      const completion = await this.azureClient.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'o4-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an AI assistant that analyzes Google Chat conversations to predict when Aditya needs to respond. You must respond with valid JSON only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_completion_tokens: 1000,
        response_format: { type: "json_object" }
      });

      return completion.choices[0]?.message?.content || '{"response_needed": false, "reason": "No response generated"}';

    } catch (error) {
      logger.error(`Error calling Azure OpenAI for space ${spaceName}:`, {
        error: error.message,
        status: error.status,
        code: error.code,
        model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'o4-mini',
        endpoint: process.env.AZURE_OPENAI_ENDPOINT
      });
      
      // Return a default response instead of throwing
      return '{"response_needed": false, "reason": "API call failed"}';
    }
  }

  // Build the analysis prompt
  buildAnalysisPrompt(messages, spaceName) {
    const messagesJson = JSON.stringify(messages, null, 2);
    const currentTime = this.formatLocalTime(new Date());
    
    return `Analyze the following Google Chat conversation from the space "${spaceName}" to determine if Aditya needs to respond based on ONLY these two time-based scenarios:


**Recent Messages (oldest to newest):**
${messagesJson}

**ONLY Check These Two Cases:**

1. **Remind Aditya to respond**: If someone sent a message to Aditya (direct question, mention, or request) and the message's timePassedMinutes is MORE than 30 minutes, and Aditya hasn't responded yet.

2. **Follow-up reminder**: If Aditya sent a message (question or request) and the recipient hasn't responded and the message's timePassedMinutes is MORE than 180 minutes (3 hours).

**Analysis Instructions:**
- Use the timePassedMinutes field provided with each message to determine if the time threshold has been met
- Only suggest responses for the above two scenarios
- Ignore general conversation flow, updates, or casual messages
- Focus only on time-sensitive response requirements
- Check if Aditya has already responded to recent items

**Aditya's Communication Style:**
- Keep messages as short as possible and to the point (both Aditya and recipients are busy people)
- Be kind and professional, but not overly informal
- Be concise and respectful of everyone's time
- Avoid unnecessary pleasantries while still maintaining politeness

**IMPORTANT: Respond with valid JSON only in this exact format:**
{
  "response_needed": true/false,
  "reason": "Specify which case applies (30min reminder or 3hr follow-up) and time elapsed, or why no response needed",
  "suggested_response": "write a brief, to-the-point message that follows Aditya's communication style if response_needed is true, otherwise leave empty"
}`;
  }
  // Save results to MongoDB instead of local files
  async saveSuggestedResponsesFile(suggestedResponses) {
    try {
      const output = {
        generated_at: this.formatLocalTime(new Date()),
        total_responses: suggestedResponses.length,
        responses: suggestedResponses
      };

      // Save to MongoDB
      await saveLLMAnalysisResults(output);
      logger.info(`✅ ${suggestedResponses.length} suggested responses saved to MongoDB`);

      // Optionally keep a backup in local file for debugging
      if (process.env.KEEP_LOCAL_BACKUP === 'true') {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `suggested-responses-${timestamp}.json`;
        const filepath = path.join(this.outputDir, filename);

        await fs.writeFile(filepath, JSON.stringify(output, null, 2));
        logger.info(`Backup saved locally: ${filepath}`);
      }

    } catch (error) {
      logger.error('❌ Failed to save suggested responses:', error);
      
      // Fallback to local file if MongoDB fails
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `suggested-responses-${timestamp}.json`;
        const filepath = path.join(this.outputDir, filename);

        const output = {
          generated_at: this.formatLocalTime(new Date()),
          total_responses: suggestedResponses.length,
          responses: suggestedResponses
        };

        await fs.writeFile(filepath, JSON.stringify(output, null, 2));
        logger.warn(`⚠️ MongoDB save failed, saved locally as fallback: ${filepath}`);
        
      } catch (fallbackError) {
        logger.error('❌ Both MongoDB and local file save failed:', fallbackError);
        throw error;
      }
    }
  }

  // Ensure output directory exists
  async ensureOutputDirectory() {
    try {
      await fs.access(this.outputDir);
    } catch {
      await fs.mkdir(this.outputDir, { recursive: true });
      logger.info(`Created output directory: ${this.outputDir}`);
    }
  }

  // Get status of the analyzer
  getStatus() {
    return {
      isRunning: this.isRunning,
      adityaUserId: this.adityaUserId,
      outputDirectory: this.outputDir
    };
  }
}

module.exports = LLMAnalyzer;

// If this file is run directly, perform analysis
if (require.main === module) {
  const analyzer = new LLMAnalyzer();
  
  analyzer.analyzeMessagesForResponsePrediction()
    .then(() => {
      logger.info('🎉 Analysis completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('💥 Analysis failed:', error);
      process.exit(1);
    });
}
