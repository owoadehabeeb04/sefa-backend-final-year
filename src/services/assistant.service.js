const AssistantChat = require('../models/AssistantChat');
const AssistantMessage = require('../models/AssistantMessage');
const { attachActionToMessage, planAssistantAction } = require('./assistantAction.service');
const { publishAssistantChatEvent } = require('./assistantEvents.service');
const {
  generateAssistantConversationTitle,
  generateAssistantTitle,
  streamAssistantCompletion,
} = require('./assistantGeneration.service');

const ACTIVE_GENERATION_STATUSES = new Set(['queued', 'generating', 'streaming']);
const TERMINAL_MESSAGE_STATUSES = new Set(['completed', 'failed', 'cancelled', 'superseded']);

const visibleMessageQuery = {
  $or: [
    { hiddenAt: null },
    { hiddenAt: { $exists: false } },
  ],
  status: { $ne: 'superseded' },
};

const toPreview = (content = '', max = 120) => {
  const safe = String(content || '').replace(/\s+/g, ' ').trim();
  if (safe.length <= max) return safe;
  return `${safe.slice(0, max - 1).trimEnd()}…`;
};

const escapeRegex = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const formatAssistantSources = (sources = []) => (Array.isArray(sources) ? sources : []).map((source) => ({
  title: source.title,
  url: source.url,
  sourceName: source.sourceName,
  priceText: source.priceText || null,
  numericPrice: Number.isFinite(Number(source.numericPrice)) ? Number(source.numericPrice) : null,
  currency: source.currency || null,
  snippet: source.snippet || null,
}));

const formatAssistantRetrieval = (retrieval = null) => {
  if (!retrieval) {
    return null;
  }

  return {
    mode: retrieval.mode || 'none',
    market: retrieval.market || 'NG',
    query: retrieval.query || '',
    status: retrieval.status || 'not_needed',
    providers: Array.isArray(retrieval.providers) ? retrieval.providers : [],
    sourceCount: Number(retrieval.sourceCount || 0),
    priceRangeSummary: retrieval.priceRangeSummary ? {
      low: Number.isFinite(Number(retrieval.priceRangeSummary.low)) ? Number(retrieval.priceRangeSummary.low) : null,
      high: Number.isFinite(Number(retrieval.priceRangeSummary.high)) ? Number(retrieval.priceRangeSummary.high) : null,
      median: Number.isFinite(Number(retrieval.priceRangeSummary.median)) ? Number(retrieval.priceRangeSummary.median) : null,
      currency: retrieval.priceRangeSummary.currency || null,
      sourceCount: Number(retrieval.priceRangeSummary.sourceCount || 0),
    } : null,
    reason: retrieval.reason || null,
  };
};

const formatAssistantActions = (actions = []) => (Array.isArray(actions) ? actions : []).map((action) => ({
  actionId: String(action.actionId || action._id || ''),
  id: String(action.actionId || action._id || ''),
  actionType: action.actionType,
  status: action.status,
  confirmationMessage: action.confirmationMessage,
  payload: action.payload || action.extractedPayload || {},
  missingFields: Array.isArray(action.missingFields) ? action.missingFields : [],
})).filter((action) => action.actionId);

const formatAssistantMessage = (message) => ({
  id: String(message._id),
  _id: message._id,
  chatId: String(message.chatId),
  role: message.role,
  content: message.content || '',
  status: message.status,
  isEdited: Boolean(message.isEdited),
  editedAt: message.editedAt || null,
  version: Number(message.version || 1),
  parentMessageId: message.parentMessageId ? String(message.parentMessageId) : null,
  supersededByMessageId: message.supersededByMessageId ? String(message.supersededByMessageId) : null,
  supersedesMessageId: message.supersedesMessageId ? String(message.supersedesMessageId) : null,
  generatedFromMessageId: message.generatedFromMessageId ? String(message.generatedFromMessageId) : null,
  errorMessage: message.errorMessage || null,
  sources: formatAssistantSources(message.sources || []),
  retrieval: formatAssistantRetrieval(message.retrieval || null),
  actions: formatAssistantActions(message.actions || []),
  completedAt: message.completedAt || null,
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
});

const formatAssistantChat = (chat, lastMessage = null, matchingMessageSnippet = null) => ({
  id: String(chat._id),
  _id: chat._id,
  title: chat.title,
  titleSource: chat.titleSource,
  status: chat.status,
  lastMessage: lastMessage ? toPreview(lastMessage.content || '') : '',
  lastMessageAt: chat.lastMessageAt || lastMessage?.createdAt || chat.updatedAt,
  matchingMessageSnippet: matchingMessageSnippet || null,
  archivedAt: chat.archivedAt || null,
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt,
});

