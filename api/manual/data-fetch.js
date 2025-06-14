// Manual trigger endpoint for data fetching
const DataFetcher = require('../../dataFetcher');

module.exports = async (req, res) => {
  // Only allow POST requests for manual triggers
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('🚀 Manual data collection trigger received...');
    
    const fetcher = new DataFetcher();
    await fetcher.collectAllData();
    
    console.log('✅ Manual data collection completed successfully');
    
    res.status(200).json({ 
      success: true, 
      message: 'Manual data collection completed successfully',
      timestamp: new Date().toISOString(),
      trigger: 'manual'
    });
    
  } catch (error) {
    console.error('❌ Manual data collection failed:', error);
    
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString(),
      trigger: 'manual'
    });
  }
};
