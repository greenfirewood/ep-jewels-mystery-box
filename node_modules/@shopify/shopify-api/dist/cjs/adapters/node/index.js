'use strict';

var adapter = require('./adapter.js');
var index = require('../../runtime/http/index.js');
var runtimeString = require('../../runtime/platform/runtime-string.js');

// For the purposes of this package, fetch correctly implements everything we need
index.setAbstractFetchFunc(globalThis.fetch);
index.setAbstractConvertRequestFunc(adapter.nodeConvertRequest);
index.setAbstractConvertIncomingResponseFunc(adapter.nodeConvertIncomingResponse);
index.setAbstractConvertResponseFunc(adapter.nodeConvertAndSendResponse);
index.setAbstractConvertHeadersFunc(adapter.nodeConvertAndSetHeaders);
runtimeString.setAbstractRuntimeString(adapter.nodeRuntimeString);
// Export a marker to prevent tree-shaking
const nodeAdapterInitialized = true;

exports.nodeAdapterInitialized = nodeAdapterInitialized;
//# sourceMappingURL=index.js.map