const emitMessageEvent = (chatId, type, message) => {
  publishAssistantChatEvent(chatId, {
    type,
    message: formatAssistantMessage(message),
  });
};

const emitChatEvent = (chat, lastMessage = null) => {
  publishAssistantChatEvent(chat._id, {
    type: 'chat.updated',
    chat: formatAssistantChat(chat, lastMessage),
  });
};

const buildActivityEvent = ({ chatId, assistantMessageId, stage, label }) => ({
  type: 'assistant.activity',
  chatId: String(chatId),
  assistantMessageId: String(assistantMessageId),
  stage,
  label,
});

const getOwnedChat = async (userId, chatId) =>
  AssistantChat.findOne({
    _id: chatId,
    userId,
    deletedAt: null,
  });

const getOwnedMessage = async (userId, chatId, messageId) =>
  AssistantMessage.findOne({
    _id: messageId,
    chatId,
    userId,
  });

const getVisibleMessages = async (chatId) =>
  AssistantMessage.find({
    chatId,
    ...visibleMessageQuery,
  }).sort({ createdAt: 1, _id: 1 });

const getLatestVisibleMessagesByChat = async (chatIds = []) => {
  if (!chatIds.length) return new Map();

  const latestMessages = await AssistantMessage.aggregate([
    {
      $match: {
        chatId: { $in: chatIds },
        ...visibleMessageQuery,
      },
    },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $group: {
        _id: '$chatId',
        message: { $first: '$$ROOT' },
      },
    },
  ]);

  return new Map(latestMessages.map(({ _id, message }) => [String(_id), message]));
};

const refreshChatState = async (chatId) => {
  const chat = await AssistantChat.findById(chatId);
  if (!chat) return null;

  const visibleMessages = await getVisibleMessages(chatId);
  const lastVisibleMessage = visibleMessages[visibleMessages.length - 1] || null;
  const latestAssistant = [...visibleMessages].reverse().find((message) => message.role === 'assistant') || null;

  if (chat.archivedAt) {
    chat.status = 'archived';
  } else if (visibleMessages.some((message) => message.role === 'assistant' && ACTIVE_GENERATION_STATUSES.has(message.status))) {
    chat.status = 'generating';
  } else if (latestAssistant?.status === 'failed') {
    chat.status = 'failed';
  } else {
    chat.status = 'idle';
  }

  chat.lastVisibleMessageId = lastVisibleMessage?._id || null;
  chat.lastMessageAt = lastVisibleMessage?.createdAt || chat.lastMessageAt || chat.updatedAt;
  await chat.save();

  emitChatEvent(chat, lastVisibleMessage);
  return chat;
};

const createAssistantPlaceholder = async ({
  chatId,
  userId,
  sourceMessage,
  parentMessageId = null,
  supersedesMessageId = null,
}) => {
  const placeholder = await AssistantMessage.create({
    chatId,
    userId,
    role: 'assistant',
    content: '',
    status: 'queued',
    parentMessageId: parentMessageId || sourceMessage._id,
    generatedFromMessageId: sourceMessage._id,
    supersedesMessageId: supersedesMessageId || null,
  });

  if (supersedesMessageId) {
    await AssistantMessage.findByIdAndUpdate(supersedesMessageId, {
      supersededByMessageId: placeholder._id,
    });
  }

  emitMessageEvent(chatId, 'message.created', placeholder);
  return placeholder;
};

const launchAssistantGeneration = ({ chat, assistantMessage, sourceMessage, onDelta = null }) => {
  if (process.env.NODE_ENV === 'test' && !onDelta) {
    return;
  }

  setImmediate(() => {
    processAssistantGenerationJob({
      chatId: String(chat._id),
      assistantMessageId: String(assistantMessage._id),
      generatedFromMessageId: String(sourceMessage._id),
      sourceMessageVersion: Number(sourceMessage.version || 1),
      onDelta,
    }).catch((error) => {
      console.error('Assistant inline generation failed:', error);
    });
  });
};

const startPreparedAssistantGeneration = ({ chat, assistantMessage, sourceMessage, onDelta = null }) => {
  launchAssistantGeneration({ chat, assistantMessage, sourceMessage, onDelta });
};

