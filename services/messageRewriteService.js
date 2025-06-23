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

    // Prompts for the 2 supported types
    this.prompts = {
      'Make me sound professional': `You are an AI assistant that helps rewrite messages to sound more polished and professional, without being wordy. Follow these steps:
1. Fix the Basics
Correct grammar, spelling, and punctuation.
Keep the original meaning intact.
2. Smart but Simple Upgrades
Use clear, professional alternatives instead of casual language. Avoid unnecessary complexity. And also paragraph the text when relevant.
Examples of Clean Rewrites:
"Help me with this" → "Can you assist with this?"
"Change the plan" → "We should adjust the plan."
"This is wrong" → "This doesn’t seem correct."
"I need more time" → "I’ll require a bit more time."
"Tell the team" → "Please update the team."
"Check the numbers" → "Can you verify the numbers?"
"It’s too hard" → "This is more complex than expected."
"Hurry up" → "Let’s speed this up."
Good vs. Bad Examples
✅ Good (clear & professional):
"Can we talk about this?" → "Can we discuss this further?"
"The numbers look off." → "The data seems inconsistent."
❌ Bad (overly verbose):
"Can we talk?" → ❌ "Might we engage in a discourse?"
"This is bad." → ❌ "This constitutes a suboptimal outcome."

Key Rules:
✔ Clarity over complexity. Never sacrifice readability.
✔ Tone matters. Don’t make a casual Slack message sound like a legal document.
✔ Shorter = better. Trim filler words (e.g., "at this moment in time" → "now").`,

      'I want to stand up for myself': `You are an AI assistant that helps rephrase messages to assert boundaries or call out issues directly, while avoiding passive or overly polite language. Follow these steps:
 Fix the Basics
Correct grammar, spelling, and punctuation.
Keep the original meaning intact.
Rules:
No softening words (e.g., "just," "maybe," "sorry to bother").
State facts bluntly (but without aggression).
Hold others accountable (use "you" when appropriate).
Direct Rewrite Examples:
Original: "I'm always stuck with extra work."
Rewritten: "I'm consistently assigned tasks outside my scope. This needs to stop."
Original: "You ignored my email again."
Rewritten: "You didn't respond to my email, which delayed the project."
Original: "Why am I never included?"
Rewritten: "I'm being excluded from critical discussions, and it's affecting my work."
Original: "Not sure why this keeps happening."
Rewritten: "This is the third occurrence. Let's identify the root cause."
Original: "If it's not too much trouble, could you clarify?"
Rewritten: "Please clarify this point by EOD so I can proceed."
Original: "Not sure if you were aware, but the deadline was missed."
Rewritten: "The deadline passed without completion. What's our path forward?"
Original: "Maybe we could try a different approach?"
Rewritten: "This approach isn't delivering results. I recommend we try a different alternative."
Original: "Sorry to bother, but did you get my email?"
Rewritten: "Following up on my email. Please respond asap."
Original: "I think there might be an issue with the timeline."
Rewritten: "The current timeline isn't feasible. Here's what we need to adjust:"
Original: "Just wondering if you could help with this?"
Rewritten: "This falls under your responsibilities. When can you address it?"
Original: "Having some trouble accessing the files."
Rewritten: "I still need access to [files]. Please share permissions by [date]."
Original: "I might be wrong, but this data looks off."
Rewritten: "I've identified discrepancies in this data. Let's review it together."
Original: "It seems like I wasn't included in the decision."
Rewritten: "I notice this decision was made without my input. Let's discuss how to align."

Key Adjustments:
Passive: "It seems like I wasn't given the info…" → Direct: "I wasn't given the info."
Vague: "There might be an issue…" → Blunt: "This is a problem."
Avoids blame: "Mistakes were made…" → Accountability: "You didn't follow the process."`
    };  }

  // Main method to rewrite messages
  async rewriteMessage(sampleMessage, type) {
    logger.info(`Starting message rewrite - Type: ${type}`);

    try {
      if (!this.prompts[type]) {
        throw new Error(`Unsupported rewrite type: ${type}. Supported types: ${Object.keys(this.prompts).join(', ')}`);
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
    }  }

  // Build the complete prompt for LLM
  buildRewritePrompt(sampleMessage, type) {
    const selectedPrompt = this.prompts[type];
    
    return `${selectedPrompt}

Original Message:
"${sampleMessage}"`;  }

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
    }  }

  // Get available rewrite types
  getAvailableTypes() {
    return Object.keys(this.prompts);
  }

  // Get type description
  getTypeDescription(type) {
    return this.prompts[type] || null;  }

  // Health check for the service
  async healthCheck() {
    try {
      // Test with a simple message
      const testMessage = "Hello, this is a test message.";
      const testType = Object.keys(this.prompts)[0]; // Use first available type
      
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
