import { nodeConvertRequest, nodeConvertIncomingResponse, nodeConvertAndSendResponse, nodeConvertAndSetHeaders, nodeRuntimeString } from './adapter.mjs';
import { setAbstractFetchFunc, setAbstractConvertRequestFunc, setAbstractConvertIncomingResponseFunc, setAbstractConvertResponseFunc, setAbstractConvertHeadersFunc } from '../../runtime/http/index.mjs';
import { setAbstractRuntimeString } from '../../runtime/platform/runtime-string.mjs';

// For the purposes of this package, fetch correctly implements everything we need
setAbstractFetchFunc(globalThis.fetch);
setAbstractConvertRequestFunc(nodeConvertRequest);
setAbstractConvertIncomingResponseFunc(nodeConvertIncomingResponse);
setAbstractConvertResponseFunc(nodeConvertAndSendResponse);
setAbstractConvertHeadersFunc(nodeConvertAndSetHeaders);
setAbstractRuntimeString(nodeRuntimeString);
// Export a marker to prevent tree-shaking
const nodeAdapterInitialized = true;

export { nodeAdapterInitialized };
//# sourceMappingURL=index.mjs.map
