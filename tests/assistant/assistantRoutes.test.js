const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');

const AssistantChat = require('../../src/models/AssistantChat');
const AssistantMessage = require('../../src/models/AssistantMessage');

jest.mock('../../src/middleware/auth', () => ({
  authenticate: (req, res, next) => {
    const header = req.headers['x-user-id'];
    if (!header) {
      return res.status(401).json({ success: false, error: { message: 'Authentication required' } });
    }
    req.user = { userId: header, id: header, _id: header };
    req.authUser = { isVerified: true, onboardingCompleted: true };
    return next();
  },
  requireVerifiedEmail: (_req, _res, next) => next(),
  requireOnboardingComplete: (_req, _res, next) => next(),
}));

const assistantRoutes = require('../../src/routes/assistantRoutes');

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/assistant', assistantRoutes);
  return app;
};

describe('assistant routes', () => {
  it('creates a chat and starts assistant generation inline', async () => {
    const userId = new mongoose.Types.ObjectId();
    const response = await request(createApp())
      .post('/api/v1/assistant/chats')
      .set('x-user-id', String(userId))
      .send({ content: 'Can I still reach month end?' });

    expect(response.status).toBe(201);
    expect(response.body.data.messages).toHaveLength(2);
    expect(response.body.data.messages[1].status).toBe('queued');
  });

  it('does not let a user edit an assistant message', async () => {
    const userId = new mongoose.Types.ObjectId();
    const chat = await AssistantChat.create({
      userId,
      title: 'Budget help',
      titleSource: 'auto',
      status: 'idle',
    });
    const assistantMessage = await AssistantMessage.create({
      chatId: chat._id,
      userId,
      role: 'assistant',
      content: 'A previous answer',
      status: 'completed',
    });

    const response = await request(createApp())
      .patch(`/api/v1/assistant/chats/${chat._id}/messages/${assistantMessage._id}`)
      .set('x-user-id', String(userId))
      .send({ content: 'Edit this' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/only user messages/i);
  });

  it('does not let another user edit a message they do not own', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const otherUserId = new mongoose.Types.ObjectId();
    const chat = await AssistantChat.create({
      userId: ownerId,
      title: 'Budget help',
      titleSource: 'auto',
      status: 'idle',
    });
    const userMessage = await AssistantMessage.create({
      chatId: chat._id,
      userId: ownerId,
      role: 'user',
      content: 'Original question',
      status: 'completed',
    });

    const response = await request(createApp())
      .patch(`/api/v1/assistant/chats/${chat._id}/messages/${userMessage._id}`)
      .set('x-user-id', String(otherUserId))
      .send({ content: 'Edited question' });

    expect(response.status).toBe(404);
  });

  it('editing the latest user message creates a new assistant response placeholder', async () => {
    const userId = new mongoose.Types.ObjectId();
    const chat = await AssistantChat.create({
      userId,
      title: 'Budget help',
      titleSource: 'auto',
      status: 'idle',
    });
    const [userMessage, assistantMessage] = await AssistantMessage.create([
      {
        chatId: chat._id,
        userId,
        role: 'user',
        content: 'Old question',
        status: 'completed',
      },
      {
        chatId: chat._id,
        userId,
        role: 'assistant',
        content: 'Old answer',
        status: 'completed',
      },
    ]);

    const response = await request(createApp())
      .patch(`/api/v1/assistant/chats/${chat._id}/messages/${userMessage._id}`)
      .set('x-user-id', String(userId))
      .send({ content: 'Updated question' });

    expect(response.status).toBe(200);
    const refreshedAssistant = await AssistantMessage.findById(assistantMessage._id);
    expect(refreshedAssistant.status).toBe('superseded');
    expect(response.body.data.assistantMessage.status).toBe('queued');
  });

  it('editing an earlier message supersedes later messages', async () => {
    const userId = new mongoose.Types.ObjectId();
    const chat = await AssistantChat.create({
      userId,
      title: 'Budget help',
      titleSource: 'auto',
      status: 'idle',
    });

    const [firstUser, firstAssistant, secondUser, secondAssistant] = await AssistantMessage.create([
      {
        chatId: chat._id,
        userId,
        role: 'user',
        content: 'First question',
        status: 'completed',
      },
      {
        chatId: chat._id,
        userId,
        role: 'assistant',
        content: 'First answer',
        status: 'completed',
      },
      {
        chatId: chat._id,
        userId,
        role: 'user',
        content: 'Second question',
        status: 'completed',
      },
      {
        chatId: chat._id,
        userId,
        role: 'assistant',
        content: 'Second answer',
        status: 'completed',
      },
    ]);

    const response = await request(createApp())
      .patch(`/api/v1/assistant/chats/${chat._id}/messages/${firstUser._id}`)
      .set('x-user-id', String(userId))
      .send({ content: 'Rewritten first question' });

    expect(response.status).toBe(200);
    const refreshedSecondUser = await AssistantMessage.findById(secondUser._id);
    const refreshedSecondAssistant = await AssistantMessage.findById(secondAssistant._id);
    expect(refreshedSecondUser.status).toBe('superseded');
    expect(refreshedSecondAssistant.status).toBe('superseded');
  });

  it('regenerate creates a new queued assistant placeholder', async () => {
    const userId = new mongoose.Types.ObjectId();
    const chat = await AssistantChat.create({
      userId,
      title: 'Budget help',
      titleSource: 'auto',
      status: 'idle',
    });
    const [userMessage, assistantMessage] = await AssistantMessage.create([
      {
        chatId: chat._id,
        userId,
        role: 'user',
        content: 'How am I doing?',
        status: 'completed',
      },
      {
        chatId: chat._id,
        userId,
        role: 'assistant',
        content: 'Doing okay.',
        status: 'completed',
        generatedFromMessageId: null,
      },
    ]);
    assistantMessage.generatedFromMessageId = userMessage._id;
    await assistantMessage.save();

    const response = await request(createApp())
      .post(`/api/v1/assistant/chats/${chat._id}/messages/${assistantMessage._id}/regenerate`)
      .set('x-user-id', String(userId));

    expect(response.status).toBe(200);
    expect(response.body.data.assistantMessage.status).toBe('queued');
    const updatedOld = await AssistantMessage.findById(assistantMessage._id);
    expect(updatedOld.status).toBe('superseded');
  });

  it('retry queues a replacement for a failed assistant response', async () => {
    const userId = new mongoose.Types.ObjectId();
    const chat = await AssistantChat.create({
      userId,
      title: 'Budget help',
      titleSource: 'auto',
      status: 'failed',
    });
    const userMessage = await AssistantMessage.create({
      chatId: chat._id,
      userId,
      role: 'user',
      content: 'What can I cut?',
      status: 'completed',
    });
    const failedMessage = await AssistantMessage.create({
      chatId: chat._id,
      userId,
      role: 'assistant',
      content: '',
      status: 'failed',
      generatedFromMessageId: userMessage._id,
    });

    const response = await request(createApp())
      .post(`/api/v1/assistant/chats/${chat._id}/messages/${failedMessage._id}/retry`)
      .set('x-user-id', String(userId));

    expect(response.status).toBe(200);
    expect(response.body.data.assistantMessage.status).toBe('queued');
  });

  it('searches chats by title and message content without leaking other users results', async () => {
    const userId = new mongoose.Types.ObjectId();
    const otherUserId = new mongoose.Types.ObjectId();

    const firstChat = await AssistantChat.create({
      userId,
      title: 'Food budget plan',
      titleSource: 'manual',
      status: 'idle',
      lastMessageAt: new Date(),
    });
    const secondChat = await AssistantChat.create({
      userId,
      title: 'General chat',
      titleSource: 'auto',
      status: 'idle',
      lastMessageAt: new Date(),
    });
    await AssistantChat.create({
      userId: otherUserId,
      title: 'Hidden match',
      titleSource: 'auto',
      status: 'idle',
      lastMessageAt: new Date(),
    });

    await AssistantMessage.create([
      {
        chatId: firstChat._id,
        userId,
        role: 'user',
        content: 'Help me reduce food spending',
        status: 'completed',
      },
      {
        chatId: secondChat._id,
        userId,
        role: 'assistant',
        content: 'Your food budget could improve',
        status: 'completed',
      },
      {
        chatId: firstChat._id,
        userId: otherUserId,
        role: 'user',
        content: 'This should never be visible',
        status: 'completed',
      },
    ]);

    const response = await request(createApp())
      .get('/api/v1/assistant/chats/search?q=food')
      .set('x-user-id', String(userId));

    expect(response.status).toBe(200);
    expect(response.body.data.chats.length).toBeGreaterThanOrEqual(1);
    expect(response.body.data.chats.every((chat) => chat.title !== 'Hidden match')).toBe(true);
  });

  it('cancels a generating assistant response safely', async () => {
    const userId = new mongoose.Types.ObjectId();
    const chat = await AssistantChat.create({
      userId,
      title: 'Budget help',
      titleSource: 'auto',
      status: 'generating',
    });
    const generatingMessage = await AssistantMessage.create({
      chatId: chat._id,
      userId,
      role: 'assistant',
      content: '',
      status: 'generating',
      jobId: 'assistant-job-1',
    });

    const response = await request(createApp())
      .post(`/api/v1/assistant/chats/${chat._id}/messages/${generatingMessage._id}/cancel`)
      .set('x-user-id', String(userId));

    expect(response.status).toBe(200);
    const refreshed = await AssistantMessage.findById(generatingMessage._id);
    expect(refreshed.status).toBe('cancelled');
  });
});
