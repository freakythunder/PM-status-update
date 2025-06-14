// Vercel serverless function for data fetching
const DataFetcher = require('../../dataFetcher');

module.exports = async (req, res) => {
  // Verify the request is from Vercel Cron (optional security check)
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('🤖 Starting data collection from Vercel Cron...');
    
    const fetcher = new DataFetcher();
    await fetcher.collectAllData();
    
    console.log('✅ Data collection completed successfully');
    
    res.status(200).json({ 
      success: true, 
      message: 'Data collection completed successfully',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Data collection failed:', error);
    
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};
