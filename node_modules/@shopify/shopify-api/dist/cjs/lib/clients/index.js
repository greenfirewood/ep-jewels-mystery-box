'use strict';

var client$1 = require('./admin/graphql/client.js');
var client$2 = require('./admin/rest/client.js');
var client = require('./storefront/client.js');
var graphql_proxy = require('./graphql_proxy/graphql_proxy.js');

function clientClasses(config) {
    return {
        // We don't pass in the HttpClient because the RestClient inherits from it, and goes through the same setup process
        Rest: client$2.restClientClass({ config }),
        Graphql: client$1.graphqlClientClass({ config }),
        Storefront: client.storefrontClientClass({ config }),
        graphqlProxy: graphql_proxy.graphqlProxy(config),
    };
}

exports.clientClasses = clientClasses;
//# sourceMappingURL=index.js.map
