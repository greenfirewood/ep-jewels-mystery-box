'use strict';

var common = require('../../clients/common.js');
var types = require('../../clients/types.js');
var fetchRequest = require('../../utils/fetch-request.js');
var shopValidator = require('../../utils/shop-validator.js');
var createSession = require('./create-session.js');

const ClientCredentialsGrantType = 'client_credentials';
function clientCredentials(config) {
    return async ({ shop }) => {
        const cleanShop = shopValidator.sanitizeShop(config)(shop, true);
        const requestConfig = {
            method: 'POST',
            body: JSON.stringify({
                client_id: config.apiKey,
                client_secret: config.apiSecretKey,
                grant_type: ClientCredentialsGrantType,
            }),
            headers: {
                'Content-Type': types.DataType.JSON,
                Accept: types.DataType.JSON,
            },
        };
        const postResponse = await fetchRequest.fetchRequestFactory(config)(`https://${cleanShop}/admin/oauth/access_token`, requestConfig);
        const responseData = (await postResponse.json());
        if (!postResponse.ok) {
            common.throwFailedRequest(responseData, false, postResponse);
        }
        return {
            session: createSession.createSession({
                accessTokenResponse: responseData,
                shop: cleanShop,
                // We need to keep this as an empty string as our template DB schemas have this required
                state: '',
                config,
            }),
        };
    };
}

exports.clientCredentials = clientCredentials;
//# sourceMappingURL=client-credentials.js.map
