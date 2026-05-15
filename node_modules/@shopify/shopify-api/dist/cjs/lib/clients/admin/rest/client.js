'use strict';

var adminApiClient = require('@shopify/admin-api-client');
var LosslessJSON = require('lossless-json');
var common = require('../../common.js');
var error = require('../../../error.js');
var index = require('../../../logger/index.js');
var types = require('../../../types.js');
var utils = require('../../../../runtime/crypto/utils.js');
var types$1 = require('../../../../runtime/crypto/types.js');
var index$1 = require('../../../../runtime/http/index.js');
var headers = require('../../../../runtime/http/headers.js');

function _interopNamespaceDefault(e) {
    var n = Object.create(null);
    if (e) {
        Object.keys(e).forEach(function (k) {
            if (k !== 'default') {
                var d = Object.getOwnPropertyDescriptor(e, k);
                Object.defineProperty(n, k, d.get ? d : {
                    enumerable: true,
                    get: function () { return e[k]; }
                });
            }
        });
    }
    n.default = e;
    return Object.freeze(n);
}

var LosslessJSON__namespace = /*#__PURE__*/_interopNamespaceDefault(LosslessJSON);

class RestClient {
    static config;
    static formatPaths;
    static LINK_HEADER_REGEXP = /<([^<]+)>; rel="([^"]+)"/;
    static DEFAULT_LIMIT = '50';
    static RETRY_WAIT_TIME = 1000;
    static DEPRECATION_ALERT_DELAY = 300000;
    loggedDeprecations = {};
    client;
    session;
    apiVersion;
    constructor({ session, apiVersion }) {
        const config = this.restClass().config;
        if (!config.isCustomStoreApp && !session.accessToken) {
            throw new error.MissingRequiredArgument('Missing access token when creating REST client');
        }
        if (apiVersion) {
            const message = apiVersion === config.apiVersion
                ? `REST client has a redundant API version override to the default ${apiVersion}`
                : `REST client overriding default API version ${config.apiVersion} with ${apiVersion}`;
            index.logger(config).debug(message);
        }
        const customStoreAppAccessToken = config.adminApiAccessToken ?? config.apiSecretKey;
        this.session = session;
        this.apiVersion = apiVersion ?? config.apiVersion;
        this.client = adminApiClient.createAdminRestApiClient({
            scheme: config.hostScheme,
            storeDomain: session.shop,
            apiVersion: apiVersion ?? config.apiVersion,
            accessToken: config.isCustomStoreApp
                ? customStoreAppAccessToken
                : session.accessToken,
            customFetchApi: index$1.abstractFetch,
            logger: common.clientLoggerFactory(config),
            userAgentPrefix: common.getUserAgent(config),
            defaultRetryTime: this.restClass().RETRY_WAIT_TIME,
            formatPaths: this.restClass().formatPaths,
            isTesting: config.isTesting,
        });
    }
    /**
     * Performs a GET request on the given path.
     */
    async get(params) {
        return this.request({ method: types.Method.Get, ...params });
    }
    /**
     * Performs a POST request on the given path.
     */
    async post(params) {
        return this.request({ method: types.Method.Post, ...params });
    }
    /**
     * Performs a PUT request on the given path.
     */
    async put(params) {
        return this.request({ method: types.Method.Put, ...params });
    }
    /**
     * Performs a DELETE request on the given path.
     */
    async delete(params) {
        return this.request({ method: types.Method.Delete, ...params });
    }
    async request(params) {
        const requestParams = {
            headers: {
                ...params.extraHeaders,
                ...(params.type ? { 'Content-Type': params.type.toString() } : {}),
            },
            retries: params.tries ? params.tries - 1 : undefined,
            searchParams: params.query,
        };
        let response;
        switch (params.method) {
            case types.Method.Get:
                response = await this.client.get(params.path, requestParams);
                break;
            case types.Method.Put:
                response = await this.client.put(params.path, {
                    ...requestParams,
                    data: params.data,
                });
                break;
            case types.Method.Post:
                response = await this.client.post(params.path, {
                    ...requestParams,
                    data: params.data,
                });
                break;
            case types.Method.Delete:
                response = await this.client.delete(params.path, requestParams);
                break;
            default:
                throw new error.InvalidRequestError(`Unsupported request method '${params.method}'`);
        }
        const bodyString = await response.text();
        // Some DELETE requests return an empty body but are still valid responses, we want those to go through
        const body = params.method === types.Method.Delete && bodyString === ''
            ? {}
            : this.parseJsonWithLosslessNumbers(bodyString);
        const responseHeaders = headers.canonicalizeHeaders(Object.fromEntries(response.headers.entries()));
        if (!response.ok) {
            common.throwFailedRequest(body, (params.tries ?? 1) > 1, response);
        }
        const requestReturn = {
            body,
            headers: responseHeaders,
        };
        await this.logDeprecations({
            method: params.method,
            url: params.path,
            headers: requestParams.headers,
            body: params.data ? JSON.stringify(params.data) : undefined,
        }, requestReturn);
        const link = response.headers.get('Link');
        if (link !== undefined) {
            const pageInfo = {
                limit: params.query?.limit
                    ? params.query?.limit.toString()
                    : RestClient.DEFAULT_LIMIT,
            };
            if (link) {
                const links = link.split(', ');
                for (const link of links) {
                    const parsedLink = link.match(RestClient.LINK_HEADER_REGEXP);
                    if (!parsedLink) {
                        continue;
                    }
                    const linkRel = parsedLink[2];
                    const linkUrl = new URL(parsedLink[1]);
                    const linkFields = linkUrl.searchParams.get('fields');
                    const linkPageToken = linkUrl.searchParams.get('page_info');
                    if (!pageInfo.fields && linkFields) {
                        pageInfo.fields = linkFields.split(',');
                    }
                    if (linkPageToken) {
                        switch (linkRel) {
                            case 'previous':
                                pageInfo.previousPageUrl = parsedLink[1];
                                pageInfo.prevPage = this.buildRequestParams(parsedLink[1]);
                                break;
                            case 'next':
                                pageInfo.nextPageUrl = parsedLink[1];
                                pageInfo.nextPage = this.buildRequestParams(parsedLink[1]);
                                break;
                        }
                    }
                }
            }
            requestReturn.pageInfo = pageInfo;
        }
        return requestReturn;
    }
    restClass() {
        return this.constructor;
    }
    /**
     * Parse JSON with lossless-json to preserve numeric precision.
     * Converts all ID fields (ending with _id, _ids, or named 'id') to strings.
     */
    parseJsonWithLosslessNumbers(jsonString) {
        // Parse with lossless-json first to preserve precision
        const parsed = LosslessJSON__namespace.parse(jsonString);
        // Recursively process the parsed object to convert IDs to strings
        const processValue = (value, key) => {
            if (value === null || value === undefined) {
                return value;
            }
            // Handle LosslessNumber instances
            if (value && value.isLosslessNumber === true) {
                const keyLower = (key || '').toLowerCase();
                // Always convert ID fields to strings
                if (keyLower === 'id' || keyLower.endsWith('_id')) {
                    return value.toString();
                }
                // For non-ID fields, always convert to regular JavaScript number
                // The IDs have already been handled, so we can use standard conversion
                return Number(value.value);
            }
            // Handle arrays - special case for _ids arrays
            if (Array.isArray(value)) {
                const isIdsArray = key && key.toLowerCase().endsWith('_ids');
                return value.map((item) => {
                    // If this is an _ids array and item is a LosslessNumber, convert to string
                    if (isIdsArray && item && item.isLosslessNumber === true) {
                        return item.toString();
                    }
                    return processValue(item);
                });
            }
            // Handle objects
            if (typeof value === 'object') {
                const result = {};
                for (const objKey in value) {
                    if (Object.prototype.hasOwnProperty.call(value, objKey)) {
                        result[objKey] = processValue(value[objKey], objKey);
                    }
                }
                return result;
            }
            return value;
        };
        return processValue(parsed);
    }
    buildRequestParams(newPageUrl) {
        const pattern = `^/admin/api/[^/]+/(.*).json$`;
        const url = new URL(newPageUrl);
        const path = url.pathname.replace(new RegExp(pattern), '$1');
        return {
            path,
            query: Object.fromEntries(url.searchParams.entries()),
        };
    }
    async logDeprecations(request, response) {
        const config = this.restClass().config;
        const deprecationReason = headers.getHeader(response.headers, 'X-Shopify-API-Deprecated-Reason');
        if (deprecationReason) {
            const deprecation = {
                message: deprecationReason,
                path: request.url,
            };
            if (request.body) {
                // This can only be a string, since we're always converting the body before calling this method
                deprecation.body = `${request.body.substring(0, 100)}...`;
            }
            const depHash = await utils.createSHA256HMAC(config.apiSecretKey, JSON.stringify(deprecation), types$1.HashFormat.Hex);
            if (!Object.keys(this.loggedDeprecations).includes(depHash) ||
                Date.now() - this.loggedDeprecations[depHash] >=
                    RestClient.DEPRECATION_ALERT_DELAY) {
                this.loggedDeprecations[depHash] = Date.now();
                const stack = new Error().stack;
                const message = `API Deprecation Notice ${new Date().toLocaleString()} : ${JSON.stringify(deprecation)}  -  Stack Trace: ${stack}`;
                await index.logger(config).warning(message);
            }
        }
    }
}
function restClientClass(params) {
    const { config, formatPaths } = params;
    class NewRestClient extends RestClient {
        static config = config;
        static formatPaths = formatPaths === undefined ? true : formatPaths;
    }
    Reflect.defineProperty(NewRestClient, 'name', {
        value: 'RestClient',
    });
    return NewRestClient;
}

exports.RestClient = RestClient;
exports.restClientClass = restClientClass;
//# sourceMappingURL=client.js.map
