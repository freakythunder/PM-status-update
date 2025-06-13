#!/usr/bin/env node

/**
 * Setup Script for PM Assistant Backend
 * This script helps validate the configuration and setup process
 */

const fs = require('fs');
const path = require('path');

// Load environment variables with explicit path
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Simple colored output without chalk
const colors = {
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m',
    reset: '\x1b[0m'
};

// Helper functions for colored output
const success = (msg) => console.log(colors.green + '✓ ' + msg + colors.reset);
const warning = (msg) => console.log(colors.yellow + '⚠ ' + msg + colors.reset);
const error = (msg) => console.log(colors.red + '✗ ' + msg + colors.reset);
const info = (msg) => console.log(colors.blue + 'ℹ ' + msg + colors.reset);
const header = (msg) => console.log(colors.bold + colors.cyan + '\n' + msg + colors.reset);

async function checkEnvironmentVariables() {
    header('Checking Environment Variables...');
    
    const requiredVars = [
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'SUPABASE_URL',
        'SUPABASE_SERVICE_KEY',
        'PORT',
        'DASHBOARD_PORT',
        'SESSION_SECRET'
    ];
    
    const missingVars = [];
    const placeholderVars = [];
    
    requiredVars.forEach(varName => {
        const value = process.env[varName];
        if (!value) {
            missingVars.push(varName);
        } else if (value.includes('your_') || value.includes('_here') || value.includes('placeholder')) {
            placeholderVars.push(varName);
            warning(`${varName} has placeholder value: ${value}`);
        } else {
            success(`${varName} is configured`);
        }
    });
    
    if (missingVars.length > 0) {
        error(`Missing environment variables: ${missingVars.join(', ')}`);
        info('Make sure your .env file exists and contains all required variables');
    }
    
    if (placeholderVars.length > 0) {
        warning('Please replace placeholder values with actual values from your Supabase project');
    }
    
    return missingVars.length === 0 && placeholderVars.length === 0;
}

async function checkFiles() {
    header('Checking Required Files...');
    
    const requiredFiles = [
        'server.js',
        'dataFetcher.js',
        'dashboard.js',
        'utils/googleAuth.js',
        'utils/supabase.js',
        'database/schema.sql',
        '.env'
    ];
    
    let allFilesExist = true;
    
    requiredFiles.forEach(filePath => {
        if (fs.existsSync(path.join(__dirname, filePath))) {
            success(`${filePath} exists`);
        } else {
            error(`${filePath} is missing`);
            allFilesExist = false;
        }
    });
    
    return allFilesExist;
}

async function checkDependencies() {
    header('Checking Dependencies...');
    
    try {
        const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        const nodeModulesExists = fs.existsSync(path.join(__dirname, 'node_modules'));
        
        if (nodeModulesExists) {
            success('node_modules directory exists');
        } else {
            error('node_modules directory not found');
            info('Run: npm install');
            return false;
        }
        
        // Check if main dependencies are installed
        const criticalDeps = ['express', 'googleapis', '@supabase/supabase-js', 'node-cron'];
        let allDepsInstalled = true;
        
        criticalDeps.forEach(dep => {
            try {
                require.resolve(dep);
                success(`${dep} is installed`);
            } catch (err) {
                error(`${dep} is not installed`);
                allDepsInstalled = false;
            }
        });
        
        return allDepsInstalled;
    } catch (err) {
        error('Error checking dependencies: ' + err.message);
        return false;
    }
}


async function testSupabaseConnection() {
    header('Testing Supabase Connection...');
    
    if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL.includes('your_')) {
        warning('Supabase URL not configured - skipping connection test');
        return false;
    }
    
    try {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        
        // Test connection by trying to fetch from a system table
        const { data, error } = await supabase.from('users').select('count').limit(1);
          if (error) {
            if (error.message.includes('relation "users" does not exist')) {
                warning('Supabase connected but tables not created yet');
                info('Run the SQL schema from database/schema.sql in your Supabase SQL editor');
                return false;
            } else {
                console.log(colors.red + '✗ Supabase connection failed: ' + error.message + colors.reset);
                return false;
            }
        } else {
            success('Supabase connection successful');
            return true;
        }
    } catch (err) {
        error('Error testing Supabase connection: ' + err.message);
        return false;
    }
}

async function displayNextSteps() {
    header('Next Steps to Complete Setup:');
    
    console.log('\n1. ' + colors.bold + 'Set up Supabase project:' + colors.reset);
    console.log('   • Go to https://supabase.com and create a new project');
    console.log('   • Get your project URL and service role key from Settings > API');
    console.log('   • Update SUPABASE_URL and SUPABASE_SERVICE_KEY in .env file');
    
    console.log('\n2. ' + colors.bold + 'Create database tables:' + colors.reset);
    console.log('   • Go to your Supabase dashboard > SQL Editor');
    console.log('   • Copy and run the SQL from database/schema.sql');
    
    console.log('\n3. ' + colors.bold + 'Enable Google APIs:' + colors.reset);
    console.log('   • Go to Google Cloud Console (console.cloud.google.com)');
    console.log('   • Enable Google Chat API and Google Sheets API');
    console.log('   • Add http://localhost:3000/auth/callback to OAuth redirect URIs');
    
    console.log('\n4. ' + colors.bold + 'Start the servers:' + colors.reset);
    console.log('   • Main server: npm start (runs on port 3000)');
    console.log('   • Dashboard: npm run dashboard (runs on port 4000)');
    console.log('   • Data fetcher: npm run fetch (or starts automatically with main server)');
    
    console.log('\n5. ' + colors.bold + 'Test the application:' + colors.reset);
    console.log('   • Visit http://localhost:3000 to start OAuth flow');
    console.log('   • Visit http://localhost:4000 to view the dashboard');
    
    console.log('\n' + colors.bold + colors.green + '🚀 Your PM Assistant backend is ready to go!' + colors.reset);
}

async function main() {
    console.log(colors.bold + colors.cyan + '='.repeat(60) + colors.reset);
    console.log(colors.bold + colors.cyan + '          PM Assistant Backend Setup Checker' + colors.reset);
    console.log(colors.bold + colors.cyan + '='.repeat(60) + colors.reset);
    
    const envCheck = await checkEnvironmentVariables();
    const filesCheck = await checkFiles();
    const depsCheck = await checkDependencies();
    const supabaseCheck = await testSupabaseConnection();
    
    header('Setup Status Summary:');
    
    if (envCheck) success('Environment variables configured');
    else warning('Environment variables need attention');
    
    if (filesCheck) success('All required files present');
    else error('Some files are missing');
    
    if (depsCheck) success('Dependencies installed');
    else error('Dependencies need to be installed');
    
    if (supabaseCheck) success('Supabase connection working');
    else warning('Supabase needs configuration');
    
    await displayNextSteps();
}

main().catch(console.error);
