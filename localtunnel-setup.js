const localtunnel = require('localtunnel');
const fs = require('fs');
const path = require('path');

async function setupLocalTunnel() {
  try {
    console.log('🔗 Setting up localtunnel...');
    
    // Start localtunnel for port 3000
    const tunnel = await localtunnel({ 
      port: 3000,
      subdomain: "pm-status-update" // Will get a random subdomain
    });

    const url = tunnel.url;
    console.log(`✅ Localtunnel created successfully!`);
    console.log(`🌐 Public URL: ${url}`);
    console.log(`🔗 OAuth URL: ${url}/auth`);
    
    // Update .env file with the new URL
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
    
    // Remove existing NGROK_URL if present
    envContent = envContent.replace(/NGROK_URL=.*/g, '');
    
    // Add new tunnel URL (we'll use NGROK_URL for consistency)
    envContent += `\nNGROK_URL=${url}\n`;
    
    fs.writeFileSync(envPath, envContent);
    console.log(`📝 Updated .env file with NGROK_URL=${url}`);
    
    console.log('\n🎯 IMPORTANT: Update your Google Cloud Console OAuth settings:');
    console.log(`   1. Go to: https://console.cloud.google.com/apis/credentials`);
    console.log(`   2. Edit your OAuth 2.0 Client ID`);
    console.log(`   3. Add this redirect URI: ${url}/auth/callback`);
    console.log(`   4. Save the changes`);
    
    console.log('\n📧 Share this link with your cofounder:');
    console.log(`   ${url}/auth`);
    
    console.log('\n⚠️  Keep this process running to maintain the tunnel!');
    console.log('   Press Ctrl+C to stop the tunnel when done.');
    
    // Handle tunnel errors
    tunnel.on('error', (error) => {
      console.error('❌ Tunnel error:', error);
    });
    
    tunnel.on('close', () => {
      console.log('🛑 Tunnel closed');
    });
    
    // Keep the process alive
    process.on('SIGINT', () => {
      console.log('\n🛑 Stopping tunnel...');
      tunnel.close();
      console.log('✅ Tunnel stopped');
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      tunnel.close();
      process.exit(0);
    });
    
    // Return tunnel info for other scripts
    return { url, tunnel };
    
  } catch (error) {
    console.error('❌ Error setting up localtunnel:', error);
    
    // Fallback instructions
    console.log('\n🔧 Alternative options:');
    console.log('1. Try ngrok manually: npx ngrok http 3000');
    console.log('2. Use Railway/Render for deployment');
    console.log('3. Set up port forwarding on your router');
    
    process.exit(1);
  }
}

// Check if this script is being run directly
if (require.main === module) {
  setupLocalTunnel();
}

module.exports = { setupLocalTunnel };
