require('dotenv').config();
const winston = require('winston');
const { google } = require('googleapis');
const GoogleAuthManager = require('./utils/googleAuth');
const { connectToMongoDB, getAllActiveUsers } = require('./utils/mongodb');

// Configure logger for detailed output
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let output = `${timestamp} [${level}]: ${message}`;
      if (Object.keys(meta).length > 0) {
        output += '\n' + JSON.stringify(meta, null, 2);
      }
      return output;
    })
  ),
  transports: [
    new winston.transports.Console()
  ]
});

class ChatAPITester {
  constructor() {
    this.googleAuth = new GoogleAuthManager();
    logger.info('🧪 Chat API Tester initialized');
  }

  async testAllChatAPIs() {
    try {
      logger.info('🚀 Starting comprehensive Chat API testing...');
      
      // Get user from database
      const users = await getAllActiveUsers();
      if (users.length === 0) {
        logger.error('❌ No active users found in database');
        return;
      }

      const user = users[0]; // Get first user
      logger.info(`👤 Testing with user: ${user.email}`);

      // Refresh tokens if needed
      const refreshedTokens = await this.googleAuth.refreshTokenIfNeeded(user.google_tokens);
      
      // Create Chat client
      const chatClient = this.googleAuth.createChatClient(refreshedTokens);
      logger.info('📋 Available Chat API permissions:');
      logger.info('   - chat.spaces.readonly: List and read spaces');
      logger.info('   - chat.messages.readonly: Read messages from spaces');
      logger.info('   - chat.memberships.readonly: Read space memberships');
      logger.info('   - userinfo.email: Access user email');
      logger.info('   - userinfo.profile: Access user profile');
      console.log('\n' + '='.repeat(80));
      console.log('💬 TESTING DIRECT MESSAGE SPACES');
      console.log('='.repeat(80));
      
      await this.testDirectMessageSpaces(chatClient);      
      console.log('\n' + '='.repeat(80));
      console.log('👥 TESTING DIRECT MESSAGE MEMBERS WITH PEOPLE API');
      console.log('='.repeat(80));
      
      await this.testDirectMessageMembersWithNames(chatClient, refreshedTokens);

    } catch (error) {
      logger.error('❌ Error during Chat API testing:', error);
    }
  }

  async testSpacesAPI(chatClient) {
    try {
      logger.info('🔍 Testing Spaces API...');
      
      // List all spaces
      logger.info('📝 Calling spaces.list()...');
      const spacesResponse = await chatClient.spaces.list({
       
      });
      
      console.log('\n📊 SPACES LIST RESPONSE:');
      console.log('Total spaces found:', spacesResponse.data.spaces?.length || 0);
      
      if (spacesResponse.data.spaces && spacesResponse.data.spaces.length > 0) {
        console.log('\n📋 DETAILED SPACES DATA:');
        spacesResponse.data.spaces.forEach((space, index) => {
          console.log(`\n--- SPACE ${index + 1} ---`);
          console.log('Name:', space.name);
          console.log('Type:', space.type);
          console.log('Space Type:', space.spaceType);
          console.log('Display Name:', space.displayName);
          console.log('Threaded:', space.threaded);
          console.log('Space Thread Policy:', space.spaceThreadingPolicy);
          console.log('Space Details:', space.spaceDetails);
          console.log('Space History State:', space.spaceHistoryState);
          console.log('Import Mode:', space.importMode);
          console.log('Create Time:', space.createTime);
          console.log('Admin Installed:', space.adminInstalled);
          console.log('Access Settings:', space.accessSettings);
          console.log('Space URI:', space.spaceUri);
          console.log('Full Space Object:', JSON.stringify(space, null, 2));
        });

        // Test getting individual space details
        const firstSpace = spacesResponse.data.spaces[0];
        logger.info(`🔍 Getting details for space: ${firstSpace.name}`);
        
        try {
          const spaceDetail = await chatClient.spaces.get({
            name: firstSpace.name
          });
          
          console.log('\n📊 INDIVIDUAL SPACE DETAILS:');
          console.log(JSON.stringify(spaceDetail.data, null, 2));
        } catch (error) {
          logger.error('Error getting space details:', error.message);
        }

        return spacesResponse.data.spaces;
      } else {
        console.log('❌ No spaces found or accessible');
        return [];
      }
      
    } catch (error) {
      logger.error('❌ Error testing Spaces API:', error);
      console.log('Error details:', error.message);
      if (error.code) console.log('Error code:', error.code);
      if (error.errors) console.log('Error details:', error.errors);
      return [];
    }
  }

