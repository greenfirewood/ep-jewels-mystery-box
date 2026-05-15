'use strict';

var adapter = require('./adapter.js');
var index = require('../../runtime/http/index.js');
var runtimeString = require('../../runtime/platform/runtime-string.js');

index.setAbstractFetchFunc(adapter.mockFetch);
index.setAbstractConvertRequestFunc(adapter.mockConvertRequest);
index.setAbstractConvertResponseFunc(adapter.mockConvertResponse);
index.setAbstractConvertHeadersFunc(adapter.mockConvertHeaders);
runtimeString.setAbstractRuntimeString(adapter.mockRuntimeString);
//# sourceMappingURL=index.js.map
