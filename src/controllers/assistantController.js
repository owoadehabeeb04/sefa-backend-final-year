const { successResponse, errorResponse } = require('../utils/response');
const {
  archiveChat,
  cancelAssistantMessage,
  createChatWithFirstMessage,
  editUserMessage,
  formatAssistantChat,
  formatAssistantMessage,
  getAssistantChatDetail,
  getOwnedChat,
  listAssistantChats,
  regenerateAssistantMessage,
  renameOrArchiveChat,
  retryFailedAssistantMessage,
  searchAssistantChats,
  sendMessageToChat,
} = require('../services/assistant.service');
const { subscribeToAssistantChatEvents } = require('../services/assistantEvents.service');

const toStatusCode = (message = '') => {
  if (/not found/i.test(message)) return 404;
  if (/cannot|only|required|archived/i.test(message)) return 400;
  return 500;
};

const sendSseEvent = (res, type, payload) => {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

exports.createChat = async (req, res) => {
  try {
    const content = String(req.body?.content || '').trim();
    const result = await createChatWithFirstMessage(req.user.userId, content);
    return successResponse(
      res,
      {
        chat: result.chat
          ? formatAssistantChat(
            result.chat,
            [...result.messages].reverse().find((message) => String(message.content || '').trim()) || result.messages[result.messages.length - 1] || null,
          )
          : null,
        messages: result.messages.map(formatAssistantMessage),
      },
      'Assistant chat created successfully',
      201,
    );
  } catch (error) {
    const statusCode = toStatusCode(error.message);
    if (statusCode >= 500) console.error('Create assistant chat error:', error);
    return errorResponse(res, error.message || 'Failed to create assistant chat', statusCode);
  }
};

exports.listChats = async (req, res) => {
  try {
    const result = await listAssistantChats(req.user.userId, req.query);
    return successResponse(res, result, 'Assistant chats retrieved successfully');
  } catch (error) {
    console.error('List assistant chats error:', error);
    return errorResponse(res, 'Failed to retrieve assistant chats', 500);
  }
};

exports.searchChats = async (req, res) => {
  try {
    const result = await searchAssistantChats(req.user.userId, req.query.q);
    return successResponse(res, result, 'Assistant chats search completed successfully');
  } catch (error) {
    console.error('Search assistant chats error:', error);
    return errorResponse(res, 'Failed to search assistant chats', 500);
  }
};

exports.getChat = async (req, res) => {
  try {
    const result = await getAssistantChatDetail(req.user.userId, req.params.chatId);
    return successResponse(res, result, 'Assistant chat retrieved successfully');
  } catch (error) {
    const statusCode = toStatusCode(error.message);
    if (statusCode >= 500) console.error('Get assistant chat error:', error);
    return errorResponse(res, error.message || 'Failed to retrieve assistant chat', statusCode);
  }
};

exports.streamChat = async (req, res) => {
  try {
    const chat = await getOwnedChat(req.user.userId, req.params.chatId);
    if (!chat) {
      return errorResponse(res, 'Assistant chat not found', 404);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sendSseEvent(res, 'ready', {
      chatId: String(chat._id),
      status: chat.status,
    });

    const unsubscribe = subscribeToAssistantChatEvents(chat._id, (event) => {
      sendSseEvent(res, event.type || 'message.updated', event);
    });

    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  } catch (error) {
    console.error('Stream assistant chat error:', error);
    if (!res.headersSent) {
      return errorResponse(res, 'Failed to open assistant stream', 500);
    }
    res.end();
  }
};

exports.updateChat = async (req, res) => {
  try {
    const chat = await renameOrArchiveChat(req.user.userId, req.params.chatId, req.body || {});
    return successResponse(res, {
      chat: formatAssistantChat(chat),
    }, 'Assistant chat updated successfully');
  } catch (error) {
    const statusCode = toStatusCode(error.message);
    if (statusCode >= 500) console.error('Update assistant chat error:', error);
    return errorResponse(res, error.message || 'Failed to update assistant chat', statusCode);
  }
};

exports.deleteChat = async (req, res) => {
  try {
    await archiveChat(req.user.userId, req.params.chatId);
    return successResponse(res, {}, 'Assistant chat archived successfully');
  } catch (error) {
    const statusCode = toStatusCode(error.message);
    if (statusCode >= 500) console.error('Delete assistant chat error:', error);
    return errorResponse(res, error.message || 'Failed to archive assistant chat', statusCode);
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const result = await sendMessageToChat(req.user.userId, req.params.chatId, req.body?.content);
    return successResponse(res, {
      userMessage: formatAssistantMessage(result.userMessage),
      assistantMessage: formatAssistantMessage(result.assistantMessage),
    }, 'Assistant message queued successfully', 201);
  } catch (error) {
    const statusCode = toStatusCode(error.message);
    if (statusCode >= 500) console.error('Send assistant message error:', error);
    return errorResponse(res, error.message || 'Failed to send assistant message', statusCode);
  }
};

exports.editMessage = async (req, res) => {
  try {
    const result = await editUserMessage(
      req.user.userId,
      req.params.chatId,
      req.params.messageId,
      req.body?.content,
    );

    return successResponse(res, {
      message: result.editedMessage ? formatAssistantMessage(result.editedMessage) : null,
      assistantMessage: result.assistantMessage ? formatAssistantMessage(result.assistantMessage) : null,
    }, 'Assistant message edited successfully');
  } catch (error) {
    const statusCode = toStatusCode(error.message);
    if (statusCode >= 500) console.error('Edit assistant message error:', error);
    return errorResponse(res, error.message || 'Failed to edit assistant message', statusCode);
  }
};

exports.regenerateMessage = async (req, res) => {
  try {
    const result = await regenerateAssistantMessage(req.user.userId, req.params.chatId, req.params.messageId);
    return successResponse(res, {
      assistantMessage: formatAssistantMessage(result.assistantMessage),
    }, 'Assistant response regeneration queued successfully');
  } catch (error) {
    const statusCode = toStatusCode(error.message);
    if (statusCode >= 500) console.error('Regenerate assistant message error:', error);
    return errorResponse(res, error.message || 'Failed to regenerate assistant response', statusCode);
  }
};

exports.retryMessage = async (req, res) => {
  try {
    const result = await retryFailedAssistantMessage(req.user.userId, req.params.chatId, req.params.messageId);
    return successResponse(res, {
      assistantMessage: formatAssistantMessage(result.assistantMessage),
    }, 'Assistant response retry queued successfully');
  } catch (error) {
    const statusCode = toStatusCode(error.message);
    if (statusCode >= 500) console.error('Retry assistant message error:', error);
    return errorResponse(res, error.message || 'Failed to retry assistant response', statusCode);
  }
};

exports.cancelMessage = async (req, res) => {
  try {
    const message = await cancelAssistantMessage(req.user.userId, req.params.chatId, req.params.messageId);
    return successResponse(res, {
      assistantMessage: formatAssistantMessage(message),
    }, 'Assistant response cancelled successfully');
  } catch (error) {
    const statusCode = toStatusCode(error.message);
    if (statusCode >= 500) console.error('Cancel assistant message error:', error);
    return errorResponse(res, error.message || 'Failed to cancel assistant response', statusCode);
  }
};