const supersedeMessages = async (messages = [], replacementMessageId = null) => {
  if (!messages.length) return;

  const now = new Date();
  await AssistantMessage.updateMany(
    { _id: { $in: messages.map((message) => message._id) } },
    {
      $set: {
        status: 'superseded',
        hiddenAt: now,
        supersededByMessageId: replacementMessageId || null,
      },
    },
  );
};

const supersedeLaterMessagesFrom = async (
  chatId,
  anchorMessageId,
  replacementMessageId = null,
  visibleMessagesOverride = null,
) => {
  const visibleMessages = visibleMessagesOverride || await getVisibleMessages(chatId);
  const anchorIndex = visibleMessages.findIndex((message) => String(message._id) === String(anchorMessageId));

  if (anchorIndex === -1) {
    throw new Error('Assistant message is no longer active');
  }

  const laterMessages = visibleMessages.slice(anchorIndex + 1);
  await supersedeMessages(laterMessages, replacementMessageId);

  return laterMessages;
};

const buildActivePromptMessages = async (chatId, upToMessageId = null) => {
  const messages = await getVisibleMessages(chatId);
  if (!upToMessageId) {
    return messages.filter((message) =>
      message.role === 'user'
      || (message.role === 'assistant' && message.status === 'completed'),
    );
  }

  const active = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.status !== 'completed') {
      if (String(message._id) === String(upToMessageId)) {
        break;
      }
      continue;
    }

    active.push(message);
    if (String(message._id) === String(upToMessageId)) {
      break;
    }
  }

  return active.filter((message) =>
    message.role === 'user'
    || (message.role === 'assistant' && message.status === 'completed'),
  );
};

const createChatWithFirstMessage = async (userId, content) => {
  const trimmed = String(content || '').trim();
  if (!trimmed) {
    throw new Error('Message is required');
  }

  const chat = await AssistantChat.create({
    userId,
    title: generateAssistantTitle(trimmed),
    titleSource: 'auto',
    status: 'generating',
    lastMessageAt: new Date(),
  });

  const userMessage = await AssistantMessage.create({
    chatId: chat._id,
    userId,
    role: 'user',
    content: trimmed,
    status: 'completed',
  });

  emitMessageEvent(chat._id, 'message.created', userMessage);

  const assistantPlaceholder = await createAssistantPlaceholder({
    chatId: chat._id,
    userId,
    sourceMessage: userMessage,
  });

  launchAssistantGeneration({
    chat,
    assistantMessage: assistantPlaceholder,
    sourceMessage: userMessage,
  });

  await refreshChatState(chat._id);

  return {
    chat: await AssistantChat.findById(chat._id),
    messages: await getVisibleMessages(chat._id),
  };
};

const sendMessageToChat = async (userId, chatId, content) => {
  const chat = await getOwnedChat(userId, chatId);
  if (!chat) {
    throw new Error('Assistant chat not found');
  }
  if (chat.archivedAt) {
    throw new Error('Archived chats cannot receive new messages');
  }

  const trimmed = String(content || '').trim();
  if (!trimmed) {
    throw new Error('Message is required');
  }

  const visibleMessages = await getVisibleMessages(chat._id);
  const parentMessage = visibleMessages[visibleMessages.length - 1] || null;

  const userMessage = await AssistantMessage.create({
    chatId: chat._id,
    userId,
    role: 'user',
    content: trimmed,
    status: 'completed',
    parentMessageId: parentMessage?._id || null,
  });

  emitMessageEvent(chat._id, 'message.created', userMessage);

  const assistantPlaceholder = await createAssistantPlaceholder({
    chatId: chat._id,
    userId,
    sourceMessage: userMessage,
    parentMessageId: userMessage._id,
  });

  launchAssistantGeneration({
    chat,
    assistantMessage: assistantPlaceholder,
    sourceMessage: userMessage,
  });

  await refreshChatState(chat._id);
  return {
    userMessage,
    assistantMessage: assistantPlaceholder,
  };
};

const createAssistantChatShell = async (userId, seedContent = '') => {
  const trimmed = String(seedContent || '').trim();
  const chat = await AssistantChat.create({
    userId,
    title: generateAssistantTitle(trimmed || 'New chat'),
    titleSource: 'auto',
    status: 'idle',
    lastMessageAt: new Date(),
  });

  await refreshChatState(chat._id);
  return chat;
};

