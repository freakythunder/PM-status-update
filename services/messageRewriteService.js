require('dotenv').config();
const winston = require('winston');
const { AzureOpenAI } = require('openai');

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
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
      )
    }),
    new winston.transports.File({
      filename: 'message-rewrite-service.log',
      format: winston.format.json()
    })
  ]
});

class MessageRewriteService {
  constructor() {
    // Initialize Azure OpenAI client
    this.azureClient = new AzureOpenAI({
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'o4-mini',
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2025-01-01-preview'
    });

    // Fixed prompt that applies to all rewrite requests
    this.fixedPrompt = `You are an AI assistant that helps rewrite messages following a user persona given by user. 
    you will follow this given user persona and rewrite the sample message into a message which can be shared directly with others
    user persona:
    You're very busy and so is everyone you correspond with, so you do your best to keep your messages as short as possible and to the point. Do your best to be kind, and don't be so informal that it comes across as rude.`;

    // Type-specific prompts
    this.typePrompts = {
      'Make this more polite': 'Add courteous language, respectful tone, and appropriate pleasantries while maintaining the message\'s core intent.',
      'Make me sound smart': 'Elevate vocabulary and structure with sophisticated language and well-articulated arguments without sounding pretentious.',
      'I wanna stand up for myself': 'Add assertiveness and confidence to the message while maintaining professionalism and respect for the recipient.',
      'I want to be too the point': 'Remove all unnecessary details and pleasantries to deliver only the essential information in the most direct way possible.',
      'I wanna be angry at my sub-ordinate': 'Express clear disappointment and firm expectations while maintaining professional boundaries and constructive feedback.'
    };
  }

  // Main method to rewrite messages
  async rewriteMessage(sampleMessage, type) {
    logger.info(`Starting message rewrite - Type: ${type}`);

    try {
      // Validate type
      if (!this.typePrompts[type]) {
        throw new Error(`Unsupported rewrite type: ${type}. Supported types: ${Object.keys(this.typePrompts).join(', ')}`);
      }

      // Build the complete prompt
      const fullPrompt = this.buildRewritePrompt(sampleMessage, type);

      // Get LLM response
      const rewrittenMessage = await this.getLLMRewrite(fullPrompt);

      logger.info(`Message rewrite completed successfully - Type: ${type}`);
      return rewrittenMessage;

    } catch (error) {
      logger.error(`Failed to rewrite message - Type: ${type}:`, error);
      throw new Error(`Message rewrite failed: ${error.message}`);
    }
  }

  // Build the complete prompt for LLM
  buildRewritePrompt(sampleMessage, type) {
    const typeSpecificPrompt = this.typePrompts[type];
    
    return `${this.fixedPrompt}

Specific Instructions for this rewrite:
${typeSpecificPrompt}

Original Message:
"${sampleMessage}"

Please rewrite the above message according to the guidelines and specific instructions. Return only the rewritten message without any additional commentary or quotes.`;
  }

  // Get rewritten message from LLM
  async getLLMRewrite(prompt) {
    try {
      const completion = await this.azureClient.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'o4-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a professional communication assistant. Rewrite messages according to the given instructions and return only the improved message.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_completion_tokens: 1000,
      });

      const rewrittenMessage = completion.choices[0]?.message?.content?.trim();
      
      if (!rewrittenMessage) {
        throw new Error('No response received from LLM');
      }

      return rewrittenMessage;

    } catch (error) {
      logger.error('Error calling Azure OpenAI for message rewrite:', {
        error: error.message,
        status: error.status,
        code: error.code,
        model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'o4-mini',
        endpoint: process.env.AZURE_OPENAI_ENDPOINT
      });
      
      throw new Error(`LLM API call failed: ${error.message}`);
    }
  }

  // Get available rewrite types
  getAvailableTypes() {
    return Object.keys(this.typePrompts);
  }

  // Get type description
  getTypeDescription(type) {
    return this.typePrompts[type] || null;
  }

  // Health check for the service
  async healthCheck() {
    try {
      // Test with a simple message
      const testMessage = "Hello, this is a test message.";
      const testType = "professional";
      
      await this.rewriteMessage(testMessage, testType);
      return { status: 'healthy', timestamp: new Date().toISOString() };
    } catch (error) {
      return { 
        status: 'unhealthy', 
        error: error.message, 
        timestamp: new Date().toISOString() 
      };
    }
  }
}

module.exports = MessageRewriteService;