  async testMembershipsAPI(chatClient) {
    try {
      logger.info('🔍 Testing Memberships API...');
      
      // First get spaces to test memberships
      const spacesResponse = await chatClient.spaces.list();
      
      if (!spacesResponse.data.spaces || spacesResponse.data.spaces.length === 0) {
        console.log('❌ No spaces available to test memberships');
        return;
      }

      console.log(`\n👥 TESTING MEMBERSHIPS FOR ${spacesResponse.data.spaces.length} SPACES:`);
      
      for (const [spaceIndex, space] of spacesResponse.data.spaces.entries()) {
        console.log(`\n--- MEMBERSHIPS FOR SPACE ${spaceIndex + 1}: ${space.displayName || space.name} ---`);
        
        try {
          // List all members with pagination
          let allMembers = [];
          let nextPageToken = null;
          let pageCount = 0;
          
          do {
            pageCount++;
            console.log(`📄 Fetching memberships page ${pageCount}...`);
            
            const request = {
              parent: space.name,
              pageSize: 100, // Maximum page size
              pageToken: nextPageToken,
              filter: 'member.type = "HUMAN"' // Filter for human members only
            };
            
            const membershipsResponse = await chatClient.spaces.members.list(request);
            
            if (membershipsResponse.data.memberships) {
              allMembers = allMembers.concat(membershipsResponse.data.memberships);
              console.log(`   Found ${membershipsResponse.data.memberships.length} members on page ${pageCount}`);
            }
            
            nextPageToken = membershipsResponse.data.nextPageToken;
          } while (nextPageToken);
          
          console.log(`\n📊 TOTAL MEMBERS RETRIEVED: ${allMembers.length}`);
          
          if (allMembers.length === 0) {
            console.log('❌ No human members found in this space');
            
            // Try without filter to see if there are any members at all
            try {
              const allMembersResponse = await chatClient.spaces.members.list({
                parent: space.name,
                pageSize: 10
              });
              
              if (allMembersResponse.data.memberships) {
                console.log(`   Found ${allMembersResponse.data.memberships.length} total members (including bots)`);
                allMembersResponse.data.memberships.forEach((membership, index) => {
                  console.log(`   Member ${index + 1}: ${membership.member?.type || 'Unknown type'} - ${membership.member?.displayName || 'No name'}`);
                });
              }
            } catch (error) {
              console.log('   Error getting all members:', error.message);
            }
            
            continue;
          }
          
          // Display detailed member information
          console.log('\n' + '='.repeat(60));
          console.log('👥 DETAILED MEMBER LIST:');
          console.log('='.repeat(60));
          
          allMembers.forEach((membership, index) => {
            console.log(`\n--- MEMBER ${index + 1} ---`);
            console.log('Name:', membership.name);
            console.log('State:', membership.state);
            console.log('Role:', membership.role);
            console.log('Create Time:', membership.createTime);
            console.log('Delete Time:', membership.deleteTime || 'Active');
            
            if (membership.member) {
              console.log('Member Details:');
              console.log('  ID:', membership.member.name);
              console.log('  Display Name:', membership.member.displayName);
              console.log('  Type:', membership.member.type);
              console.log('  Domain ID:', membership.member.domainId);
              console.log('  Is Anonymous:', membership.member.isAnonymous || false);
            }
            
            if (membership.groupMember) {
              console.log('Group Member Details:');
              console.log('  Name:', membership.groupMember.name);
            }
            
            console.log('Full Membership Object:');
            console.log(JSON.stringify(membership, null, 2));
          });
          
          // Test getting individual membership details
          if (allMembers.length > 0) {
            const firstMember = allMembers[0];
            console.log(`\n🔍 Getting individual membership details for: ${firstMember.name}`);
            
            try {
              const memberDetail = await chatClient.spaces.members.get({
                name: firstMember.name
              });
              
              console.log('\n📊 INDIVIDUAL MEMBERSHIP DETAILS:');
              console.log('Name:', memberDetail.data.name);
              console.log('State:', memberDetail.data.state);
              console.log('Role:', memberDetail.data.role);
              console.log('Member:', memberDetail.data.member?.displayName || 'No display name');
              console.log('Full Individual Membership Object:');
              console.log(JSON.stringify(memberDetail.data, null, 2));
            } catch (error) {
              console.log('Error getting individual membership details:', error.message);
            }
          }
          
          // Summary for this space
          console.log('\n' + '='.repeat(60));
          console.log('📈 MEMBERSHIP SUMMARY:');
          console.log('='.repeat(60));
          console.log(`Space: ${space.displayName || space.name}`);
          console.log(`Total human members: ${allMembers.length}`);
          console.log(`Pages retrieved: ${pageCount}`);
          
          // Count by role
          const roleCount = {};
          allMembers.forEach(member => {
            const role = member.role || 'Unknown';
            roleCount[role] = (roleCount[role] || 0) + 1;
          });
          
          console.log('Members by role:');
          Object.entries(roleCount).forEach(([role, count]) => {
            console.log(`  ${role}: ${count}`);
          });
          
          // Count by state
          const stateCount = {};
          allMembers.forEach(member => {
            const state = member.state || 'Unknown';
            stateCount[state] = (stateCount[state] || 0) + 1;
          });
          
          console.log('Members by state:');
          Object.entries(stateCount).forEach(([state, count]) => {
            console.log(`  ${state}: ${count}`);
          });
          
        } catch (error) {
          console.log(`    ❌ Error getting memberships: ${error.message}`);
          if (error.code) console.log('    Error code:', error.code);
          if (error.errors) console.log('    Error details:', error.errors);
        }
        
        // Limit to first 3 spaces to avoid excessive output
        if (spaceIndex >= 2) {
          console.log('\n⏸️ Limiting to first 3 spaces for membership testing...');
          break;
        }
      }
      
    } catch (error) {
      logger.error('❌ Error testing Memberships API:', error);
      console.log('Error details:', error.message);
    }
  }