const commitStreamedAssistantInput = async ({
  userId,
  chatId = null,
  content,
  onDelta = null,
  startGeneration = true,
}) => {
  const trimmed = String(content || '').trim();
  if (!trimmed) {
    throw new Error('Message is required');
  }

  let chat = null;
  if (chatId) {
    chat = await getOwnedChat(userId, chatId);
    if (!chat) {
      throw new Error('Assistant chat not found');
    }
    if (chat.archivedAt) {
      throw new Error('Archived chats cannot receive new messages');
    }
  } else {
    chat = await createAssistantChatShell(userId, trimmed);
  }

  if (chat.titleSource === 'auto') {
    const existingUserMessages = await AssistantMessage.countDocuments({
      chatId: chat._id,
      userId,
      role: 'user',
      hiddenAt: null,
    });
    if (existingUserMessages === 0) {
      chat.title = generateAssistantTitle(trimmed);
      await chat.save();
    }
  }

  const visibleMessages = await getVisibleMessages(chat._id);
  const parentMessage = visibleMessages[visibleMessages.length - 1] || null;

  const userMessage = await AssistantMessage.create({
    chatId: chat._id,
    userId,
    role: 'user',
    content: trimmed,
    status: 'completed',
    parentMessageId: parentMessage?._id || null,
  });

  emitMessageEvent(chat._id, 'message.created', userMessage);

  const assistantPlaceholder = await createAssistantPlaceholder({
    chatId: chat._id,
    userId,
    sourceMessage: userMessage,
    parentMessageId: userMessage._id,
  });

  if (startGeneration) {
    launchAssistantGeneration({
      chat,
      assistantMessage: assistantPlaceholder,
      sourceMessage: userMessage,
      onDelta,
    });
  }

  await refreshChatState(chat._id);

  return {
    chat,
    userMessage,
    assistantMessage: assistantPlaceholder,
  };
};

const editUserMessage = async (userId, chatId, messageId, content) => {
  const chat = await getOwnedChat(userId, chatId);
  if (!chat) {
    throw new Error('Assistant chat not found');
  }

  const message = await getOwnedMessage(userId, chatId, messageId);
  if (!message) {
    throw new Error('Assistant message not found');
  }
  if (message.role !== 'user') {
    throw new Error('Only user messages can be edited');
  }

  const trimmed = String(content || '').trim();
  if (!trimmed) {
    throw new Error('Message is required');
  }

  const visibleMessages = await getVisibleMessages(chatId);

  message.previousVersions.push({
    content: message.content,
    version: Number(message.version || 1),
    editedAt: new Date(),
  });
  message.content = trimmed;
  message.isEdited = true;
  message.editedAt = new Date();
  message.version = Number(message.version || 1) + 1;
  await message.save();
  emitMessageEvent(chatId, 'message.updated', message);

  const assistantPlaceholder = await createAssistantPlaceholder({
    chatId,
    userId,
    sourceMessage: message,
    parentMessageId: message._id,
  });

  const laterMessages = await supersedeLaterMessagesFrom(chatId, message._id, assistantPlaceholder._id);
  for (const superseded of laterMessages) {
    const updated = await AssistantMessage.findById(superseded._id);
    if (updated) {
      emitMessageEvent(chatId, 'message.updated', updated);
    }
  }

  if (chat.titleSource === 'auto') {
    const firstUserMessage = visibleMessages.find((entry) => entry.role === 'user');
    if (firstUserMessage && String(firstUserMessage._id) === String(message._id)) {
      chat.title = generateAssistantTitle(trimmed);
      await chat.save();
    }
  }

  launchAssistantGeneration({
    chat,
    assistantMessage: assistantPlaceholder,
    sourceMessage: message,
  });

  await refreshChatState(chatId);
  return {
    editedMessage: message,
    assistantMessage: assistantPlaceholder,
  };
};

