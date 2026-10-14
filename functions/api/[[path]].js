import { handleChatRequest } from '../../server/chat/api.js';

export function onRequest(context) {
  return handleChatRequest(context.request, context.env, context);
}
