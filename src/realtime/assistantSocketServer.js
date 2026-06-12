const { URL } = require('url');
const jwt = require('jsonwebtoken');
const { WebSocketServer, WebSocket } = require('ws');

const User = require('../models/User');
const {
  cancelAssistantMessage,
  commitStreamedAssistantInput,
  createAssistantChatShell,
  formatAssistantChat,
  formatAssistantMessage,
  startPreparedAssistantGeneration,
} = require('../services/assistant.service');

const sessions = new WeakMap();

const parseJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
};

const sendEvent = (socket, type, payload = {}) => {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type,
    ...payload,
  }));
};

const authenticateRequest = async (request) => {
  const base = `http://${request.headers.host || 'localhost'}`;
  const url = new URL(request.url, base);
  const token = String(url.searchParams.get('token') || '').trim();

  if (!token) {
    throw new Error('Missing websocket auth token');
  }

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  const user = await User.findById(decoded.userId).select('tokenVersion isVerified onboardingCompleted');
  if (!user) {
    throw new Error('User not found');
  }
  const tokenVersion = typeof decoded.tokenVersion === 'number' ? decoded.tokenVersion : 0;
  if (tokenVersion !== (user.tokenVersion || 0)) {
    throw new Error('Session expired');
  }
  if (!user.isVerified) {
    throw new Error('Email verification required');
  }
  if (!user.onboardingCompleted) {
    throw new Error('Onboarding completion required');
  }

  return {
    userId: String(user._id),
    initialChatId: url.searchParams.get('chatId') || null,
  };
};

const bindSocketHandlers = (socket, authState) => {
  const state = {
    userId: authState.userId,
    chatId: authState.initialChatId,
    draft: '',
    activeAssistantMessageId: null,
  };
  sessions.set(socket, state);

  sendEvent(socket, 'session.ready', {
    chatId: state.chatId,
  });

  socket.on('message', async (raw) => {
    const event = parseJson(String(raw || ''));
    if (!event?.type) {
      sendEvent(socket, 'assistant.error', { message: 'Invalid websocket event' });
      return;
    }

    try {
      if (event.type === 'ping') {
        sendEvent(socket, 'pong', { timestamp: new Date().toISOString() });
        return;
      }

      if (event.type === 'session.start') {
        if (typeof event.chatId === 'string' && event.chatId.trim()) {
          state.chatId = event.chatId.trim();
        }
        sendEvent(socket, 'session.ready', { chatId: state.chatId });
        return;
      }

      if (event.type === 'input.cancel') {
        state.draft = '';
        sendEvent(socket, 'input.ack', { draftLength: 0, cleared: true });
        return;
      }

      if (event.type === 'input.append') {
        const chunk = String(event.chunk || '');
        if (!chunk) {
          sendEvent(socket, 'input.ack', { draftLength: state.draft.length });
          return;
        }
        state.draft += chunk;
        sendEvent(socket, 'input.ack', { draftLength: state.draft.length });
        return;
      }

      if (event.type === 'assistant.cancel') {
        const targetMessageId = String(event.messageId || state.activeAssistantMessageId || '');
        if (!targetMessageId || !state.chatId) {
          sendEvent(socket, 'assistant.error', { message: 'No active assistant response to cancel' });
          return;
        }

        await cancelAssistantMessage(state.userId, state.chatId, targetMessageId);
        state.activeAssistantMessageId = null;
        sendEvent(socket, 'assistant.cancelled', {
          chatId: state.chatId,
          assistantMessageId: targetMessageId,
        });
        return;
      }

      if (event.type === 'input.commit') {
        const payloadContent = typeof event.content === 'string' ? event.content : state.draft;
        const content = String(payloadContent || '').trim();
        if (!content) {
          sendEvent(socket, 'assistant.error', { message: 'Message is required' });
          return;
        }

        if (!state.chatId && typeof event.chatId === 'string' && event.chatId.trim()) {
          state.chatId = event.chatId.trim();
        }

        const result = await commitStreamedAssistantInput({
          userId: state.userId,
          chatId: state.chatId,
          content,
          startGeneration: false,
          onDelta: async (deltaEvent) => {
            state.activeAssistantMessageId = deltaEvent.assistantMessageId;
            sendEvent(socket, deltaEvent.isFinal ? 'assistant.done' : 'assistant.delta', deltaEvent);
          },
        });

        const createdNewChat = !state.chatId || state.chatId !== String(result.chat._id);
        state.chatId = String(result.chat._id);
        state.draft = '';
        state.activeAssistantMessageId = String(result.assistantMessage._id);

        if (createdNewChat) {
          sendEvent(socket, 'chat.created', {
            chat: formatAssistantChat(result.chat, result.userMessage || result.assistantMessage),
            userMessage: formatAssistantMessage(result.userMessage),
            assistantMessage: formatAssistantMessage(result.assistantMessage),
          });
        }

        sendEvent(socket, 'message.saved', {
          chatId: state.chatId,
          userMessage: formatAssistantMessage(result.userMessage),
          assistantMessage: formatAssistantMessage(result.assistantMessage),
        });

        sendEvent(socket, 'assistant.started', {
          chatId: state.chatId,
          assistantMessageId: state.activeAssistantMessageId,
        });

        startPreparedAssistantGeneration({
          chat: result.chat,
          assistantMessage: result.assistantMessage,
          sourceMessage: result.userMessage,
          onDelta: async (deltaEvent) => {
            state.activeAssistantMessageId = deltaEvent.assistantMessageId;
            sendEvent(socket, deltaEvent.isFinal ? 'assistant.done' : 'assistant.delta', deltaEvent);
          },
        });
        return;
      }

      if (event.type === 'chat.create') {
        const chat = await createAssistantChatShell(state.userId, String(event.seed || ''));
        state.chatId = String(chat._id);
        sendEvent(socket, 'chat.created', {
          chat: formatAssistantChat(chat),
        });
        return;
      }

      sendEvent(socket, 'assistant.error', { message: `Unsupported event type: ${event.type}` });
    } catch (error) {
      sendEvent(socket, 'assistant.error', {
        message: error.message || 'Assistant websocket request failed',
      });
    }
  });
};

const attachAssistantSocketServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request, socket, head) => {
    if (!request.url?.startsWith('/api/v1/assistant/ws')) {
      return;
    }

    try {
      const authState = await authenticateRequest(request);
      wss.handleUpgrade(request, socket, head, (ws) => {
        bindSocketHandlers(ws, authState);
      });
    } catch (error) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  return wss;
};

module.exports = {
  attachAssistantSocketServer,
};