const regenerateAssistantMessage = async (userId, chatId, messageId) => {
  const chat = await getOwnedChat(userId, chatId);
  if (!chat) throw new Error('Assistant chat not found');

  const message = await getOwnedMessage(userId, chatId, messageId);
  if (!message) throw new Error('Assistant message not found');
  if (message.role !== 'assistant') {
    throw new Error('Only assistant messages can be regenerated');
  }
  if (!['completed', 'failed', 'superseded', 'cancelled'].includes(message.status)) {
    throw new Error('This assistant message cannot be regenerated right now');
  }

  const sourceMessage = message.generatedFromMessageId
    ? await AssistantMessage.findOne({ _id: message.generatedFromMessageId, chatId, userId })
    : null;

  if (!sourceMessage || sourceMessage.role !== 'user') {
    throw new Error('Source user message not found for regeneration');
  }

  const visibleMessages = await getVisibleMessages(chatId);
  const anchorIndex = visibleMessages.findIndex((entry) => String(entry._id) === String(message._id));
  if (anchorIndex === -1) {
    throw new Error('Assistant message is no longer active');
  }
  const laterMessages = visibleMessages.slice(anchorIndex + 1);

  message.status = 'superseded';
  message.hiddenAt = new Date();
  await message.save();
  emitMessageEvent(chatId, 'message.updated', message);

  const replacement = await createAssistantPlaceholder({
    chatId,
    userId,
    sourceMessage,
    parentMessageId: sourceMessage._id,
    supersedesMessageId: message._id,
  });

  await supersedeMessages(laterMessages, replacement._id);
  for (const superseded of laterMessages) {
    const updated = await AssistantMessage.findById(superseded._id);
    if (updated) {
      emitMessageEvent(chatId, 'message.updated', updated);
    }
  }

  launchAssistantGeneration({
    chat,
    assistantMessage: replacement,
    sourceMessage,
  });

  await refreshChatState(chatId);
  return {
    assistantMessage: replacement,
  };
};

const retryFailedAssistantMessage = async (userId, chatId, messageId) => {
  const message = await getOwnedMessage(userId, chatId, messageId);
  if (!message) throw new Error('Assistant message not found');
  if (message.role !== 'assistant') throw new Error('Only assistant messages can be retried');
  if (message.status !== 'failed') throw new Error('Only failed assistant messages can be retried');
  return regenerateAssistantMessage(userId, chatId, messageId);
};

const cancelAssistantMessage = async (userId, chatId, messageId) => {
  const chat = await getOwnedChat(userId, chatId);
  if (!chat) throw new Error('Assistant chat not found');

  const message = await getOwnedMessage(userId, chatId, messageId);
  if (!message) throw new Error('Assistant message not found');
  if (message.role !== 'assistant') throw new Error('Only assistant messages can be cancelled');
  if (!ACTIVE_GENERATION_STATUSES.has(message.status)) {
    throw new Error('Only queued or generating assistant messages can be cancelled');
  }

  message.status = 'cancelled';
  message.errorMessage = null;
  message.completedAt = new Date();
  await message.save();
  emitMessageEvent(chatId, 'message.updated', message);
  await refreshChatState(chatId);
  return message;
};

const renameOrArchiveChat = async (userId, chatId, input = {}) => {
  const chat = await getOwnedChat(userId, chatId);
  if (!chat) throw new Error('Assistant chat not found');

  if (input.title !== undefined) {
    const title = String(input.title || '').trim();
    if (!title) {
      throw new Error('Chat title is required');
    }
    chat.title = title.slice(0, 120);
    chat.titleSource = 'manual';
  }

  if (input.archived !== undefined) {
    if (input.archived) {
      chat.archivedAt = new Date();
      chat.status = 'archived';
    } else {
      chat.archivedAt = null;
    }
  }

  await chat.save();
  await refreshChatState(chatId);
  return chat;
};

const archiveChat = async (userId, chatId) => {
  return renameOrArchiveChat(userId, chatId, { archived: true });
};

const listAssistantChats = async (userId, query = {}) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 50);
  const includeArchived = query.includeArchived === 'true';
  const status = query.status ? String(query.status) : null;

  const filters = {
    userId,
    deletedAt: null,
    ...(includeArchived ? {} : { archivedAt: null }),
    ...(status ? { status } : {}),
  };

  const [chats, total] = await Promise.all([
    AssistantChat.find(filters)
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    AssistantChat.countDocuments(filters),
  ]);

  const chatIds = chats.map((chat) => chat._id);
  const lastByChat = await getLatestVisibleMessagesByChat(chatIds);

  return {
    chats: chats.map((chat) => formatAssistantChat(chat, lastByChat.get(String(chat._id)) || null)),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit) || 1,
      hasMore: page * limit < total,
    },
  };
};

const getAssistantChatDetail = async (userId, chatId) => {
  const chat = await getOwnedChat(userId, chatId);
  if (!chat) throw new Error('Assistant chat not found');

  const messages = await getVisibleMessages(chatId);
  const lastMessage = messages[messages.length - 1] || null;

  return {
    chat: formatAssistantChat(chat, lastMessage),
    messages: messages.map(formatAssistantMessage),
  };
};

