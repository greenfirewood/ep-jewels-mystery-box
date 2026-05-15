import { mockFetch, mockConvertRequest, mockConvertResponse, mockConvertHeaders, mockRuntimeString } from './adapter.mjs';
import { setAbstractFetchFunc, setAbstractConvertRequestFunc, setAbstractConvertResponseFunc, setAbstractConvertHeadersFunc } from '../../runtime/http/index.mjs';
import { setAbstractRuntimeString } from '../../runtime/platform/runtime-string.mjs';

setAbstractFetchFunc(mockFetch);
setAbstractConvertRequestFunc(mockConvertRequest);
setAbstractConvertResponseFunc(mockConvertResponse);
setAbstractConvertHeadersFunc(mockConvertHeaders);
setAbstractRuntimeString(mockRuntimeString);
//# sourceMappingURL=index.mjs.map
