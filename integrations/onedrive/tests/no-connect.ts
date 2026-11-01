// Imported first by every test file so importing server.ts never opens the stdio MCP transport.
process.env.ONEDRIVE_TEST_NO_CONNECT = "1";
