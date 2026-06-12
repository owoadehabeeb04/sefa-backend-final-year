const mongoose = require('mongoose');

const AssistantChat = require('../../src/models/AssistantChat');
const AssistantMessage = require('../../src/models/AssistantMessage');
const {
  buildActivePromptMessages,
  editUserMessage,
  regenerateAssistantMessage,
  searchAssistantChats,
} = require('../../src/services/assistant.service');

describe('assistant.service', () => {
  it('excludes superseded, cancelled, and failed assistant messages from active prompt context', async () => {
    const userId = new mongoose.Types.ObjectId();
    const chat = await AssistantChat.create({
      userId,
      title: 'Budget help',
      titleSource: 'auto',
      status: 'idle',
    });

    const [user1, assistant1, assistant2, assistant3, user2] = await AssistantMessage.create([
      {
        chatId: chat._id,
        userId,
        role: 'user',
        content: 'How am I doing this month?',
        status: 'completed',
      },
      {
        chatId: chat._id,
        userId,
        role: 'assistant',
        content: 'You are doing well.',
        status: 'completed',
        generatedFromMessageId: null,
      },
      {
        chatId: chat._id,
        userId,
        role: 'assistant',
        content: 'Old failed answer',
        status: 'failed',
        generatedFromMessageId: null,
      },
      {
        chatId: chat._id,
        userId,
        role: 'assistant',
        content: 'Old hidden answer',
        status: 'superseded',
        hiddenAt: new Date(),
        generatedFromMessageId: null,
      },
      {
        chatId: chat._id,
        userId,
        role: 'user',
        content: 'What should I cut?',
        status: 'completed',
      },
    ]);

    const activeMessages = await buildActivePromptMessages(chat._id, user2._id);

    expect(activeMessages.map((message) => message.content)).toEqual([
      user1.content,
      assistant1.content,
      user2.content,
    ]);
    expect(activeMessages.find((message) => message.content === assistant2.content)).toBeUndefined();
    expect(activeMessages.find((message) => message.content === assistant3.content)).toBeUndefined();
  });

  it('updates auto-generated title when the first user message is edited', async () => {
    const userId = new mongoose.Types.ObjectId();
    const chat = await AssistantChat.create({
      userId,
      title: 'First title',
      titleSource: 'auto',
      status: 'idle',
    });

    const [user1, assistant1] = await AssistantMessage.create([
      {
        chatId: chat._id,
        userId,
        role: 'user',
        content: 'Can I reduce transport cost?',
        status: 'completed',
      },
      {
        chatId: chat._id,
        userId,
        role: 'assistant',
        content: 'Maybe reduce ride frequency.',
        status: 'completed',
        generatedFromMessageId: null,
      },
    ]);

    await editUserMessage(userId, chat._id, user1._id, 'How can I save more on food this month?');

    const refreshedChat = await AssistantChat.findById(chat._id);
    const refreshedUserMessage = await AssistantMessage.findById(user1._id);

    expect(refreshedChat.title).toMatch(/How can I save more on food/i);
    expect(refreshedUserMessage.version).toBe(2);
    expect(refreshedUserMessage.previousVersions).toHaveLength(1);
  });

  it('searches chats by message body, not only by title', async () => {
    const userId = new mongoose.Types.ObjectId();

    const deepMatchChat = await AssistantChat.create({
      userId,
      title: 'Transport ideas',
      titleSource: 'auto',
      status: 'idle',
      lastMessageAt: new Date('2026-06-11T08:00:00.000Z'),
    });

    const titleOnlyChat = await AssistantChat.create({
      userId,
      title: 'Rainy day budget',
      titleSource: 'auto',
      status: 'idle',
      lastMessageAt: new Date('2026-06-11T07:00:00.000Z'),
    });

    await AssistantMessage.create([
      {
        chatId: deepMatchChat._id,
        userId,
        role: 'user',
        content: 'First question',
        status: 'completed',
        createdAt: new Date('2026-06-11T07:00:00.000Z'),
        updatedAt: new Date('2026-06-11T07:00:00.000Z'),
      },
      {
        chatId: deepMatchChat._id,
        userId,
        role: 'assistant',
        content: 'A normal answer',
        status: 'completed',
        createdAt: new Date('2026-06-11T07:05:00.000Z'),
        updatedAt: new Date('2026-06-11T07:05:00.000Z'),
      },
      {
        chatId: deepMatchChat._id,
        userId,
        role: 'user',
        content: 'Please remind me about rainy day savings goals in August',
        status: 'completed',
        createdAt: new Date('2026-06-11T07:10:00.000Z'),
        updatedAt: new Date('2026-06-11T07:10:00.000Z'),
      },
      {
        chatId: titleOnlyChat._id,
        userId,
        role: 'user',
        content: 'Another topic entirely',
        status: 'completed',
        createdAt: new Date('2026-06-11T06:40:00.000Z'),
        updatedAt: new Date('2026-06-11T06:40:00.000Z'),
      },
    ]);

    const result = await searchAssistantChats(userId, 'rainy day savings');

    expect(result.chats).toHaveLength(1);
    expect(result.chats[0].id).toBe(String(deepMatchChat._id));
    expect(result.chats[0].matchingMessageSnippet).toMatch(/rainy day savings goals/i);
  });

  it('regenerating an older assistant message reverts the conversation to that point', async () => {
    const userId = new mongoose.Types.ObjectId();
    const chat = await AssistantChat.create({
      userId,
      title: 'Trip budget',
      titleSource: 'auto',
      status: 'idle',
    });

    const user1 = await AssistantMessage.create({
      chatId: chat._id,
      userId,
      role: 'user',
      content: 'Help me plan my trip budget',
      status: 'completed',
    });

    const assistant1 = await AssistantMessage.create({
      chatId: chat._id,
      userId,
      role: 'assistant',
      content: 'Start with transport and lodging.',
      status: 'completed',
      generatedFromMessageId: user1._id,
      parentMessageId: user1._id,
    });

    const user2 = await AssistantMessage.create({
      chatId: chat._id,
      userId,
      role: 'user',
      content: 'What about feeding?',
      status: 'completed',
      parentMessageId: assistant1._id,
    });

    const assistant2 = await AssistantMessage.create({
      chatId: chat._id,
      userId,
      role: 'assistant',
      content: 'Use a daily meal cap.',
      status: 'completed',
      generatedFromMessageId: user2._id,
      parentMessageId: user2._id,
    });

    const result = await regenerateAssistantMessage(userId, chat._id, assistant1._id);

    const refreshedUser2 = await AssistantMessage.findById(user2._id);
    const refreshedAssistant2 = await AssistantMessage.findById(assistant2._id);
    const replacement = await AssistantMessage.findById(result.assistantMessage._id);

    expect(refreshedUser2.status).toBe('superseded');
    expect(refreshedUser2.hiddenAt).not.toBeNull();
    expect(refreshedUser2.supersededByMessageId?.toString()).toBe(String(replacement._id));

    expect(refreshedAssistant2.status).toBe('superseded');
    expect(refreshedAssistant2.hiddenAt).not.toBeNull();
    expect(refreshedAssistant2.supersededByMessageId?.toString()).toBe(String(replacement._id));

    expect(replacement.status).toBe('queued');
    expect(replacement.parentMessageId?.toString()).toBe(String(user1._id));
  });
});