  async testMessagesAPI(chatClient) {
    try {
      logger.info('🔍 Testing Messages API...');
      
      // First get spaces to test messages
      const spacesResponse = await chatClient.spaces.list();
      
      if (!spacesResponse.data.spaces || spacesResponse.data.spaces.length === 0) {
        console.log('❌ No spaces available to test messages');
        return;
      }

      if (spacesResponse.data.spaces.length < 2) {
        console.log('❌ Less than 2 spaces available, using first space');
        return;
      }

      console.log(`\n💬 TESTING MESSAGES FOR SPACE 2 OF ${spacesResponse.data.spaces.length} SPACES:`);
      
      const space = spacesResponse.data.spaces[1]; // Use the second space (index 1)
      console.log(`\n--- FETCHING ALL MESSAGES FOR SPACE: ${space.displayName || space.name} ---`);
      
      try {
        // Fetch all messages with pagination
        let allMessages = [];
        let nextPageToken = null;
        let pageCount = 0;
        
        do {
          pageCount++;
          console.log(`📄 Fetching page ${pageCount}...`);
          
          const messagesResponse = await chatClient.spaces.messages.list({
            parent: space.name,
            pageSize: 1000, // Maximum page size
            pageToken: nextPageToken,
            orderBy: 'createTime desc' // Most recent first for pagination
          });
          
          if (messagesResponse.data.messages) {
            allMessages = allMessages.concat(messagesResponse.data.messages);
            console.log(`   Found ${messagesResponse.data.messages.length} messages on page ${pageCount}`);
          }
          
          nextPageToken = messagesResponse.data.nextPageToken;
        } while (nextPageToken);
        
        console.log(`\n📊 TOTAL MESSAGES RETRIEVED: ${allMessages.length}`);
        
        if (allMessages.length === 0) {
          console.log('❌ No messages found in this space');
          return;
        }
        
        // Sort messages by createTime to find oldest and newest
        allMessages.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
        
        const oldestMessage = allMessages[0];
        const newestMessage = allMessages[allMessages.length - 1];
        
        console.log('\n' + '='.repeat(60));
        console.log('🕰️  OLDEST MESSAGE:');
        console.log('='.repeat(60));
        console.log('Name:', oldestMessage.name);
        console.log('Create Time:', oldestMessage.createTime);
        console.log('Sender:', oldestMessage.sender?.displayName || 'Unknown');
        console.log('Text:', oldestMessage.text || 'No text content');
        console.log('Message Type:', oldestMessage.messageType || 'Not specified');
        console.log('Thread:', oldestMessage.thread?.name || 'No thread');
        console.log('Full Message Object:');
        console.log(JSON.stringify(oldestMessage, null, 2));
        
        console.log('\n' + '='.repeat(60));
        console.log('🆕 NEWEST MESSAGE:');
        console.log('='.repeat(60));
        console.log('Name:', newestMessage.name);
        console.log('Create Time:', newestMessage.createTime);
        console.log('Sender:', newestMessage.sender?.displayName || 'Unknown');
        console.log('Text:', newestMessage.text || 'No text content');
        console.log('Message Type:', newestMessage.messageType || 'Not specified');
        console.log('Thread:', newestMessage.thread?.name || 'No thread');
        console.log('Full Message Object:');
        console.log(JSON.stringify(newestMessage, null, 2));
        
        console.log('\n' + '='.repeat(60));
        console.log('📈 MESSAGE SUMMARY:');
        console.log('='.repeat(60));
        console.log(`Total messages fetched: ${allMessages.length}`);
        console.log(`Pages retrieved: ${pageCount}`);
        console.log(`Oldest message date: ${oldestMessage.createTime}`);
        console.log(`Newest message date: ${newestMessage.createTime}`);
        console.log(`Space: ${space.displayName || space.name}`);
        
      } catch (error) {
        console.log(`    ❌ Error getting messages: ${error.message}`);
        if (error.code) console.log('    Error code:', error.code);
      }
      
    } catch (error) {
      logger.error('❌ Error testing Messages API:', error);
      console.log('Error details:', error.message);
    }
  }

  // Test other potential APIs we might have access to
  async testAdditionalAPIs(chatClient) {
    try {
      logger.info('🔍 Testing additional Chat APIs...');
      
      // Test if we can access user spaces
      try {
        console.log('\n🏠 TESTING USER SPACES ACCESS:');
        const userSpaces = await chatClient.users.spaces.list({
          parent: 'users/me'
        });
        console.log('User spaces:', JSON.stringify(userSpaces.data, null, 2));
      } catch (error) {
        console.log('❌ User spaces not accessible:', error.message);
      }

      // Test space events if available
      try {
        console.log('\n📅 TESTING SPACE EVENTS:');
        const events = await chatClient.spaces.spaceEvents.list({
          parent: 'spaces/-', // Try with default space
          pageSize: 10
        });
        console.log('Space events:', JSON.stringify(events.data, null, 2));
      } catch (error) {
        console.log('❌ Space events not accessible:', error.message);
      }

    } catch (error) {
      logger.error('❌ Error testing additional APIs:', error);
    }
  }

