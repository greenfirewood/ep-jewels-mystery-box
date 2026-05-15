import { createAdminRestApiClient } from '@shopify/admin-api-client';
import * as LosslessJSON from 'lossless-json';
import { getUserAgent, clientLoggerFactory, throwFailedRequest } from '../../common.mjs';
import { MissingRequiredArgument, InvalidRequestError } from '../../../error.mjs';
import { logger } from '../../../logger/index.mjs';
import { Method } from '../../../types.mjs';
import { createSHA256HMAC } from '../../../../runtime/crypto/utils.mjs';
import { HashFormat } from '../../../../runtime/crypto/types.mjs';
import { abstractFetch } from '../../../../runtime/http/index.mjs';
import { canonicalizeHeaders, getHeader } from '../../../../runtime/http/headers.mjs';

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
            throw new MissingRequiredArgument('Missing access token when creating REST client');
        }
        if (apiVersion) {
            const message = apiVersion === config.apiVersion
                ? `REST client has a redundant API version override to the default ${apiVersion}`
                : `REST client overriding default API version ${config.apiVersion} with ${apiVersion}`;
            logger(config).debug(message);
        }
        const customStoreAppAccessToken = config.adminApiAccessToken ?? config.apiSecretKey;
        this.session = session;
        this.apiVersion = apiVersion ?? config.apiVersion;
        this.client = createAdminRestApiClient({
            scheme: config.hostScheme,
            storeDomain: session.shop,
            apiVersion: apiVersion ?? config.apiVersion,
            accessToken: config.isCustomStoreApp
                ? customStoreAppAccessToken
                : session.accessToken,
            customFetchApi: abstractFetch,
            logger: clientLoggerFactory(config),
            userAgentPrefix: getUserAgent(config),
            defaultRetryTime: this.restClass().RETRY_WAIT_TIME,
            formatPaths: this.restClass().formatPaths,
            isTesting: config.isTesting,
        });
    }
    /**
     * Performs a GET request on the given path.
     */
    async get(params) {
        return this.request({ method: Method.Get, ...params });
    }
    /**
     * Performs a POST request on the given path.
     */
    async post(params) {
        return this.request({ method: Method.Post, ...params });
    }
    /**
     * Performs a PUT request on the given path.
     */
    async put(params) {
        return this.request({ method: Method.Put, ...params });
    }
    /**
     * Performs a DELETE request on the given path.
     */
    async delete(params) {
        return this.request({ method: Method.Delete, ...params });
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
            case Method.Get:
                response = await this.client.get(params.path, requestParams);
                break;
            case Method.Put:
                response = await this.client.put(params.path, {
                    ...requestParams,
                    data: params.data,
                });
                break;
            case Method.Post:
                response = await this.client.post(params.path, {
                    ...requestParams,
                    data: params.data,
                });
                break;
            case Method.Delete:
                response = await this.client.delete(params.path, requestParams);
                break;
            default:
                throw new InvalidRequestError(`Unsupported request method '${params.method}'`);
        }
        const bodyString = await response.text();
        // Some DELETE requests return an empty body but are still valid responses, we want those to go through
        const body = params.method === Method.Delete && bodyString === ''
            ? {}
            : this.parseJsonWithLosslessNumbers(bodyString);
        const responseHeaders = canonicalizeHeaders(Object.fromEntries(response.headers.entries()));
        if (!response.ok) {
            throwFailedRequest(body, (params.tries ?? 1) > 1, response);
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
        const parsed = LosslessJSON.parse(jsonString);
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
        const deprecationReason = getHeader(response.headers, 'X-Shopify-API-Deprecated-Reason');
        if (deprecationReason) {
            const deprecation = {
                message: deprecationReason,
                path: request.url,
            };
            if (request.body) {
                // This can only be a string, since we're always converting the body before calling this method
                deprecation.body = `${request.body.substring(0, 100)}...`;
            }
            const depHash = await createSHA256HMAC(config.apiSecretKey, JSON.stringify(deprecation), HashFormat.Hex);
            if (!Object.keys(this.loggedDeprecations).includes(depHash) ||
                Date.now() - this.loggedDeprecations[depHash] >=
                    RestClient.DEPRECATION_ALERT_DELAY) {
                this.loggedDeprecations[depHash] = Date.now();
                const stack = new Error().stack;
                const message = `API Deprecation Notice ${new Date().toLocaleString()} : ${JSON.stringify(deprecation)}  -  Stack Trace: ${stack}`;
                await logger(config).warning(message);
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

export { RestClient, restClientClass };
//# sourceMappingURL=client.mjs.map
