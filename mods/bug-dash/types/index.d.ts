export type ClaudeStatus = 'idle' | 'working' | 'finished' | 'needsYou'

declare module 'claude-code' {
  interface PluginState {
    'bug-dash': { claude: ClaudeStatus; shown: boolean }
  }
}