  // Test Admin Memberships API with the new scope
  async testAdminMembershipsAPI(chatClient) {
    try {
      logger.info('🔍 Testing Admin Memberships API with new scope...');
      
      // First get spaces to test admin memberships
      const spacesResponse = await chatClient.spaces.list({ pageSize: 2 });
      
      if (!spacesResponse.data.spaces || spacesResponse.data.spaces.length === 0) {
        console.log('❌ No spaces available to test admin memberships');
        return;
      }

      console.log(`\n👥 TESTING ADMIN MEMBERSHIPS FOR ${spacesResponse.data.spaces.length} SPACES:`);
      
      for (const [spaceIndex, space] of spacesResponse.data.spaces.entries()) {
        console.log(`\n--- ADMIN MEMBERSHIPS FOR SPACE ${spaceIndex + 1}: ${space.displayName || space.name} ---`);
        
        try {
          // Test standard memberships first
          console.log('\n📋 Standard Memberships API:');
          const standardMemberships = await chatClient.spaces.members.list({
            parent: space.name,
            pageSize: 100
          });
          
          console.log('Standard members found:', standardMemberships.data.memberships?.length || 0);
          
          if (standardMemberships.data.memberships && standardMemberships.data.memberships.length > 0) {
            standardMemberships.data.memberships.forEach((membership, index) => {
              console.log(`\n  Standard Member ${index + 1}:`);
              console.log('    Name:', membership.name);
              console.log('    State:', membership.state);
              console.log('    Role:', membership.role);
              console.log('    Create Time:', membership.createTime);
              
              // Member details
              if (membership.member) {
                console.log('    Member Name:', membership.member.name);
                console.log('    Member Type:', membership.member.type);
                console.log('    Member Display Name:', membership.member.displayName);
                console.log('    Member Domain ID:', membership.member.domainId);
                console.log('    Full Member Object:', JSON.stringify(membership.member, null, 6));
              }
              
              // Group member details
              if (membership.groupMember) {
                console.log('    Group Member Name:', membership.groupMember.name);
                console.log('    Full Group Member Object:', JSON.stringify(membership.groupMember, null, 6));
              }
              
              console.log('    Full Membership Object:', JSON.stringify(membership, null, 4));
            });
          }

          // Test if we can access admin-specific membership endpoints
          console.log('\n🔧 Testing Admin-specific Membership Features:');
          
          // Try to get membership with admin scope - this might provide more details
          if (standardMemberships.data.memberships && standardMemberships.data.memberships.length > 0) {
            const firstMembership = standardMemberships.data.memberships[0];
            
            try {
              console.log('\n🔍 Getting individual membership details with admin scope:');
              const membershipDetail = await chatClient.spaces.members.get({
                name: firstMembership.name
              });
              
              console.log('Admin Membership Details:');
              console.log('  Name:', membershipDetail.data.name);
              console.log('  State:', membershipDetail.data.state);
              console.log('  Role:', membershipDetail.data.role);
              console.log('  Create Time:', membershipDetail.data.createTime);
              
              if (membershipDetail.data.member) {
                console.log('  Admin Member Details:');
                console.log('    Name:', membershipDetail.data.member.name);
                console.log('    Type:', membershipDetail.data.member.type);
                console.log('    Display Name:', membershipDetail.data.member.displayName);
                console.log('    Domain ID:', membershipDetail.data.member.domainId);
                console.log('    Is Anonymous:', membershipDetail.data.member.isAnonymous);
                console.log('    Full Admin Member Object:', JSON.stringify(membershipDetail.data.member, null, 6));
              }
              
              console.log('  Full Admin Membership Object:', JSON.stringify(membershipDetail.data, null, 4));
              
            } catch (error) {
              console.log(`    ❌ Admin membership details error: ${error.message}`);
            }
          }

          // Test admin-level membership operations
          try {
            console.log('\n🛡️ Testing Admin Membership Operations:');
            
            // Try to list memberships with admin filter (if available)
            const adminMemberships = await chatClient.spaces.members.list({
              parent: space.name,
              pageSize: 100,
              showGroups: true, // This might be available with admin scope
              showInvited: true  // This might be available with admin scope
            });
            
            console.log('Admin-filtered members found:', adminMemberships.data.memberships?.length || 0);
            
            if (adminMemberships.data.memberships) {
              adminMemberships.data.memberships.forEach((membership, index) => {
                console.log(`\n  Admin Member ${index + 1}:`);
                console.log('    Name:', membership.name);
                console.log('    State:', membership.state);
                console.log('    Role:', membership.role);
                
                if (membership.member) {
                  console.log('    🆔 Member ID:', membership.member.name);
                  console.log('    👤 Display Name:', membership.member.displayName);
                  console.log('    📧 Domain ID:', membership.member.domainId);
                  console.log('    🔒 Is Anonymous:', membership.member.isAnonymous);
                  console.log('    📱 Type:', membership.member.type);
                }
              });
            }
            
          } catch (error) {
            console.log(`    ❌ Admin membership operations error: ${error.message}`);
          }

          // Test if we can access space-level admin info
          try {
            console.log('\n🏢 Testing Space Admin Information:');
            
            const spaceDetail = await chatClient.spaces.get({
              name: space.name
            });
            
            console.log('Space Admin Details:');
            console.log('  Name:', spaceDetail.data.name);
            console.log('  Display Name:', spaceDetail.data.displayName);
            console.log('  Type:', spaceDetail.data.type);
            console.log('  Space Type:', spaceDetail.data.spaceType);
            console.log('  Admin Installed:', spaceDetail.data.adminInstalled);
            console.log('  Access Settings:', spaceDetail.data.accessSettings);
            console.log('  Space Details:', spaceDetail.data.spaceDetails);
            console.log('  Membership Count:', spaceDetail.data.membershipCount);
            console.log('  Full Space Admin Object:', JSON.stringify(spaceDetail.data, null, 4));
            
          } catch (error) {
            console.log(`    ❌ Space admin info error: ${error.message}`);
          }
          
        } catch (error) {
          console.log(`    ❌ Error testing admin memberships for space: ${error.message}`);
          if (error.code) console.log('    Error code:', error.code);
          if (error.errors) console.log('    Error details:', error.errors);
        }

        // Only test first 2 spaces to avoid too much output
        if (spaceIndex >= 1) {
          console.log('\n⏸️ Limiting to first 2 spaces for admin testing...');
          break;
        }
      }
      
    } catch (error) {
      logger.error('❌ Error testing Admin Memberships API:', error);
      console.log('Error details:', error.message);
      if (error.code) console.log('Error code:', error.code);
    }
  }

