// The `sessionLink` descriptor: the current session's own id and console link, a leaf so the tool list imports no store code.
import { obj, type ToolDescriptor } from '../tool-schema/descriptor.js'

export const SESSION_LINK_TOOL: ToolDescriptor = {
  name: 'sessionLink',
  description:
    'The id and console link of THIS session, the one you are answering in. Use it to hand people a link that ' +
    'opens or continues this conversation elsewhere, such as the console session page or an app that takes a ' +
    'session id in its URL. It takes no arguments and never names another session.',
  inputSchema: obj({})
}
