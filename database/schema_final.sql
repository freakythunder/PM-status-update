-- PM Assistant Database Schema for Supabase PostgreSQL
-- SIMPLE REPLACEMENT SCHEMA - Run this to completely update your database
-- This will DROP the old gmail_messages table and create the new simplified structure

-- Enable Row Level Security
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Drop existing gmail_messages table if it exists (this removes old data)
DROP TABLE IF EXISTS gmail_messages CASCADE;

-- Users table for OAuth tokens and user management (keeping existing structure)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    google_tokens JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_sync TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    CONSTRAINT valid_email CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

-- Chat messages with full metadata (keeping existing structure)
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    content TEXT,
    sender_name TEXT,
    sender_email TEXT,
    space_name TEXT,
    space_id TEXT,
    timestamp TIMESTAMP WITH TIME ZONE,
    raw_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, message_id, space_id)
);

-- NEW SIMPLIFIED Gmail messages table
CREATE TABLE gmail_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    thread_id TEXT,
    sender_name TEXT,
    sender_email TEXT,
    subject TEXT,
    body TEXT, -- Using snippet as body content
    date_received TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, message_id)
);

-- Data collection logs for monitoring (keeping existing structure)
CREATE TABLE IF NOT EXISTS sync_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sync_type TEXT NOT NULL CHECK (sync_type IN ('chat', 'gmail')),
    status TEXT NOT NULL CHECK (status IN ('success', 'error', 'partial')),
    message TEXT,
    records_processed INTEGER DEFAULT 0,
    error_details JSONB,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_messages_space_id ON chat_messages(space_id);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_user_id ON gmail_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_date_received ON gmail_messages(date_received);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_body ON gmail_messages USING gin(to_tsvector('english', body));
CREATE INDEX IF NOT EXISTS idx_sync_logs_user_id ON sync_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_started_at ON sync_logs(started_at);

-- Row Level Security Policies
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to avoid conflicts, then create new ones
DROP POLICY IF EXISTS "Users can view own profile" ON users;
DROP POLICY IF EXISTS "Users can view own chat messages" ON chat_messages;
DROP POLICY IF EXISTS "Users can view own gmail messages" ON gmail_messages;
DROP POLICY IF EXISTS "Users can view own sync logs" ON sync_logs;
DROP POLICY IF EXISTS "Service role has full access" ON users;
DROP POLICY IF EXISTS "Service role has full access to chat_messages" ON chat_messages;
DROP POLICY IF EXISTS "Service role has full access to gmail_messages" ON gmail_messages;
DROP POLICY IF EXISTS "Service role has full access to sync_logs" ON sync_logs;

-- Users can only access their own data
CREATE POLICY "Users can view own profile" ON users
    FOR ALL USING (auth.uid()::text = id::text);

CREATE POLICY "Users can view own chat messages" ON chat_messages
    FOR ALL USING (user_id = auth.uid());

CREATE POLICY "Users can view own gmail messages" ON gmail_messages
    FOR ALL USING (user_id = auth.uid());

CREATE POLICY "Users can view own sync logs" ON sync_logs
    FOR ALL USING (user_id = auth.uid());

-- Service role can access all data (for backend operations)
CREATE POLICY "Service role has full access" ON users
    FOR ALL USING (current_setting('role') = 'service_role');

CREATE POLICY "Service role has full access to chat_messages" ON chat_messages
    FOR ALL USING (current_setting('role') = 'service_role');

CREATE POLICY "Service role has full access to gmail_messages" ON gmail_messages
    FOR ALL USING (current_setting('role') = 'service_role');

CREATE POLICY "Service role has full access to sync_logs" ON sync_logs
    FOR ALL USING (current_setting('role') = 'service_role');

-- Function to get overall system stats (NEW)
CREATE OR REPLACE FUNCTION get_system_stats()
RETURNS JSON AS $$
DECLARE
    stats JSON;
BEGIN
    SELECT json_build_object(
        'total_users', COALESCE((SELECT COUNT(*) FROM users WHERE is_active = true), 0),
        'total_chat_messages', COALESCE((SELECT COUNT(*) FROM chat_messages), 0),
        'total_gmail_messages', COALESCE((SELECT COUNT(*) FROM gmail_messages), 0)
    ) INTO stats;
    
    RETURN stats;
END;
$$ LANGUAGE plpgsql;

-- Updated function for user-specific stats
CREATE OR REPLACE FUNCTION get_user_stats(user_uuid UUID)
RETURNS JSON AS $$
DECLARE
    stats JSON;
BEGIN
    SELECT json_build_object(
        'total_chat_messages', COALESCE((SELECT COUNT(*) FROM chat_messages WHERE user_id = user_uuid), 0),
        'total_gmail_messages', COALESCE((SELECT COUNT(*) FROM gmail_messages WHERE user_id = user_uuid), 0),
        'last_chat_sync', (SELECT MAX(completed_at) FROM sync_logs WHERE user_id = user_uuid AND sync_type = 'chat' AND status = 'success'),
        'last_gmail_sync', (SELECT MAX(completed_at) FROM sync_logs WHERE user_id = user_uuid AND sync_type = 'gmail' AND status = 'success'),
        'unique_spaces', COALESCE((SELECT COUNT(DISTINCT space_id) FROM chat_messages WHERE user_id = user_uuid), 0)
    ) INTO stats;
    
    RETURN stats;
END;
$$ LANGUAGE plpgsql;

-- Drop old dashboard_summary view if it exists and create updated one
DROP VIEW IF EXISTS dashboard_summary;
CREATE OR REPLACE VIEW dashboard_summary AS
SELECT 
    u.email,
    u.created_at as user_created,
    u.last_sync,
    (SELECT COUNT(*) FROM chat_messages cm WHERE cm.user_id = u.id) as total_chat_messages,
    (SELECT COUNT(*) FROM gmail_messages gm WHERE gm.user_id = u.id) as total_gmail_messages,
    (SELECT COUNT(DISTINCT space_id) FROM chat_messages cm WHERE cm.user_id = u.id) as unique_spaces,
    (SELECT MAX(timestamp) FROM chat_messages cm WHERE cm.user_id = u.id) as latest_message_time
FROM users u
WHERE u.is_active = true;

-- Grant necessary permissions
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Comments for documentation
COMMENT ON TABLE users IS 'Stores user information and OAuth tokens for Google API access';
COMMENT ON TABLE chat_messages IS 'Stores Google Chat messages with full metadata';
COMMENT ON TABLE gmail_messages IS 'Stores Gmail messages with simplified structure - sender_name, sender_email, subject, body, date_received';
COMMENT ON TABLE sync_logs IS 'Tracks data synchronization operations and their status';
COMMENT ON COLUMN gmail_messages.sender_name IS 'Extracted sender name from Gmail From header';
COMMENT ON COLUMN gmail_messages.sender_email IS 'Extracted sender email from Gmail From header';
COMMENT ON COLUMN gmail_messages.body IS 'Message body content (using snippet from Gmail API)';
COMMENT ON COLUMN gmail_messages.date_received IS 'When the email was received (from Gmail Date header)';

-- Success message
SELECT 'Database schema updated successfully! Gmail messages table recreated with new simplified structure.' as result;