  // Create Directory API client to test if admin scope gives us access
  createDirectoryClient(tokens) {
    const auth = this.googleAuth.createAuthenticatedClient(tokens);
    return google.admin({ version: 'directory_v1', auth });
  }

  // Test if admin memberships scope gives us any Directory API access
  async testDirectoryAPIAccess(tokens) {
    try {
      console.log('\n🏢 TESTING DIRECTORY API ACCESS WITH ADMIN SCOPE:');
      
      const directoryClient = this.createDirectoryClient(tokens);
      
      // Try to list users in the domain
      try {
        const usersResponse = await directoryClient.users.list({
          domain: 'iitkgp.ac.in', // Your domain
          maxResults: 5
        });
        
        console.log('✅ Directory API accessible with admin scope!');
        console.log('Users found:', usersResponse.data.users?.length || 0);
        
        if (usersResponse.data.users) {
          usersResponse.data.users.forEach((user, index) => {
            console.log(`\n  User ${index + 1}:`);
            console.log('    ID:', user.id);
            console.log('    Name:', user.name?.fullName);
            console.log('    Email:', user.primaryEmail);
            console.log('    Given Name:', user.name?.givenName);
            console.log('    Family Name:', user.name?.familyName);
          });
        }
        
        return true;
        
      } catch (error) {
        console.log('❌ Directory API not accessible:', error.message);
        return false;
      }
      
    } catch (error) {
      console.log('❌ Error testing Directory API:', error.message);
      return false;
    }  }
  // Test People API and Directory access with member details
  async testPeopleAPIWithMembers(chatClient, tokens) {
    try {
      console.log('🔍 Testing Organization Directory Access...');
      
      // First, check if user has admin privileges
      console.log('\n🔐 CHECKING ADMIN PRIVILEGES...');
      const adminCheck = await this.googleAuth.checkAdminPrivileges(tokens);
      
      console.log('Admin Privilege Check Results:');
      console.log(`  Has Admin Access: ${adminCheck.hasAdminAccess}`);
      console.log(`  Email: ${adminCheck.email || 'Unknown'}`);
      
      if (adminCheck.hasAdminAccess) {
        console.log(`  Is Super Admin: ${adminCheck.isAdmin}`);
        console.log(`  Is Delegated Admin: ${adminCheck.isDelegatedAdmin}`);
        console.log(`  Admin Roles: ${JSON.stringify(adminCheck.adminRoles, null, 2)}`);
      } else {
        console.log(`  ❌ Admin Access Error: ${adminCheck.error}`);
        console.log(`  Error Code: ${adminCheck.code}`);
        console.log('\n💡 SOLUTION: Ask your Google Workspace admin to grant you admin privileges:');
        console.log('     - Super Admin (full access)');
        console.log('     - User Management Admin (user data access)');
        console.log('     - Groups Admin (limited access)');
      }
      
      // Try to access organization directory only if we have admin access
      if (adminCheck.hasAdminAccess) {
        try {
          const directoryData = await this.googleAuth.fetchOrganizationDirectory(tokens, 10);
          
          console.log('\n🏢 ORGANIZATION DIRECTORY DATA:');
          console.log('='.repeat(60));
          console.log(`Total users found: ${directoryData.users?.length || 0}`);
          
          if (directoryData.users && directoryData.users.length > 0) {
            directoryData.users.forEach((user, index) => {
              console.log(`\n📋 Directory User ${index + 1}:`);
              console.log(`  ID: ${user.id}`);
              console.log(`  Name: ${user.name?.fullName || 'No name'}`);
              console.log(`  Email: ${user.primaryEmail}`);
              console.log(`  Given Name: ${user.name?.givenName || 'N/A'}`);
              console.log(`  Family Name: ${user.name?.familyName || 'N/A'}`);
              console.log(`  Is Admin: ${user.isAdmin || false}`);
              console.log(`  Is Delegated Admin: ${user.isDelegatedAdmin || false}`);
              console.log(`  Last Login: ${user.lastLoginTime || 'Never'}`);
              console.log(`  Creation Time: ${user.creationTime || 'Unknown'}`);
              console.log(`  Suspended: ${user.suspended || false}`);
              console.log(`  Org Unit Path: ${user.orgUnitPath || 'N/A'}`);
              
              if (user.organizations && user.organizations.length > 0) {
                console.log(`  Organizations: ${user.organizations.map(org => org.title).join(', ')}`);
              }
              
              if (user.phones && user.phones.length > 0) {
                console.log(`  Phones: ${user.phones.map(phone => phone.value).join(', ')}`);
              }
              
              console.log(`  Full Directory Object:`, JSON.stringify(user, null, 4));
            });
          }
          
        } catch (error) {
          console.log('❌ Organization directory access failed:', error.message);
        }
      } else {
        console.log('\n⏭️ Skipping organization directory access due to insufficient privileges');
      }

      console.log('\n' + '='.repeat(60));
      console.log('👤 TESTING PEOPLE API WITH CHAT MEMBERS');
      console.log('='.repeat(60));
      
      // Get spaces to test member name resolution
      const spacesResponse = await chatClient.spaces.list({ pageSize: 3 });
      
      if (!spacesResponse.data.spaces || spacesResponse.data.spaces.length === 0) {
        console.log('❌ No spaces available to test member name resolution');
        return;
      }

      // Test member name resolution for first space
      const space = spacesResponse.data.spaces[0];
      console.log(`\n🏠 Testing member names for space: ${space.displayName || space.name}`);
      
      try {
        const membersResponse = await chatClient.spaces.members.list({
          parent: space.name,
          pageSize: 5 // Limit to 5 members for testing
        });
        
        if (membersResponse.data.memberships && membersResponse.data.memberships.length > 0) {
          console.log(`\n👥 Found ${membersResponse.data.memberships.length} members. Fetching names...`);
          
          for (const [index, membership] of membersResponse.data.memberships.entries()) {
            console.log(`\n--- MEMBER ${index + 1} DETAILS ---`);
            console.log(`Membership Name: ${membership.name}`);
            console.log(`Member ID: ${membership.member?.name || 'Unknown'}`);
            console.log(`Member Type: ${membership.member?.type || 'Unknown'}`);
            console.log(`Role: ${membership.role}`);
            console.log(`State: ${membership.state}`);
            
            // Try to get user details using People API
            if (membership.member?.name && membership.member.type === 'HUMAN') {
              try {
                console.log(`\n🔍 Fetching user details for: ${membership.member.name}`);
                const userDetails = await this.googleAuth.fetchUserDetails(tokens, membership.member.name);
                
                console.log('✅ People API Response:');
                if (userDetails.names && userDetails.names.length > 0) {
                  const name = userDetails.names[0];
                  console.log(`  Display Name: ${name.displayName || 'N/A'}`);
                  console.log(`  Given Name: ${name.givenName || 'N/A'}`);
                  console.log(`  Family Name: ${name.familyName || 'N/A'}`);
                }
                
                if (userDetails.emailAddresses && userDetails.emailAddresses.length > 0) {
                  const emails = userDetails.emailAddresses.map(email => email.value).join(', ');
                  console.log(`  Email Addresses: ${emails}`);
                }
                
                if (userDetails.organizations && userDetails.organizations.length > 0) {
                  const orgs = userDetails.organizations.map(org => org.name).join(', ');
                  console.log(`  Organizations: ${orgs}`);
                }
                
                if (userDetails.phoneNumbers && userDetails.phoneNumbers.length > 0) {
                  const phones = userDetails.phoneNumbers.map(phone => phone.value).join(', ');
                  console.log(`  Phone Numbers: ${phones}`);
                }
                
                console.log(`  Full People API Object:`, JSON.stringify(userDetails, null, 4));
                
              } catch (peopleError) {
                console.log(`❌ Failed to fetch user details: ${peopleError.message}`);
              }
            } else {
              console.log('⏭️ Skipping non-human member or invalid member ID');
            }
            
            // Add separator
            console.log('-'.repeat(50));
          }
          
        } else {
          console.log('❌ No members found in this space');
        }
        
      } catch (error) {
        console.log(`❌ Error fetching members: ${error.message}`);
      }
      
    } catch (error) {
      console.log('❌ Error in People API testing:', error.message);
    }  }

