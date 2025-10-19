import { pushMessage, getLastMessages, clearHistory } from '../store.js';

const userId = 'test-user';
const guildId = 'test-guild';
const channelId = 'test-channel';

clearHistory({ userId, guildId, channelId });

for (let i = 1; i <= 25; i += 1) {
  pushMessage({
    userId,
    guildId,
    channelId,
    role: 'user',
    content: `message-${i}`
  });
}

const history = getLastMessages({ userId, guildId, channelId });

if (history.length !== 20) {
  console.error(`Expected 20 messages, found ${history.length}`);
  process.exit(1);
}

const expectedStart = 6;
const expectedMessages = Array.from({ length: 20 }, (_, idx) => `message-${expectedStart + idx}`);
const mismatchIndex = history.findIndex((entry, idx) => entry.content !== expectedMessages[idx]);

if (mismatchIndex !== -1) {
  console.error('History contents were not trimmed as expected.');
  process.exit(1);
}

clearHistory({ userId, guildId, channelId });

console.log('SQLite history trimming works as expected.');
process.exit(0);
