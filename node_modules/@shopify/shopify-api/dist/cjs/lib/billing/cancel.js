'use strict';

var client = require('../clients/admin/graphql/client.js');
require('@shopify/admin-api-client');
require('lossless-json');
var error = require('../error.js');
require('../types.js');
require('compare-versions');
var types = require('./types.js');

const CANCEL_MUTATION = `
  ${types.APP_SUBSCRIPTION_FRAGMENT}
  mutation appSubscriptionCancel($id: ID!, $prorate: Boolean) {
    appSubscriptionCancel(id: $id, prorate: $prorate) {
      appSubscription {
        ...AppSubscriptionFragment
      }
      userErrors {
        field
        message
      }
    }
  }
`;
function cancel(config) {
    return async function (subscriptionInfo) {
        const { session, subscriptionId, prorate = true } = subscriptionInfo;
        const GraphqlClient = client.graphqlClientClass({ config });
        const client$1 = new GraphqlClient({ session });
        try {
            const response = await client$1.request(CANCEL_MUTATION, {
                variables: { id: subscriptionId, prorate },
            });
            if (response.data?.appSubscriptionCancel?.userErrors.length) {
                throw new error.BillingError({
                    message: 'Error while canceling a subscription',
                    errorData: response.data?.appSubscriptionCancel?.userErrors,
                });
            }
            return response.data?.appSubscriptionCancel?.appSubscription;
        }
        catch (error$1) {
            if (error$1 instanceof error.GraphqlQueryError) {
                throw new error.BillingError({
                    message: error$1.message,
                    errorData: error$1.response?.errors,
                });
            }
            else {
                throw error$1;
            }
        }
    };
}

exports.cancel = cancel;
//# sourceMappingURL=cancel.js.map