const buildSnippet = (content = '', query = '') => {
  const safeContent = String(content || '').replace(/\s+/g, ' ').trim();
  const normalizedContent = safeContent.toLowerCase();
  const normalizedQuery = String(query || '').toLowerCase().trim();
  const index = normalizedContent.indexOf(normalizedQuery);

  if (index === -1) {
    return toPreview(safeContent, 100);
  }

  const start = Math.max(index - 28, 0);
  const end = Math.min(index + normalizedQuery.length + 48, safeContent.length);
  const snippet = safeContent.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${snippet}${end < safeContent.length ? '…' : ''}`;
};

const searchAssistantChats = async (userId, q) => {
  const query = String(q || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!query) {
    return { chats: [] };
  }

  const regex = new RegExp(escapeRegex(query), 'i');

  const [titleMatches, messageMatches] = await Promise.all([
    AssistantChat.find({
      userId,
      deletedAt: null,
      title: { $regex: regex },
    }).sort({ lastMessageAt: -1 }).limit(30),
    AssistantMessage.aggregate([
      {
        $match: {
          userId,
          content: { $regex: regex },
          ...visibleMessageQuery,
        },
      },
      {
        $sort: {
          createdAt: -1,
          _id: -1,
        },
      },
      {
        $group: {
          _id: '$chatId',
          matchedAt: { $first: '$createdAt' },
          matchedContent: { $first: '$content' },
        },
      },
      {
        $sort: {
          matchedAt: -1,
          _id: -1,
        },
      },
      {
        $limit: 50,
      },
    ]),
  ]);

  const chatIds = new Set(titleMatches.map((chat) => String(chat._id)));
  messageMatches.forEach((message) => chatIds.add(String(message._id)));

  const chats = await AssistantChat.find({
    _id: { $in: Array.from(chatIds) },
    userId,
    deletedAt: null,
  });

  const lastByChat = await getLatestVisibleMessagesByChat(chats.map((chat) => chat._id));
  const matchByChat = new Map(messageMatches.map((match) => [
    String(match._id),
    match,
  ]));

  return {
    chats: chats
      .sort((left, right) => {
        const leftMatchAt = matchByChat.get(String(left._id))?.matchedAt;
        const rightMatchAt = matchByChat.get(String(right._id))?.matchedAt;
        const leftRank = new Date(leftMatchAt || left.lastMessageAt || left.updatedAt).getTime();
        const rightRank = new Date(rightMatchAt || right.lastMessageAt || right.updatedAt).getTime();
        return rightRank - leftRank;
      })
      .map((chat) =>
        formatAssistantChat(
          chat,
          lastByChat.get(String(chat._id)) || null,
          matchByChat.get(String(chat._id))?.matchedContent
            ? buildSnippet(matchByChat.get(String(chat._id)).matchedContent, query)
            : regex.test(chat.title)
              ? buildSnippet(chat.title, query)
              : null,
        ))
      ,
  };
};

const processAssistantGenerationJob = async ({
  chatId,
  assistantMessageId,
  generatedFromMessageId,
  sourceMessageVersion,
  onDelta = null,
}) => {
  const [chat, assistantMessage, sourceMessage] = await Promise.all([
    AssistantChat.findById(chatId),
    AssistantMessage.findById(assistantMessageId),
    AssistantMessage.findById(generatedFromMessageId),
  ]);

  if (!chat || !assistantMessage || !sourceMessage) {
    return { success: false, skipped: true };
  }

  if (assistantMessage.status === 'cancelled' || assistantMessage.status === 'superseded' || assistantMessage.hiddenAt) {
    return { success: false, skipped: true };
  }

  if (Number(sourceMessage.version || 1) !== Number(sourceMessageVersion || 1)) {
    assistantMessage.status = 'superseded';
    assistantMessage.hiddenAt = new Date();
    await assistantMessage.save();
    emitMessageEvent(chatId, 'message.updated', assistantMessage);
    await refreshChatState(chatId);
    return { success: false, skipped: true };
  }

  assistantMessage.status = 'generating';
  assistantMessage.errorMessage = null;
  assistantMessage.content = '';
  assistantMessage.sources = [];
  assistantMessage.retrieval = null;
  await assistantMessage.save();
  emitMessageEvent(chatId, 'message.updated', assistantMessage);
  await refreshChatState(chatId);

  try {
    const emitActivity = async (stage, label) => {
      const event = buildActivityEvent({
        chatId,
        assistantMessageId: assistantMessage._id,
        stage,
        label,
      });
      publishAssistantChatEvent(chatId, event);
      if (onDelta) {
        await onDelta(event);
      }
    };

    const history = await buildActivePromptMessages(chatId, generatedFromMessageId);
    const latestQuestion = sourceMessage.content || '';
    await emitActivity('understanding_request', 'Understanding your request...');
    const actionPlan = await planAssistantAction({
      userId: chat.userId,
      chatId,
      assistantMessageId,
      text: latestQuestion,
      history,
    });

    if (actionPlan) {
      if (actionPlan.kind === 'confirmation_required') {
        await emitActivity('preparing_confirmation', 'Preparing your confirmation...');
      } else if (actionPlan.kind === 'missing_fields') {
        await emitActivity('checking_details', 'Checking what details are still needed...');
      } else if (actionPlan.kind === 'action_completed') {
        await emitActivity('saving_record', 'Saving it to your SEFA records...');
      }

      assistantMessage.content = actionPlan.text || '';
      assistantMessage.status = 'completed';
      assistantMessage.completedAt = new Date();
      assistantMessage.errorMessage = null;
      assistantMessage.sources = [];
      assistantMessage.retrieval = null;
      await assistantMessage.save();

      if (actionPlan.action) {
        await attachActionToMessage(assistantMessage._id, actionPlan.action);
        const refreshed = await AssistantMessage.findById(assistantMessage._id);
        if (refreshed) {
          assistantMessage.actions = refreshed.actions || [];
        }

        if (actionPlan.kind === 'confirmation_required') {
          publishAssistantChatEvent(chatId, {
            type: 'confirmation.required',
            action: formatAssistantActions([actionPlan.action])[0],
            message: formatAssistantMessage(assistantMessage),
          });
        } else if (actionPlan.kind === 'missing_fields') {
          publishAssistantChatEvent(chatId, {
            type: 'missing_fields.required',
            intent: actionPlan.intent,
            missingFields: actionPlan.missingFields || [],
            payload: actionPlan.payload || {},
            message: formatAssistantMessage(assistantMessage),
          });
        } else if (actionPlan.kind === 'action_completed') {
          publishAssistantChatEvent(chatId, {
            type: 'action.completed',
            action: formatAssistantActions([actionPlan.action])[0],
            actionId: String(actionPlan.action._id),
            actionType: actionPlan.action.actionType,
            status: actionPlan.action.status,
            result: actionPlan.action.result || null,
            message: formatAssistantMessage(assistantMessage),
          });
        } else if (actionPlan.kind === 'action_cancelled') {
          publishAssistantChatEvent(chatId, {
            type: 'action.cancelled',
            action: formatAssistantActions([actionPlan.action])[0],
            actionId: String(actionPlan.action._id),
            actionType: actionPlan.action.actionType,
            status: actionPlan.action.status,
            message: formatAssistantMessage(assistantMessage),
          });
        }
      } else if (actionPlan.kind === 'missing_fields') {
        publishAssistantChatEvent(chatId, {
          type: 'missing_fields.required',
          intent: actionPlan.intent,
          missingFields: actionPlan.missingFields || [],
          payload: actionPlan.payload || {},
          message: formatAssistantMessage(assistantMessage),
        });
      } else if (actionPlan.intent) {
        publishAssistantChatEvent(chatId, {
          type: 'intent.detected',
          intent: actionPlan.intent,
        });
      }

      emitMessageEvent(chatId, 'message.updated', assistantMessage);
      await refreshChatState(chatId);
      if (onDelta) {
        await onDelta({
          chatId: String(chatId),
          assistantMessageId: String(assistantMessage._id),
          delta: actionPlan.text || '',
          fullText: actionPlan.text || '',
          isFinal: true,
          status: 'completed',
          actions: formatAssistantActions(assistantMessage.actions || []),
        });
      }
      return {
        success: true,
        assistantMessageId: String(assistantMessage._id),
      };
    }

    let lastPersistedAt = Date.now();
    let lastPersistedLength = 0;
    let lastCancellationCheckAt = Date.now();

    const generationResult = await streamAssistantCompletion({
      userId: chat.userId,
      chatTitle: chat.title,
      history,
      onActivity: emitActivity,
      onChunk: async ({ delta, fullText, isFinal }) => {
        const now = Date.now();
        if (isFinal || now - lastCancellationCheckAt >= 500) {
          const current = await AssistantMessage.findById(assistantMessageId).select('status hiddenAt').lean();
          lastCancellationCheckAt = now;
          if (!current || current.status === 'cancelled' || current.status === 'superseded' || current.hiddenAt) {
            throw new Error('ASSISTANT_STREAM_ABORTED');
          }
        }

        const shouldPersist = !isFinal && (
          now - lastPersistedAt >= 500
          || fullText.length - lastPersistedLength >= 160
        );

        if (shouldPersist) {
          assistantMessage.content = fullText;
          assistantMessage.status = isFinal ? 'completed' : 'streaming';
          if (isFinal) {
            assistantMessage.completedAt = new Date();
          }
          await assistantMessage.save();
          lastPersistedAt = now;
          lastPersistedLength = fullText.length;
          emitMessageEvent(chatId, 'message.updated', assistantMessage);
        }

        if (delta) {
          publishAssistantChatEvent(chatId, {
            type: 'assistant.delta',
            chatId: String(chatId),
            assistantMessageId: String(assistantMessage._id),
            delta,
            fullText,
            isFinal: false,
            status: 'streaming',
          });
        }

        if (onDelta && delta) {
          await onDelta({
            chatId: String(chatId),
            assistantMessageId: String(assistantMessage._id),
            delta,
            fullText,
            isFinal: false,
            status: 'streaming',
          });
        }
      },
    });

    const finalContent = generationResult?.text || '';
    assistantMessage.content = finalContent;
    assistantMessage.sources = generationResult?.sources || [];
    assistantMessage.retrieval = generationResult?.retrieval || null;
    assistantMessage.status = 'completed';
    assistantMessage.completedAt = new Date();
    assistantMessage.errorMessage = null;
    await assistantMessage.save();

    if (chat.titleSource === 'auto') {
      const visibleMessages = await getVisibleMessages(chatId);
      const nextTitle = await generateAssistantConversationTitle({
        messages: visibleMessages,
      });

      if (nextTitle && nextTitle !== chat.title) {
        chat.title = nextTitle;
        await chat.save();
      }
    }

    emitMessageEvent(chatId, 'message.updated', assistantMessage);
    await refreshChatState(chatId);
    if (onDelta) {
      await emitActivity('done', 'Done.');
      await onDelta({
        chatId: String(chatId),
        assistantMessageId: String(assistantMessage._id),
        delta: '',
        fullText: finalContent,
        isFinal: true,
        status: 'completed',
        sources: formatAssistantSources(assistantMessage.sources || []),
        retrieval: formatAssistantRetrieval(assistantMessage.retrieval || null),
      });
    }
    return {
      success: true,
      assistantMessageId: String(assistantMessage._id),
    };
  } catch (error) {
    if (error.message === 'ASSISTANT_STREAM_ABORTED') {
      return { success: false, skipped: true };
    }

    console.error('Assistant generation failed', {
      chatId: String(chatId),
      assistantMessageId: String(assistantMessageId),
      message: error?.message,
      status: error?.status || error?.statusCode,
      code: error?.code,
      stack: error?.stack,
    });

    const current = await AssistantMessage.findById(assistantMessageId);
    if (!current || current.status === 'cancelled' || current.status === 'superseded' || current.hiddenAt) {
      return { success: false, skipped: true };
    }

    current.status = 'failed';
    current.errorMessage = 'SEFA could not complete this response.';
    current.completedAt = new Date();
    await current.save();
    emitMessageEvent(chatId, 'message.updated', current);
    await refreshChatState(chatId);
    return {
      success: false,
      assistantMessageId: String(current._id),
      error: error.message,
    };
  }
};

module.exports = {
  ACTIVE_GENERATION_STATUSES,
  TERMINAL_MESSAGE_STATUSES,
  archiveChat,
  buildActivePromptMessages,
  cancelAssistantMessage,
  commitStreamedAssistantInput,
  createAssistantChatShell,
  createChatWithFirstMessage,
  editUserMessage,
  formatAssistantChat,
  formatAssistantMessage,
  getAssistantChatDetail,
  getOwnedChat,
  listAssistantChats,
  processAssistantGenerationJob,
  refreshChatState,
  regenerateAssistantMessage,
  renameOrArchiveChat,
  retryFailedAssistantMessage,
  searchAssistantChats,
  sendMessageToChat,
  startPreparedAssistantGeneration,
};