  // Test Direct Message Spaces and get member names using People API
  async testDirectMessageMembersWithNames(chatClient, tokens) {
    try {
      console.log('🔍 Fetching all direct message spaces and their members...');
      
      // Get all spaces first
      console.log('📝 Fetching all spaces...');
      let allSpaces = [];
      let nextPageToken = null;
      
      do {
        const spacesResponse = await chatClient.spaces.list({
          pageSize: 100,
          pageToken: nextPageToken
        });
        
        if (spacesResponse.data.spaces) {
          allSpaces = allSpaces.concat(spacesResponse.data.spaces);
        }
        
        nextPageToken = spacesResponse.data.nextPageToken;
      } while (nextPageToken);
      
      console.log(`\n📊 TOTAL SPACES FOUND: ${allSpaces.length}`);
      
      // Filter for direct message spaces
      const directMessageSpaces = allSpaces.filter(space => 
        space.spaceType === 'DIRECT_MESSAGE'
      );
      
      console.log(`📱 DIRECT MESSAGE SPACES: ${directMessageSpaces.length}`);
      
      if (directMessageSpaces.length === 0) {
        console.log('❌ No direct message spaces found');
        return;
      }

      console.log('\n' + '='.repeat(80));
      console.log('👥 FETCHING MEMBERS AND NAMES FOR ALL DIRECT MESSAGE SPACES');
      console.log('='.repeat(80));
      
      let totalMembersFound = 0;
      let totalNamesResolved = 0;
      const uniqueUsers = new Set();
      const userDetails = new Map();
      
      // Process each direct message space
      for (const [index, space] of directMessageSpaces.entries()) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`💬 DM SPACE ${index + 1}/${directMessageSpaces.length}: ${space.name}`);
        console.log(`${'='.repeat(60)}`);
        console.log('Space URI:', space.spaceUri || 'N/A');
        console.log('Last Active:', space.lastActiveTime || 'Unknown');
        
        try {
          // Get members of this direct message space
          const membersResponse = await chatClient.spaces.members.list({
            parent: space.name,
            pageSize: 10 // DM spaces typically have 2 members
          });
          
          if (membersResponse.data.memberships && membersResponse.data.memberships.length > 0) {
            console.log(`\n👥 Found ${membersResponse.data.memberships.length} members:`);
            
            for (const [memberIndex, membership] of membersResponse.data.memberships.entries()) {
              const memberId = membership.member?.name;
              const memberType = membership.member?.type;
              
              console.log(`\n  👤 Member ${memberIndex + 1}:`);
              console.log(`     ID: ${memberId || 'Unknown'}`);
              console.log(`     Type: ${memberType || 'Unknown'}`);
              console.log(`     Role: ${membership.role || 'Unknown'}`);
              console.log(`     State: ${membership.state || 'Unknown'}`);
              
              totalMembersFound++;
              
              // Try to get user details using People API for human members
              if (memberId && memberType === 'HUMAN') {
                uniqueUsers.add(memberId);
                
                // Check if we already have details for this user
                if (userDetails.has(memberId)) {
                  const cachedDetails = userDetails.get(memberId);
                  console.log(`     ✅ Name: ${cachedDetails.displayName || 'N/A'} (cached)`);
                  console.log(`     📧 Email: ${cachedDetails.email || 'N/A'}`);
                } else {
                  try {
                    console.log(`     🔍 Fetching user details from People API...`);
                    const personDetails = await this.googleAuth.fetchUserDetails(tokens, memberId);
                    
                    let displayName = 'N/A';
                    let email = 'N/A';
                    
                    if (personDetails.names && personDetails.names.length > 0) {
                      displayName = personDetails.names[0].displayName || 'N/A';
                    }
                    
                    if (personDetails.emailAddresses && personDetails.emailAddresses.length > 0) {
                      email = personDetails.emailAddresses[0].value || 'N/A';
                    }
                    
                    // Cache the details
                    userDetails.set(memberId, { displayName, email, fullData: personDetails });
                    
                    console.log(`     ✅ Name: ${displayName}`);
                    console.log(`     📧 Email: ${email}`);
                    
                    if (personDetails.organizations && personDetails.organizations.length > 0) {
                      console.log(`     🏢 Organization: ${personDetails.organizations[0].name || 'N/A'}`);
                    }
                    
                    totalNamesResolved++;
                    
                  } catch (peopleError) {
                    console.log(`     ❌ Failed to fetch user details: ${peopleError.message}`);
                    userDetails.set(memberId, { displayName: 'Error', email: 'Error', error: peopleError.message });
                  }
                }
              } else if (memberType === 'BOT') {
                console.log(`     🤖 Bot member - skipping People API call`);
              } else {
                console.log(`     ⏭️ Skipping non-human member`);
              }
            }
            
          } else {
            console.log('❌ No members found in this space');
          }
          
        } catch (error) {
          console.log(`❌ Error fetching members for space ${space.name}: ${error.message}`);
        }
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Summary
      console.log('\n' + '='.repeat(80));
      console.log('📊 DIRECT MESSAGE MEMBERS SUMMARY');
      console.log('='.repeat(80));
      console.log(`Total DM spaces processed: ${directMessageSpaces.length}`);
      console.log(`Total members found: ${totalMembersFound}`);
      console.log(`Unique users discovered: ${uniqueUsers.size}`);
      console.log(`Names successfully resolved: ${totalNamesResolved}`);
      
      // Display all unique users with their details
      if (userDetails.size > 0) {
        console.log('\n' + '='.repeat(60));
        console.log('👥 ALL UNIQUE USERS FOUND IN DIRECT MESSAGES:');
        console.log('='.repeat(60));
        
        let userCount = 0;
        for (const [userId, details] of userDetails.entries()) {
          userCount++;
          console.log(`\n${userCount}. User ID: ${userId}`);
          console.log(`   Name: ${details.displayName || 'N/A'}`);
          console.log(`   Email: ${details.email || 'N/A'}`);
          if (details.error) {
            console.log(`   Error: ${details.error}`);
          }
        }
      }
      
    } catch (error) {
      console.log('❌ Error in Direct Message Members testing:', error.message);
    }
  }

  async testDirectMessageSpaces(chatClient) {
    try {
      logger.info('🔍 Testing Direct Message Spaces...');
      
      const targetUserId = 'users/116152071271346193304';
      console.log(`🎯 Filtering messages for user: ${targetUserId}`);
      
      // Get all spaces first
      logger.info('📝 Fetching all spaces...');
      let allSpaces = [];
      let nextPageToken = null;
      
      do {
        const spacesResponse = await chatClient.spaces.list({
          pageSize: 100,
          pageToken: nextPageToken
        });
        
        if (spacesResponse.data.spaces) {
          allSpaces = allSpaces.concat(spacesResponse.data.spaces);
        }
        
        nextPageToken = spacesResponse.data.nextPageToken;
      } while (nextPageToken);
      
      console.log(`\n📊 TOTAL SPACES FOUND: ${allSpaces.length}`);
      
      // Filter for direct message spaces
      const directMessageSpaces = allSpaces.filter(space => 
        space.spaceType === 'DIRECT_MESSAGE'
      );
      
      console.log(`📱 DIRECT MESSAGE SPACES: ${directMessageSpaces.length}`);
      
      if (directMessageSpaces.length === 0) {
        console.log('❌ No direct message spaces found');
        return;
      }
      
      let processedSpaces = 0;
      let spacesWithTargetUserMessages = 0;
      
      // Process each direct message space
      for (const [index, space] of directMessageSpaces.entries()) {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`💬 DIRECT MESSAGE SPACE ${index + 1}/${directMessageSpaces.length}`);
        console.log(`${'='.repeat(80)}`);
        console.log('Space Name:', space.name);
        console.log('Space Type:', space.spaceType);
        console.log('Type:', space.type);
        console.log('Single User Bot DM:', space.singleUserBotDm || false);
        console.log('Last Active Time:', space.lastActiveTime || 'Unknown');
        console.log('Membership Count:', space.membershipCount?.joinedDirectHumanUserCount || 0);
        console.log('Space URI:', space.spaceUri || 'N/A');
        
        // Get messages from target user only
        try {
          console.log(`\n📨 FETCHING MESSAGES FROM USER: ${targetUserId}...`);
          
          let targetUserMessages = [];
          let nextPageToken = null;
          let pageCount = 0;
          
          // Paginate through all messages to find ones from target user
          do {
            pageCount++;
            const messagesResponse = await chatClient.spaces.messages.list({
              parent: space.name,
              pageSize: 100,
              pageToken: nextPageToken,
              orderBy: 'createTime asc'
            });
            
            if (messagesResponse.data.messages) {
              // Filter messages from target user
              const userMessages = messagesResponse.data.messages.filter(message => 
                message.sender?.name === targetUserId
              );
              
              targetUserMessages = targetUserMessages.concat(userMessages);
              
              // Stop if we have 5 messages from target user
              if (targetUserMessages.length >= 5) {
                targetUserMessages = targetUserMessages.slice(0, 5);
                break;
              }
            }
            
            nextPageToken = messagesResponse.data.nextPageToken;
          } while (nextPageToken && targetUserMessages.length < 5);
          
          if (targetUserMessages.length > 0) {
            spacesWithTargetUserMessages++;
            console.log(`\n📝 FIRST ${targetUserMessages.length} MESSAGES FROM TARGET USER:`);
            console.log('-'.repeat(60));
            
            targetUserMessages.forEach((message, msgIndex) => {
              console.log(`\nMessage ${msgIndex + 1}:`);
              console.log(`sender: ${message.sender?.name || 'Unknown'}`);
              console.log(`text: ${message.text || 'No text content'}`);
              console.log(`time: ${message.createTime || 'Unknown'}`);
              
              if (message.sender?.type) {
                console.log(`sender_type: ${message.sender.type}`);
              }
              if (message.annotations && message.annotations.length > 0) {
                console.log(`has_annotations: ${message.annotations.length} annotations`);
              }
              if (message.emojiReactionSummaries && message.emojiReactionSummaries.length > 0) {
                console.log(`reactions: ${message.emojiReactionSummaries.map(r => r.emoji?.unicode).join(', ')}`);
              }
            });
            
          } else {
            console.log(`❌ No messages found from user ${targetUserId} in this space`);
          }
          
        } catch (error) {
          console.log(`❌ Error fetching messages for space ${space.name}: ${error.message}`);
          if (error.code) console.log(`Error code: ${error.code}`);
        }
        
        processedSpaces++;
        console.log(`\n📊 Progress: ${processedSpaces}/${directMessageSpaces.length} spaces processed`);
      }
      
      // Summary
      console.log('\n' + '='.repeat(80));
      console.log('📈 DIRECT MESSAGE SUMMARY');
      console.log('='.repeat(80));
      console.log(`Total spaces found: ${allSpaces.length}`);
      console.log(`Direct message spaces: ${directMessageSpaces.length}`);
      console.log(`Processed spaces: ${processedSpaces}`);
      console.log(`Spaces with target user messages: ${spacesWithTargetUserMessages}`);
      console.log(`Target user: ${targetUserId}`);
      
      // Space type breakdown
      const spaceTypeCount = {};
      allSpaces.forEach(space => {
        const type = space.spaceType || 'Unknown';
        spaceTypeCount[type] = (spaceTypeCount[type] || 0) + 1;
      });
      
      console.log('\nSpace type breakdown:');
      Object.entries(spaceTypeCount).forEach(([type, count]) => {
        console.log(`  ${type}: ${count}`);
      });
      
    } catch (error) {
      logger.error('❌ Error testing Direct Message Spaces:', error);
      console.log('Error details:', error.message);
      if (error.code) console.log('Error code:', error.code);
    }
  }
}

// Run the test
async function runTest() {
  const tester = new ChatAPITester();
  await tester.testAllChatAPIs();
  
  console.log('\n' + '='.repeat(80));
  console.log('✅ CHAT API TESTING COMPLETED');
  console.log('='.repeat(80));
  
  process.exit(0);
}

// Run if called directly
if (require.main === module) {
  runTest().catch(error => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
}

module.exports = ChatAPITester;
