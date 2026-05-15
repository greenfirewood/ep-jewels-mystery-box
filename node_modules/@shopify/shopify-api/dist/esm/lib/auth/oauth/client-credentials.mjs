import { throwFailedRequest } from '../../clients/common.mjs';
import { DataType } from '../../clients/types.mjs';
import { fetchRequestFactory } from '../../utils/fetch-request.mjs';
import { sanitizeShop } from '../../utils/shop-validator.mjs';
import { createSession } from './create-session.mjs';

const ClientCredentialsGrantType = 'client_credentials';
function clientCredentials(config) {
    return async ({ shop }) => {
        const cleanShop = sanitizeShop(config)(shop, true);
        const requestConfig = {
            method: 'POST',
            body: JSON.stringify({
                client_id: config.apiKey,
                client_secret: config.apiSecretKey,
                grant_type: ClientCredentialsGrantType,
            }),
            headers: {
                'Content-Type': DataType.JSON,
                Accept: DataType.JSON,
            },
        };
        const postResponse = await fetchRequestFactory(config)(`https://${cleanShop}/admin/oauth/access_token`, requestConfig);
        const responseData = (await postResponse.json());
        if (!postResponse.ok) {
            throwFailedRequest(responseData, false, postResponse);
        }
        return {
            session: createSession({
                accessTokenResponse: responseData,
                shop: cleanShop,
                // We need to keep this as an empty string as our template DB schemas have this required
                state: '',
                config,
            }),
        };
    };
}

export { clientCredentials };
//# sourceMappingURL=client-credentials.mjs.map
